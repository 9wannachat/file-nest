import { and, eq, gt, lt } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sessions, users, type Session, type User } from "../db/schema.ts";
import type { AppConfig, AppEnv, Db } from "../env.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { getSettings } from "../services/settings.ts";

export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const SESSION_MAX_MS = 30 * 24 * 3600_000;
const REFRESH_AFTER_MS = 24 * 3600_000;

export function sessionCookieName(config: AppConfig) {
  return config.secureCookies ? "__Host-fn_session" : "fn_session";
}

export interface SessionOptions {
  authMethod?: "google" | "microsoft" | "github" | "password" | "dev";
  userAgent?: string | null;
  /** Policy requires 2FA but the member has not enrolled yet: only enrollment is allowed. */
  needsMfaSetup?: boolean;
  ttlMs?: number;
}

export async function createSession(db: Db, userId: string, now: number, opts: SessionOptions = {}) {
  const token = randomToken(32);
  const session: Session = {
    id: crypto.randomUUID(),
    tokenHash: await sha256Hex(token),
    csrfToken: randomToken(24),
    userId,
    createdAt: now,
    expiresAt: now + (opts.ttlMs ?? SESSION_TTL_MS),
    lastSeenAt: now,
    // A fresh sign-in counts as a recent re-authentication.
    reauthAt: now,
    needsMfaSetup: opts.needsMfaSetup ?? false,
    authMethod: opts.authMethod ?? null,
    userAgent: opts.userAgent ? opts.userAgent.slice(0, 200) : null,
  };
  await db.insert(sessions).values(session);
  return { token, session };
}

export function setSessionCookie(c: Context<AppEnv>, token: string) {
  const config = c.get("config");
  setCookie(c, sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(SESSION_MAX_MS / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  const config = c.get("config");
  deleteCookie(c, sessionCookieName(config), { path: "/", secure: config.secureCookies });
}

/** Resolve the cookie to an active session + active user, or null. Slides expiry. */
export async function loadSession(c: Context<AppEnv>): Promise<{ user: User; session: Session } | null> {
  const token = getCookie(c, sessionCookieName(c.get("config")));
  if (!token || token.length > 128) return null;
  const db = c.get("db");
  const now = c.get("deps").now();
  const hash = await sha256Hex(token);
  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hash), gt(sessions.expiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.user.status !== "active") {
    // Disabled members lose every session immediately.
    await db.delete(sessions).where(eq(sessions.userId, row.user.id));
    return null;
  }
  if (now - row.session.lastSeenAt > REFRESH_AFTER_MS) {
    const ttl = (await getSettings(db, c.get("config"))).sessionTtlDays * 24 * 3600_000;
    const expiresAt = Math.min(now + ttl, row.session.createdAt + SESSION_MAX_MS);
    await db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.id, row.session.id));
    row.session.expiresAt = expiresAt;
    row.session.lastSeenAt = now;
  }
  return row;
}

export async function revokeSession(db: Db, sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function revokeUserSessions(db: Db, userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function purgeExpiredSessions(db: Db, now: number) {
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
}
