import { and, eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { invitations, oauthStates, userIdentities, users, type User } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto.ts";
import { log } from "../lib/log.ts";
import { appOrigin, requireSameOrigin } from "../auth/middleware.ts";
import {
  buildAuthUrl,
  callbackPath,
  configured,
  configuredMap,
  credentials,
  exchange,
  isProvider,
  pkcePair,
  PROVIDERS,
  type ExternalIdentity,
  type Provider,
} from "../auth/providers.ts";
import { auditInsert } from "../services/audit.ts";
import { clearSessionCookie, createSession, loadSession, revokeSession, setSessionCookie } from "../auth/session.ts";
import {
  applyPasswordReset,
  attemptKey,
  checkPassword,
  clearAttempts,
  consumeChallenge,
  createChallenge,
  loadChallenge,
  makePasswordHash,
  MFA_CHALLENGE_TTL_MS,
  reserveAttempt,
  resetInfo,
  tooMany,
  validatePassword,
  verifySecondFactor,
} from "../services/authn.ts";
import { acceptInvitation, activeInvitation } from "../services/invitations.ts";
import { liftExpiredBan, normalizeEmail, resolveLogin } from "../services/members.ts";
import { getSettings, mfaRequired, providerEnabled } from "../services/settings.ts";
import { jsonBody } from "./util.ts";

const STATE_TTL_MS = 10 * 60_000;
const OAUTH_COOKIE = "fn_oauth";
const MFA_COOKIE = "fn_mfa";

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.length > 512) return "/";
  if (/[\u0000-\u001f]/.test(v)) return "/";
  if (v.startsWith("/auth/") || v.startsWith("/api/")) return "/";
  return v;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
});

const settingsOf = (c: Context<AppEnv>) => getSettings(c.get("db"), c.get("config"));

/**
 * Last step of every sign-in (Google, password, invitation, dev):
 *  - 2FA enabled  => MFA challenge cookie, no session yet
 *  - 2FA required by policy but not set up => session limited to enrollment
 *  - otherwise    => full session
 */
async function finishLogin(c: Context<AppEnv>, user: User, method: Provider | "password" | "dev", returnTo: string) {
  const db = c.get("db");
  const now = c.get("deps").now();
  const config = c.get("config");
  if (user.totpEnabledAt) {
    const token = await createChallenge(db, user.id, method, returnTo, now);
    setCookie(c, MFA_COOKIE, token, { httpOnly: true, secure: config.secureCookies, sameSite: "Lax", path: "/", maxAge: MFA_CHALLENGE_TTL_MS / 1000 });
    return { status: "mfa_required" as const, returnTo };
  }
  const settings = await settingsOf(c);
  const prev = await loadSession(c);
  if (prev) await revokeSession(db, prev.session.id);
  const { token } = await createSession(db, user.id, now, {
    authMethod: method,
    userAgent: c.req.header("User-Agent"),
    needsMfaSetup: mfaRequired(settings, user.role),
    ttlMs: settings.sessionTtlDays * 24 * 3600_000,
  });
  setSessionCookie(c, token);
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  return { status: "ok" as const, returnTo };
}

function clientIp(c: Context<AppEnv>) {
  return c.req.header("CF-Connecting-IP") ?? null;
}

authRoutes.get("/config", async (c) => {
  const s = await settingsOf(c);
  const isConfigured = configuredMap(c.env);
  return c.json({
    ...(Object.fromEntries(PROVIDERS.map((p) => [p, providerEnabled(s, p, isConfigured)])) as Record<Provider, boolean>),
    password: s.passwordEnabled,
    registration: s.registrationMode,
  });
});

// ---------- external providers (Google, Microsoft, GitHub) ----------

/**
 * Create a single-use OAuth state bound to this browser (fn_oauth cookie) and
 * return the provider's authorization URL. `linkUserId` turns the flow into
 * "connect this provider to my signed-in account".
 */
