import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { invitations, oauthStates, users, type User } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto.ts";
import { log } from "../lib/log.ts";
import { appOrigin, requireSameOrigin } from "../auth/middleware.ts";
import { buildAuthUrl, exchangeCode, googleJwks, pkcePair } from "../auth/oidc.ts";
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
import { getSettings, mfaRequired } from "../services/settings.ts";
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
async function finishLogin(c: Context<AppEnv>, user: User, method: "google" | "password" | "dev", returnTo: string) {
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
  return c.json({
    google: s.googleEnabled && !!c.env.GOOGLE_CLIENT_ID && !!c.env.GOOGLE_CLIENT_SECRET,
    password: s.passwordEnabled,
    registration: s.registrationMode,
  });
});

// ---------- Google ----------

authRoutes.get("/login", async (c) => {
  const env = c.env;
  const config = c.get("config");
  const settings = await settingsOf(c);
  if (!settings.googleEnabled) return c.redirect("/login?error=method_disabled", 302);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    log.error("config.oauth_missing");
    return c.redirect("/login?error=not_configured", 302);
  }
  const db = c.get("db");
  const now = c.get("deps").now();
  // Optional: Google sign-up through an invitation link.
  const inviteToken = c.req.query("invite");
  let invitationId: string | null = null;
  if (inviteToken) {
    const inv = await activeInvitation(db, inviteToken, now);
    if (!inv) return c.redirect("/login?error=invite_invalid", 302);
    invitationId = inv.id;
  }
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  await db.insert(oauthStates).values({
    stateHash: await sha256Hex(state),
    codeVerifier: verifier,
    nonce,
    returnTo: safeReturnTo(c.req.query("return_to")),
    expiresAt: now + STATE_TTL_MS,
    invitationId,
  });
  setCookie(c, OAUTH_COOKIE, state, { httpOnly: true, secure: config.secureCookies, sameSite: "Lax", path: "/auth", maxAge: STATE_TTL_MS / 1000 });
  return c.redirect(buildAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri: `${appOrigin(c)}/auth/callback`, state, nonce, challenge }), 302);
});

authRoutes.get("/callback", async (c) => {
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
  if (!pending || pending.expiresAt < now) return c.redirect("/login?error=invalid_state", 302);

  let identity;
  try {
    identity = await exchangeCode({
      fetchImpl: deps.googleFetch,
      jwks: deps.googleJwks ?? googleJwks(),
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      redirectUri: `${appOrigin(c)}/auth/callback`,
      code,
      verifier: pending.codeVerifier,
      nonce: pending.nonce,
      now,
    });
  } catch (e) {
    const codeName = e instanceof HttpError ? e.code : "oauth_failed";
    log.warn("auth.callback_failed", { code: codeName });
    return c.redirect(`/login?error=${codeName === "email_not_verified" ? "email_not_verified" : "signin_failed"}`, 302);
  }

  const settings = await settingsOf(c);
  let outcome = await resolveLogin(db, identity, config, env.BOOTSTRAP_ADMIN_EMAIL, now);
  if (!outcome.ok && outcome.reason === "not_invited" && pending.invitationId && settings.registrationMode === "invite") {
    const inv = await db.select().from(invitations).where(eq(invitations.id, pending.invitationId)).get();
    try {
      if (!inv) throw new HttpError(410, "invite_invalid", "invalid");
      const user = await acceptInvitation(db, inv, { email: identity.email, name: identity.name, googleSub: identity.sub }, settings.defaultQuotaBytes, now);
      outcome = { ok: true, user };
    } catch (e) {
      const code = e instanceof HttpError ? e.code : "invite_invalid";
      return c.redirect(`/login?error=${code}`, 302);
    }
  }
  if (!outcome.ok) {
    log.info("auth.denied", { reason: outcome.reason });
    return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  }
  const r = await finishLogin(c, outcome.user, "google", safeReturnTo(pending.returnTo));
  return c.redirect(r.status === "mfa_required" ? `/mfa?return_to=${encodeURIComponent(r.returnTo)}` : r.returnTo, 302);
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
    authMethod: challenge.authMethod as "google" | "password",
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
  return c.json({
    valid: true,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt,
    // Password sign-up only for email-bound invitations: an open link must not let
    // someone claim an arbitrary address that a Google sign-in would later attach to.
    methods: { google: settings.googleEnabled && !!c.env.GOOGLE_CLIENT_ID, password: settings.passwordEnabled && !!inv.email },
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
  const user = await acceptInvitation(db, inv, { email, name, googleSub: null, ...h }, settings.defaultQuotaBytes, now);
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
  const outcome = await resolveLogin(db, { sub: `dev:${email}`, email, name: email.split("@")[0] ?? email }, config, c.env.BOOTSTRAP_ADMIN_EMAIL, now);
  if (!outcome.ok) return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  const r = await finishLogin(c, outcome.user, "dev", safeReturnTo(c.req.query("return_to")));
  return c.redirect(r.status === "mfa_required" ? `/mfa?return_to=${encodeURIComponent(r.returnTo)}` : r.returnTo, 302);
});
