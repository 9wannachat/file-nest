/**
 * Email/password sign-in, TOTP 2FA, recovery codes, MFA challenges, attempt
 * budgets and admin-issued password resets.
 */
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { apiTokens, mfaChallenges, passwordResets, recoveryCodes, sessions, users, type User } from "../db/schema.ts";
import type { Db, Env } from "../env.ts";
import { base64url, decryptString, encryptString, hashPassword, randomBytes, randomToken, sha256Hex, verifyPassword } from "../lib/crypto.ts";
import { badRequest, HttpError } from "../lib/errors.ts";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp.ts";
import { auditInsert } from "./audit.ts";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
export const RESET_TTL_MS = 30 * 60_000;
export const RECOVERY_CODE_COUNT = 10;
export const REAUTH_WINDOW_MS = 10 * 60_000;

const COMMON = new Set([
  "password", "password1", "password123", "1234567890", "12345678910", "qwertyuiop", "iloveyou12", "letmein123",
  "welcome123", "admin12345", "changeme123", "filenest123", "abc1234567", "1q2w3e4r5t", "qwerty12345", "football12",
]);

/**
 * Cloudflare Workers' WebCrypto has been reported to reject PBKDF2 above 100,000
 * iterations in production, so that is both the default and the ceiling.
 */
export const PBKDF2_MAX_ITERATIONS = 100_000;
export function pbkdf2Iterations(env: Env): number {
  const n = Number(env.PASSWORD_PBKDF2_ITERATIONS ?? PBKDF2_MAX_ITERATIONS);
  return Number.isSafeInteger(n) && n >= 10_000 ? Math.min(n, PBKDF2_MAX_ITERATIONS) : PBKDF2_MAX_ITERATIONS;
}

export function validatePassword(pw: unknown, email?: string): string {
  if (typeof pw !== "string") throw badRequest("weak_password", "Password is required");
  const len = [...pw].length;
  if (len < PASSWORD_MIN || len > PASSWORD_MAX) throw badRequest("weak_password", `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`);
  const lower = pw.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(pw)) throw badRequest("weak_password", "This password is too common");
  if (email && lower.includes(email.split("@")[0]!.toLowerCase()) && email.split("@")[0]!.length >= 4) {
    throw badRequest("weak_password", "Password must not contain your email name");
  }
  return pw;
}

export async function makePasswordHash(env: Env, pw: string) {
  const salt = base64url(randomBytes(16));
  return { passwordHash: await hashPassword(pw, salt, pbkdf2Iterations(env)), passwordSalt: salt };
}

// A fixed hash so unknown-account logins cost the same as real ones (no timing oracle).
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";
let dummyHash: Promise<string> | null = null;
export async function checkPassword(env: Env, user: Pick<User, "passwordHash" | "passwordSalt"> | null, pw: string): Promise<boolean> {
  if (pw.length > PASSWORD_MAX * 4) return false;
  if (!user?.passwordHash || !user.passwordSalt) {
    dummyHash ??= hashPassword("not-a-real-password", DUMMY_SALT, pbkdf2Iterations(env));
    await verifyPassword(pw, DUMMY_SALT, await dummyHash);
    return false;
  }
  return verifyPassword(pw, user.passwordSalt, user.passwordHash);
}

// ---------- attempt budgets (reserved atomically before verification) ----------

const FREE_ATTEMPTS = 5;
const MAX_LOCK_MS = 15 * 60_000;
const DECAY_MS = 24 * 3600_000;

export type Budget = { ok: true } | { ok: false; retryAfterMs: number };

export async function reserveAttempt(db: Db, scope: string, key: string, now: number, free = FREE_ATTEMPTS): Promise<Budget> {
  const row = await db.$client
    .prepare(
      `INSERT INTO auth_attempts (scope, key, failed_attempts, locked_until, updated_at)
       VALUES (?1, ?2, 1, NULL, ?3)
       ON CONFLICT (scope, key) DO UPDATE SET
         failed_attempts = CASE WHEN updated_at < ?3 - ?6 THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN updated_at < ?3 - ?6 THEN 1 ELSE failed_attempts + 1 END) >= ?4
           THEN ?3 + min(?5, 60000 * (1 << min((CASE WHEN updated_at < ?3 - ?6 THEN 1 ELSE failed_attempts + 1 END) - ?4, 10)))
           ELSE NULL END,
         updated_at = ?3
       WHERE auth_attempts.locked_until IS NULL OR auth_attempts.locked_until <= ?3
       RETURNING failed_attempts`,
    )
    .bind(scope, key, now, free, MAX_LOCK_MS, DECAY_MS)
    .first<{ failed_attempts: number }>();
  if (row) return { ok: true };
  const cur = await db.$client
    .prepare("SELECT locked_until FROM auth_attempts WHERE scope = ?1 AND key = ?2")
    .bind(scope, key)
    .first<{ locked_until: number | null }>();
  return { ok: false, retryAfterMs: Math.max(1000, (cur?.locked_until ?? now + 60_000) - now) };
}