export async function startOAuth(
  c: Context<AppEnv>,
  provider: Provider,
  opts: { returnTo: string; invitationId?: string | null; linkUserId?: string | null },
): Promise<string> {
  const creds = credentials(c.env, provider)!;
  const now = c.get("deps").now();
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  await c.get("db").insert(oauthStates).values({
    stateHash: await sha256Hex(state),
    codeVerifier: verifier,
    nonce,
    returnTo: opts.returnTo,
    expiresAt: now + STATE_TTL_MS,
    invitationId: opts.invitationId ?? null,
    provider,
    linkUserId: opts.linkUserId ?? null,
  });
  setCookie(c, OAUTH_COOKIE, state, { httpOnly: true, secure: c.get("config").secureCookies, sameSite: "Lax", path: "/auth", maxAge: STATE_TTL_MS / 1000 });
  return buildAuthUrl(c.env, provider, { clientId: creds.clientId, redirectUri: `${appOrigin(c)}${callbackPath(provider)}`, state, nonce, challenge });
}

async function oauthLogin(c: Context<AppEnv>, provider: Provider) {
  const settings = await settingsOf(c);
  if (!providerEnabled(settings, provider, { ...configuredMap(c.env), [provider]: true })) return c.redirect("/login?error=method_disabled", 302);
  if (!configured(c.env, provider)) {
    log.error("config.oauth_missing", { provider });
    return c.redirect("/login?error=not_configured", 302);
  }
  const db = c.get("db");
  const now = c.get("deps").now();
  // Optional: sign-up through an invitation link.
  const inviteToken = c.req.query("invite");
  let invitationId: string | null = null;
  if (inviteToken) {
    const inv = await activeInvitation(db, inviteToken, now);
    if (!inv) return c.redirect("/login?error=invite_invalid", 302);
    // A provider that does not verify emails may only claim an invitation bound to an address.
    if (provider === "microsoft" && !inv.email) return c.redirect("/login?error=invite_needs_email", 302);
    invitationId = inv.id;
  }
  return c.redirect(await startOAuth(c, provider, { returnTo: safeReturnTo(c.req.query("return_to")), invitationId }), 302);
}

async function oauthCallback(c: Context<AppEnv>, provider: Provider) {
  const env = c.env;
  const db = c.get("db");
  const deps = c.get("deps");
  const config = c.get("config");
  const now = deps.now();

  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const cookieState = getCookie(c, OAUTH_COOKIE) ?? "";
  deleteCookie(c, OAUTH_COOKIE, { path: "/auth", secure: config.secureCookies });

  if (c.req.query("error")) return c.redirect("/login?error=cancelled", 302);
  if (!state || !code || !cookieState || !timingSafeEqual(state, cookieState)) return c.redirect("/login?error=invalid_state", 302);
  const pending = await db
    .delete(oauthStates)
    .where(eq(oauthStates.stateHash, await sha256Hex(state)))
    .returning()
    .get();
  if (!pending || pending.expiresAt < now || pending.provider !== provider) return c.redirect("/login?error=invalid_state", 302);
  const linking = !!pending.linkUserId;
  const fail = (code: string) => c.redirect(linking ? `/settings?link_error=${code}` : `/login?error=${code}`, 302);

  const settings = await settingsOf(c);
  const creds = credentials(env, provider);
  if (!creds || !providerEnabled(settings, provider, configuredMap(env))) return fail("method_disabled");

  let identity: ExternalIdentity;
  try {
    identity = await exchange(env, deps, provider, {
      ...creds,
      redirectUri: `${appOrigin(c)}${callbackPath(provider)}`,
      code,
      verifier: pending.codeVerifier,
      nonce: pending.nonce,
      now,
    });
  } catch (e) {
    const codeName = e instanceof HttpError ? e.code : "oauth_failed";
    log.warn("auth.callback_failed", { provider, code: codeName });
    return fail(codeName === "email_not_verified" ? "email_not_verified" : "signin_failed");
  }

  if (linking) return finishLink(c, identity, pending.linkUserId!, now);

  let outcome = await resolveLogin(db, identity, config, env.BOOTSTRAP_ADMIN_EMAIL, now);
  if (!outcome.ok && outcome.reason === "not_invited" && pending.invitationId && settings.registrationMode === "invite") {
    const inv = await db.select().from(invitations).where(eq(invitations.id, pending.invitationId)).get();
    try {
      if (!inv) throw new HttpError(410, "invite_invalid", "invalid");
      // Unverified provider emails never become the account email: use the invitation's address.
      if (!identity.emailVerified && !inv.email) throw new HttpError(403, "invite_needs_email", "invalid");
      const email = identity.emailVerified ? identity.email : inv.email!;
      const user = await acceptInvitation(
        db,
        inv,
        { email, name: identity.name, identity: { provider, subject: identity.subject, email: identity.email } },
        settings.defaultQuotaBytes,
        now,
      );
      outcome = { ok: true, user };
    } catch (e) {
      const code = e instanceof HttpError ? e.code : "invite_invalid";
      return c.redirect(`/login?error=${code}`, 302);
    }
  }
  if (!outcome.ok) {
    log.info("auth.denied", { provider, reason: outcome.reason });
    return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  }
  const r = await finishLogin(c, outcome.user, provider, safeReturnTo(pending.returnTo));
  return c.redirect(r.status === "mfa_required" ? `/mfa?return_to=${encodeURIComponent(r.returnTo)}` : r.returnTo, 302);
}

