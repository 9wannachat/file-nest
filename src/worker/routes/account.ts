/**
 * Self-service account security (browser session only; API tokens get 403 via
 * the token allowlist): password, 2FA, recovery codes, sessions, re-auth.
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mfaChallenges, sessions, users } from "../db/schema.ts";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { requireRecentAuth, sessionOf } from "../auth/middleware.ts";
import {
  attemptKey,
  checkPassword,
  clearAttempts,
  confirmTotpEnrollment,
  disableTotp,
  makePasswordHash,
  recoveryCodesRemaining,
  regenerateRecoveryCodes,
  reserveAttempt,
  startTotpEnrollment,
  tooMany,
  validatePassword,
  verifySecondFactor,
} from "../services/authn.ts";
import { auditInsert } from "../services/audit.ts";
import { getSettings, mfaRequired } from "../services/settings.ts";
import { idParam, jsonBody, now } from "./util.ts";

export const account = new Hono<AppEnv>();

/** Reload the user row (session middleware gives the row as of request start). */
async function freshUser(c: Parameters<typeof sessionOf>[0] & { get: (k: "db") => AppEnv["Variables"]["db"] }) {
  const { user } = sessionOf(c);
  return (await c.get("db").select().from(users).where(eq(users.id, user.id)).get())!;
}

account.get("/", async (c) => {
  const { session } = sessionOf(c);
  const db = c.get("db");
  const user = await freshUser(c);
  const settings = await getSettings(db, c.get("config"));
  const list = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, user.id), sql`${sessions.expiresAt} > ${now(c)}`))
    .orderBy(desc(sessions.lastSeenAt))
    .limit(50);
  return c.json({
    email: user.email,
    name: user.name,
    hasPassword: !!user.passwordHash,
    googleLinked: !!user.googleSub && !user.googleSub.startsWith("dev:"),
    mfa: {
      enabled: !!user.totpEnabledAt,
      enabledAt: user.totpEnabledAt,
      required: mfaRequired(settings, user.role),
      recoveryCodesRemaining: user.totpEnabledAt ? await recoveryCodesRemaining(db, user.id) : 0,
    },
    passwordUpdatedAt: user.passwordUpdatedAt,
    reauthUntil: session.reauthAt ? session.reauthAt + 10 * 60_000 : null,
    sessions: list.map((s) => ({
      id: s.id,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      authMethod: s.authMethod,
      userAgent: s.userAgent,
      current: s.id === session.id,
    })),
  });
});

/** Step-up: confirm with password and/or a 2FA code. */
account.post("/reauth", async (c) => {
  const { session } = sessionOf(c);
  const db = c.get("db");
  const t = now(c);
  const user = await freshUser(c);
  const b = await jsonBody(c);
  const budget = await reserveAttempt(db, "reauth", user.id, t);
  if (!budget.ok) throw tooMany(budget);
  let ok = false;
  if (user.totpEnabledAt) ok = await verifySecondFactor(db, c.env, user, { code: b.code, recoveryCode: b.recoveryCode }, t);
  else if (user.passwordHash) ok = await checkPassword(c.env, user, typeof b.password === "string" ? b.password : "");
  else throw new HttpError(409, "reauth_by_signin", "Sign in again to confirm it's you");
  if (!ok) throw new HttpError(401, user.totpEnabledAt ? "invalid_code" : "invalid_credentials", "That didn't match. Try again.");
  await clearAttempts(db, "reauth", user.id);
  await db.update(sessions).set({ reauthAt: t }).where(eq(sessions.id, session.id));
  return c.json({ ok: true, reauthUntil: t + 10 * 60_000 });
});

/** Set or change the password. Changing an existing one needs recent auth; other sessions are signed out. */
account.put("/password", async (c) => {
  const { session } = sessionOf(c);
  const db = c.get("db");
  const t = now(c);
  const user = await freshUser(c);
  requireRecentAuth(c, t);
  const b = await jsonBody(c);
  const pw = validatePassword(b.newPassword, user.email);
  const h = await makePasswordHash(c.env, pw);
  await db.batch([
    db.update(users).set({ ...h, passwordUpdatedAt: t, updatedAt: t }).where(eq(users.id, user.id)),
    db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, session.id))),
    auditInsert(db, t, user.id, "auth.password_change", "user", user.id, { firstPassword: !user.passwordHash }),
  ]);
  await clearAttempts(db, "login-account", await attemptKey(user.email));
  await db.delete(mfaChallenges).where(eq(mfaChallenges.userId, user.id));
  return c.json({ ok: true });
});

// Enrolling a NEW authenticator needs recent auth (a stolen session could bind its own), except the forced setup.
account.post("/2fa/setup", async (c) => {
  if (!c.get("mfaSetupRequired")) requireRecentAuth(c, now(c));
  return c.json(await startTotpEnrollment(c.get("db"), c.env, await freshUser(c)));
});

account.post("/2fa/enable", async (c) => {
  if (!c.get("mfaSetupRequired")) requireRecentAuth(c, now(c));
  const b = await jsonBody(c);
  const user = await freshUser(c);
  const budget = await reserveAttempt(c.get("db"), "mfa-enroll", user.id, now(c));
  if (!budget.ok) throw tooMany(budget);
  const r = await confirmTotpEnrollment(c.get("db"), c.env, user, b.code, now(c));
  await clearAttempts(c.get("db"), "mfa-enroll", user.id);
  return c.json(r);
});

account.post("/2fa/disable", async (c) => {
  const t = now(c);
  requireRecentAuth(c, t);
  const user = await freshUser(c);
  const settings = await getSettings(c.get("db"), c.get("config"));
  if (mfaRequired(settings, user.role)) throw new HttpError(409, "mfa_required_by_policy", "Your organization requires two-factor authentication");
  await disableTotp(c.get("db"), user.id, user.id, t, "auth.mfa_disable");
  return c.json({ ok: true });
});

account.post("/2fa/recovery-codes", async (c) => {
  const t = now(c);
  requireRecentAuth(c, t);
  return c.json(await regenerateRecoveryCodes(c.get("db"), await freshUser(c), t));
});

account.delete("/sessions/:id", async (c) => {
  const { user } = sessionOf(c);
  await c.get("db").delete(sessions).where(and(eq(sessions.id, idParam(c)), eq(sessions.userId, user.id)));
  return c.json({ ok: true });
});

account.post("/sessions/revoke-others", async (c) => {
  const { user, session } = sessionOf(c);
  await c.get("db").delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.id, session.id)));
  return c.json({ ok: true });
});
