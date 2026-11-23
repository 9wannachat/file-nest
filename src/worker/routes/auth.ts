import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { oauthStates } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { randomToken, sha256Hex, timingSafeEqual } from "../lib/crypto.ts";
import { log } from "../lib/log.ts";
import { appOrigin, requireSameOrigin } from "../auth/middleware.ts";
import { buildAuthUrl, exchangeCode, googleJwks, pkcePair } from "../auth/oidc.ts";
import { clearSessionCookie, createSession, loadSession, revokeSession, setSessionCookie } from "../auth/session.ts";
import { resolveLogin } from "../services/members.ts";

const STATE_TTL_MS = 10 * 60_000;
const OAUTH_COOKIE = "fn_oauth";

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || v.length > 512) return "/";
  if (/[\u0000-\u001f]/.test(v)) return "/";
  if (v.startsWith("/auth/") || v.startsWith("/api/")) return "/";
  return v;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/login", async (c) => {
  const env = c.env;
  const config = c.get("config");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    log.error("config.oauth_missing");
    return c.redirect("/login?error=not_configured", 302);
  }
  const db = c.get("db");
  const now = c.get("deps").now();
  const state = randomToken(32);
  const nonce = randomToken(32);
  const { verifier, challenge } = await pkcePair();
  await db.insert(oauthStates).values({
    stateHash: await sha256Hex(state),
    codeVerifier: verifier,
    nonce,
    returnTo: safeReturnTo(c.req.query("return_to")),
    expiresAt: now + STATE_TTL_MS,
  });
  // Binds the login to this browser (login CSRF protection).
  setCookie(c, OAUTH_COOKIE, state, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: "/auth",
    maxAge: STATE_TTL_MS / 1000,
  });
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.redirect(
    buildAuthUrl({
      clientId: env.GOOGLE_CLIENT_ID,
      redirectUri: `${appOrigin(c)}/auth/callback`,
      state,
      nonce,
      challenge,
    }),
    302,
  );
});

authRoutes.get("/callback", async (c) => {
  const env = c.env;
  const db = c.get("db");
  const deps = c.get("deps");
  const config = c.get("config");
  const now = deps.now();
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");

  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const cookieState = getCookie(c, OAUTH_COOKIE) ?? "";
  deleteCookie(c, OAUTH_COOKIE, { path: "/auth", secure: config.secureCookies });

  if (c.req.query("error")) return c.redirect("/login?error=cancelled", 302);
  if (!state || !code || !cookieState || !timingSafeEqual(state, cookieState)) {
    return c.redirect("/login?error=invalid_state", 302);
  }
  const stateHash = await sha256Hex(state);
  // Single use: delete and read in one statement.
  const pending = await db.delete(oauthStates).where(eq(oauthStates.stateHash, stateHash)).returning().get();
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

  const outcome = await resolveLogin(db, identity, config, env.BOOTSTRAP_ADMIN_EMAIL, now);
  if (!outcome.ok) {
    log.info("auth.denied", { reason: outcome.reason });
    return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  }
  // Rotate: drop any session this browser already had, then issue a new one.
  const prev = await loadSession(c);
  if (prev) await revokeSession(db, prev.session.id);
  const { token } = await createSession(db, outcome.user.id, now);
  setSessionCookie(c, token);
  return c.redirect(safeReturnTo(pending.returnTo), 302);
});

authRoutes.post("/logout", requireSameOrigin, async (c) => {
  const auth = await loadSession(c);
  if (auth) await revokeSession(c.get("db"), auth.session.id);
  clearSessionCookie(c);
  c.header("Cache-Control", "no-store");
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
    { sub: `dev:${email}`, email, name: email.split("@")[0] ?? email },
    config,
    c.env.BOOTSTRAP_ADMIN_EMAIL,
    now,
  );
  if (!outcome.ok) return c.redirect(`/not-authorized?reason=${outcome.reason}`, 302);
  const { token } = await createSession(db, outcome.user.id, now);
  setSessionCookie(c, token);
  return c.redirect(safeReturnTo(c.req.query("return_to")), 302);
});