/** "Connect" from the account page: only for the same signed-in member who started it. */
async function finishLink(c: Context<AppEnv>, identity: ExternalIdentity, linkUserId: string, now: number) {
  const db = c.get("db");
  const auth = await loadSession(c);
  if (!auth || auth.user.id !== linkUserId || auth.user.status !== "active") return c.redirect("/login?error=invalid_state", 302);
  const owner = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .where(and(eq(userIdentities.provider, identity.provider), eq(userIdentities.subject, identity.subject)))
    .get();
  if (owner) return c.redirect(`/settings?link_error=${owner.userId === linkUserId ? "already_linked" : "identity_in_use"}`, 302);
  try {
    await db.batch([
      db.insert(userIdentities).values({ provider: identity.provider, subject: identity.subject, userId: linkUserId, email: identity.email || null, createdAt: now }),
      auditInsert(db, now, linkUserId, "account.identity_link", "user", linkUserId, { provider: identity.provider }),
    ]);
  } catch {
    // UNIQUE(user_id, provider) or a concurrent link of the same identity.
    return c.redirect("/settings?link_error=already_linked", 302);
  }
  return c.redirect(`/settings?linked=${identity.provider}`, 302);
}

// Google keeps its original paths (the redirect URI registered in Google Cloud).
authRoutes.get("/login", (c) => oauthLogin(c, "google"));
authRoutes.get("/callback", (c) => oauthCallback(c, "google"));
authRoutes.get("/login/:provider", (c) => {
  const p = c.req.param("provider");
  if (!isProvider(p)) throw new HttpError(404, "not_found", "Not found");
  return oauthLogin(c, p);
});
authRoutes.get("/callback/:provider", (c) => {
  const p = c.req.param("provider");
  if (!isProvider(p) || p === "google") throw new HttpError(404, "not_found", "Not found");
  return oauthCallback(c, p);
});

// ---------- email + password ----------