export async function clearAttempts(db: Db, scope: string, key: string) {
  await db.$client.prepare("DELETE FROM auth_attempts WHERE scope = ?1 AND key = ?2").bind(scope, key).run();
}

export const attemptKey = async (...parts: (string | null | undefined)[]) => (await sha256Hex(parts.map((p) => p ?? "-").join("|"))).slice(0, 32);

export function tooMany(b: { retryAfterMs: number }) {
  return new HttpError(429, "too_many_attempts", `Too many attempts. Try again in ${Math.ceil(b.retryAfterMs / 60_000)} minute(s).`, {
    retryAfterSeconds: Math.ceil(b.retryAfterMs / 1000),
  });
}

// ---------- 2FA ----------

function key(env: Env) {
  if (!env.APP_ENCRYPTION_KEY) throw new HttpError(500, "not_configured", "Server is not configured for 2FA");
  return env.APP_ENCRYPTION_KEY;
}

export async function startTotpEnrollment(db: Db, env: Env, user: User) {
  if (user.totpEnabledAt) throw new HttpError(409, "mfa_already_enabled", "Two-factor authentication is already on");
  const secret = generateTotpSecret();
  await db
    .update(users)
    .set({ totpPendingEnc: await encryptString(key(env), secret, `totp-pending:${user.id}`) })
    .where(eq(users.id, user.id));
  return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

async function newRecoveryCodes(db: Db, userId: string, now: number) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = base64url(randomBytes(8)).replace(/[-_]/g, "x").slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const rows = await Promise.all(
    codes.map(async (c) => ({ id: crypto.randomUUID(), userId, codeHash: await sha256Hex(`rc:${c}`), createdAt: now, usedAt: null })),
  );
  return { codes, stmts: [db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)), ...rows.map((r) => db.insert(recoveryCodes).values(r))] };
}

export async function confirmTotpEnrollment(db: Db, env: Env, user: User, code: unknown, now: number) {
  if (!user.totpPendingEnc) throw new HttpError(409, "mfa_not_started", "Start two-factor setup first");
  const secret = await decryptString(key(env), user.totpPendingEnc, `totp-pending:${user.id}`);
  const step = await verifyTotp(secret, String(code ?? "").trim(), now, null);
  if (step === null) throw badRequest("invalid_code", "That code is not valid. Check your device's time and try again.");
  const { codes, stmts } = await newRecoveryCodes(db, user.id, now);
  await db.batch([
    db
      .update(users)
      .set({
        totpSecretEnc: await encryptString(key(env), secret, `totp:${user.id}`),
        totpPendingEnc: null,
        totpEnabledAt: now,
        totpLastStep: step,
        updatedAt: now,
      })
      .where(eq(users.id, user.id)),
    // Enrollment done: lift the setup-only restriction on this member's sessions.
    db.update(sessions).set({ needsMfaSetup: false }).where(eq(sessions.userId, user.id)),
    ...stmts,
    auditInsert(db, now, user.id, "auth.mfa_enable", "user", user.id),
  ] as unknown as [ReturnType<typeof auditInsert>]);
  return { recoveryCodes: codes };
}

export async function regenerateRecoveryCodes(db: Db, user: User, now: number) {
  if (!user.totpEnabledAt) throw new HttpError(409, "mfa_not_enabled", "Two-factor authentication is off");
  const { codes, stmts } = await newRecoveryCodes(db, user.id, now);
  await db.batch([...stmts, auditInsert(db, now, user.id, "auth.recovery_codes_regenerate", "user", user.id)] as unknown as [
    ReturnType<typeof auditInsert>,
  ]);
  return { recoveryCodes: codes };
}

export async function disableTotp(db: Db, userId: string, actorId: string, now: number, action: "auth.mfa_disable" | "member.mfa_reset") {
  await db.batch([
    db
      .update(users)
      .set({ totpSecretEnc: null, totpPendingEnc: null, totpEnabledAt: null, totpLastStep: null, updatedAt: now })
      .where(eq(users.id, userId)),
    db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId)),
    db.delete(mfaChallenges).where(eq(mfaChallenges.userId, userId)),
    auditInsert(db, now, actorId, action, "user", userId),
  ]);
}

/** Verify a TOTP code (advancing the replay counter atomically) or a one-time recovery code. */
export async function verifySecondFactor(db: Db, env: Env, user: User, input: { code?: unknown; recoveryCode?: unknown }, now: number): Promise<boolean> {
  if (!user.totpEnabledAt || !user.totpSecretEnc) return false;
  if (typeof input.recoveryCode === "string" && input.recoveryCode.trim()) {
    const norm = input.recoveryCode.trim().toLowerCase().replace(/\s/g, "");
    const formatted = norm.includes("-") ? norm : `${norm.slice(0, 5)}-${norm.slice(5)}`;
    const used = await db
      .update(recoveryCodes)
      .set({ usedAt: now })
      .where(and(eq(recoveryCodes.userId, user.id), eq(recoveryCodes.codeHash, await sha256Hex(`rc:${formatted}`)), isNull(recoveryCodes.usedAt)))
      .returning({ id: recoveryCodes.id })
      .get();
    return !!used;
  }
  const secret = await decryptString(key(env), user.totpSecretEnc, `totp:${user.id}`);
  const step = await verifyTotp(secret, String(input.code ?? "").trim(), now, user.totpLastStep);
  if (step === null) return false;
  // Compare-and-set so the same code cannot be used twice concurrently.
  const res = await db.run(sql`UPDATE users SET totp_last_step = ${step}
    WHERE id = ${user.id} AND (totp_last_step IS NULL OR totp_last_step < ${step})`);
  return res.meta.changes === 1;
}