authRoutes.post("/password/login", requireSameOrigin, async (c) => {
  const settings = await settingsOf(c);
  if (!settings.passwordEnabled) throw new HttpError(403, "method_disabled", "Password sign-in is turned off");
  const b = await jsonBody(c);
  const db = c.get("db");
  const now = c.get("deps").now();
  let email: string;
  try {
    email = normalizeEmail(b.email);
  } catch {
    throw new HttpError(401, "invalid_credentials", "Incorrect email or password");
  }
  const password = typeof b.password === "string" ? b.password : "";
  const ip = clientIp(c);
  const pairKey = await attemptKey(email, ip);
  const acctKey = await attemptKey(email);
  const ipKey = await attemptKey(ip);
  // Budgets reserved BEFORE checking:
  //  - (account, client): 5 tries, so a stranger cannot lock the real user out
  //  - account (all clients): looser cap against distributed guessing
  //  - client (all accounts): looser cap against credential stuffing
  for (const [scope, key, free] of [
    ["login-pair", pairKey, 5],
    ["login-account", acctKey, 30],
    ["login-client", ipKey, 30],
  ] as const) {
    const budget = await reserveAttempt(db, scope, key, now, free);
    if (!budget.ok) throw tooMany(budget);
  }
  let user = (await db.select().from(users).where(eq(users.email, email)).get()) ?? null;
  const ok = await checkPassword(c.env, user, password); // constant work even if the account is unknown
  if (user) user = await liftExpiredBan(db, user, now);
  // Same answer for unknown, wrong password and disabled: no account-state oracle.
  if (!ok || !user || user.status === "disabled") throw new HttpError(401, "invalid_credentials", "Incorrect email or password");
  // Success refunds this client's slots (office networks share one IP).
  await clearAttempts(db, "login-pair", pairKey);
  await clearAttempts(db, "login-client", ipKey);
  if (user.status === "invited") await db.update(users).set({ status: "active", updatedAt: now }).where(eq(users.id, user.id));
  return c.json(await finishLogin(c, user, "password", safeReturnTo(typeof b.returnTo === "string" ? b.returnTo : "/")));
});

// ---------- second factor ----------

authRoutes.post("/mfa/verify", requireSameOrigin, async (c) => {
  const db = c.get("db");
  const now = c.get("deps").now();
  const config = c.get("config");
  const challenge = await loadChallenge(db, getCookie(c, MFA_COOKIE), now);
  if (!challenge) throw new HttpError(401, "mfa_expired", "Your sign-in expired. Please sign in again.");
  const b = await jsonBody(c);
  const budget = await reserveAttempt(db, "mfa", challenge.userId, now);
  if (!budget.ok) throw tooMany(budget);
  const user = await db.select().from(users).where(eq(users.id, challenge.userId)).get();
  if (!user || user.status !== "active") throw new HttpError(403, "account_disabled", "This account is disabled");
  const ok = await verifySecondFactor(db, c.env, user, { code: b.code, recoveryCode: b.recoveryCode }, now);
  if (!ok) throw new HttpError(401, "invalid_code", "That code is not valid");
  if (!(await consumeChallenge(db, challenge.id))) throw new HttpError(401, "mfa_expired", "Your sign-in expired. Please sign in again.");
  await clearAttempts(db, "mfa", challenge.userId);
  deleteCookie(c, MFA_COOKIE, { path: "/", secure: config.secureCookies });
  const settings = await settingsOf(c);
  const prev = await loadSession(c);
  if (prev) await revokeSession(db, prev.session.id);
  const { token } = await createSession(db, user.id, now, {
    authMethod: challenge.authMethod as Provider | "password",
    userAgent: c.req.header("User-Agent"),
    ttlMs: settings.sessionTtlDays * 24 * 3600_000,
  });
  setSessionCookie(c, token);
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  return c.json({ status: "ok", returnTo: safeReturnTo(challenge.returnTo), usedRecoveryCode: !!b.recoveryCode });
});

// ---------- invitations ----------

authRoutes.get("/invite/:token", async (c) => {
  const now = c.get("deps").now();
  const settings = await settingsOf(c);
  const inv = settings.registrationMode === "invite" ? await activeInvitation(c.get("db"), c.req.param("token"), now) : null;
  if (!inv) return c.json({ valid: false }, 404);
  const isConfigured = configuredMap(c.env);
  return c.json({
    valid: true,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt,
    // Password sign-up only for email-bound invitations: an open link must not let
    // someone claim an arbitrary address that a Google sign-in would later attach to.
    methods: {
      google: providerEnabled(settings, "google", isConfigured),
      github: providerEnabled(settings, "github", isConfigured),
      // Microsoft does not verify emails: only for invitations bound to an address.
      microsoft: providerEnabled(settings, "microsoft", isConfigured) && !!inv.email,
      password: settings.passwordEnabled && !!inv.email,
    },
  });
});

authRoutes.post("/invite/:token/register", requireSameOrigin, async (c) => {
  const db = c.get("db");
  const now = c.get("deps").now();
  const settings = await settingsOf(c);
  if (settings.registrationMode !== "invite") throw new HttpError(403, "registration_closed", "Registration is closed");
  if (!settings.passwordEnabled) throw new HttpError(403, "method_disabled", "Password sign-up is turned off");
  const inv = await activeInvitation(db, c.req.param("token"), now);
  if (!inv) throw new HttpError(410, "invite_invalid", "This invitation is no longer valid");
  if (!inv.email) throw new HttpError(403, "invite_google_only", "This invitation link supports Google sign-in only");
  const b = await jsonBody(c);
  const email = inv.email;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 100) : null;
  const pw = validatePassword(b.password, email);
  const h = await makePasswordHash(c.env, pw);
  const user = await acceptInvitation(db, inv, { email, name, ...h }, settings.defaultQuotaBytes, now);
  return c.json(await finishLogin(c, user, "password", "/"), 201);
});

// ---------- password reset (links are issued by an Admin) ----------

authRoutes.get("/password-reset/:token", async (c) => {
  const info = await resetInfo(c.get("db"), c.req.param("token"), c.get("deps").now());
  if (!info) return c.json({ valid: false }, 404);
  return c.json({ valid: true, email: info.email });
});

authRoutes.post("/password-reset/:token", requireSameOrigin, async (c) => {
  const b = await jsonBody(c);
  const r = await applyPasswordReset(c.get("db"), c.env, c.req.param("token"), b.password, c.get("deps").now());
  clearSessionCookie(c);
  return c.json({ ok: true, email: r.email });
});

// ---------- logout / dev ----------

authRoutes.post("/logout", requireSameOrigin, async (c) => {
  const auth = await loadSession(c);
  if (auth) await revokeSession(c.get("db"), auth.session.id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

/**
 * Passwordless login for local development and E2E only.
 * Requires ENVIRONMENT=development, DEV_AUTH=1 and a loopback host.
 */
export function devAuthAllowed(env: AppEnv["Bindings"], url: string, isDev: boolean): boolean {
  if (!isDev || env.DEV_AUTH !== "1") return false;
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

authRoutes.get("/dev-login", async (c) => {
  const config = c.get("config");
  if (!devAuthAllowed(c.env, c.req.url, config.isDev)) throw new HttpError(404, "not_found", "Not found");
  const email = (c.req.query("email") ?? c.env.BOOTSTRAP_ADMIN_EMAIL ?? "").trim().toLowerCase();
  const db = c.get("db");
  const now = c.get("deps").now();
  const outcome = await resolveLogin(
    db,
    { provider: "dev", subject: `dev:${email}`, email, emailVerified: true, name: email.split("@")[0] ?? email },
    config,
    c.env.BOOTSTRAP_ADMIN_EMAIL,
    now,
  );
  if (!outcome.ok) return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  const r = await finishLogin(c, outcome.user, "dev", safeReturnTo(c.req.query("return_to")));
  return c.redirect(r.status === "mfa_required" ? `/mfa?return_to=${encodeURIComponent(r.returnTo)}` : r.returnTo, 302);
});