export async function recoveryCodesRemaining(db: Db, userId: string) {
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(recoveryCodes)
    .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt)))
    .get();
  return r?.n ?? 0;
}

// ---------- MFA challenge (between first factor and session) ----------

export async function createChallenge(db: Db, userId: string, authMethod: string, returnTo: string, now: number) {
  const token = randomToken(32);
  await db.insert(mfaChallenges).values({
    id: crypto.randomUUID(),
    tokenHash: await sha256Hex(token),
    userId,
    authMethod,
    returnTo,
    createdAt: now,
    expiresAt: now + MFA_CHALLENGE_TTL_MS,
  });
  return token;
}

export async function loadChallenge(db: Db, token: string | undefined, now: number) {
  if (!token || token.length > 100) return null;
  const c = await db.select().from(mfaChallenges).where(eq(mfaChallenges.tokenHash, await sha256Hex(token))).get();
  if (!c || c.expiresAt <= now) return null;
  return c;
}

export async function consumeChallenge(db: Db, id: string) {
  const r = await db.delete(mfaChallenges).where(eq(mfaChallenges.id, id)).returning({ id: mfaChallenges.id }).get();
  return !!r;
}

export async function purgeAuthLeftovers(db: Db, now: number) {
  await db.delete(mfaChallenges).where(lt(mfaChallenges.expiresAt, now));
  await db.delete(passwordResets).where(lt(passwordResets.expiresAt, now - 24 * 3600_000));
  await db.$client.prepare("DELETE FROM auth_attempts WHERE updated_at < ?1").bind(now - 2 * 24 * 3600_000).run();
}

// ---------- admin-issued password reset links ----------

export async function createPasswordReset(db: Db, target: User, actorId: string, origin: string, now: number) {
  const token = randomToken(32);
  await db.batch([
    // Only the newest link works.
    db.update(passwordResets).set({ usedAt: now }).where(and(eq(passwordResets.userId, target.id), isNull(passwordResets.usedAt))),
    db.insert(passwordResets).values({
      id: crypto.randomUUID(),
      tokenHash: await sha256Hex(token),
      userId: target.id,
      createdBy: actorId,
      createdAt: now,
      expiresAt: now + RESET_TTL_MS,
      usedAt: null,
    }),
    auditInsert(db, now, actorId, "member.password_reset_link", "user", target.id),
  ]);
  return { url: `${origin}/reset-password/${token}`, expiresAt: now + RESET_TTL_MS };
}

export async function resetInfo(db: Db, token: string, now: number) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = await db
    .select({ reset: passwordResets, email: users.email })
    .from(passwordResets)
    .innerJoin(users, eq(users.id, passwordResets.userId))
    .where(and(eq(passwordResets.tokenHash, await sha256Hex(token)), isNull(passwordResets.usedAt)))
    .get();
  if (!r || r.reset.expiresAt <= now) return null;
  return r;
}

export async function applyPasswordReset(db: Db, env: Env, token: string, password: unknown, now: number) {
  const info = await resetInfo(db, token, now);
  if (!info) throw new HttpError(410, "reset_invalid", "This reset link is invalid or has expired");
  const pw = validatePassword(password, info.email);
  // Claim the link first (single use, also under concurrency).
  const claimed = await db
    .update(passwordResets)
    .set({ usedAt: now })
    .where(and(eq(passwordResets.id, info.reset.id), isNull(passwordResets.usedAt)))
    .returning({ id: passwordResets.id })
    .get();
  if (!claimed) throw new HttpError(410, "reset_invalid", "This reset link is invalid or has expired");
  const h = await makePasswordHash(env, pw);
  await db.batch([
    db.update(users).set({ ...h, passwordUpdatedAt: now, updatedAt: now }).where(eq(users.id, info.reset.userId)),
    db.delete(sessions).where(eq(sessions.userId, info.reset.userId)),
    db.delete(mfaChallenges).where(eq(mfaChallenges.userId, info.reset.userId)),
    db.update(apiTokens).set({ revokedAt: now }).where(and(eq(apiTokens.userId, info.reset.userId), isNull(apiTokens.revokedAt))),
    auditInsert(db, now, info.reset.userId, "auth.password_reset", "user", info.reset.userId),
  ]);
  return { email: info.email };
}
