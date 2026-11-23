import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fileShares, files, shareLinks, shareUnlockAttempts, users, type FileRow, type User } from "../db/schema.ts";
export type ShareLink = typeof shareLinks.$inferSelect;
import type { Db, Env } from "../env.ts";
import { fileFor } from "../authz.ts";
import { badRequest, HttpError, notFound } from "../lib/errors.ts";
import { base64url, decryptString, encryptString, hashPassword, hmacSign, randomBytes, randomToken, sha256Hex, timingSafeEqual, verifyPassword } from "../lib/crypto.ts";
import { auditInsert } from "./audit.ts";

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_SHARES = 100;

function encKey(env: Env): string {
  const k = env.APP_ENCRYPTION_KEY;
  if (!k) throw new HttpError(500, "not_configured", "Server is not configured for share links");
  return k;
}

export async function getSharing(db: Db, env: Env, owner: User, fileId: string, origin: string) {
  const file = await fileFor(db, owner.id, fileId, "manage");
  const members = await db
    .select({ id: users.id, email: users.email, name: users.name, grantedAt: fileShares.createdAt })
    .from(fileShares)
    .innerJoin(users, eq(users.id, fileShares.userId))
    .where(eq(fileShares.fileId, file.id));
  const link = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.fileId, file.id), isNull(shareLinks.revokedAt)))
    .get();
  let url: string | null = null;
  if (link) url = `${origin}/s/${await decryptString(encKey(env), link.tokenEnc, link.id)}`;
  return {
    fileId: file.id,
    visibility: link ? ("public" as const) : ("private" as const),
    members,
    publicLink: link ? { url: url!, createdAt: link.createdAt, passwordProtected: !!link.passwordHash } : null,
  };
}

/** Replace the set of members a file is shared with (read + download). */
export async function setMemberShares(db: Db, owner: User, fileId: string, userIds: unknown, now: number) {
  const file = await fileFor(db, owner.id, fileId, "manage");
  if (!Array.isArray(userIds) || userIds.length > MAX_SHARES || !userIds.every((x) => typeof x === "string")) {
    throw badRequest("invalid_members");
  }
  const wanted = [...new Set(userIds as string[])].filter((id) => id !== owner.id);
  if (wanted.length) {
    const valid = await db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, wanted), sql`${users.status} <> 'disabled'`));
    if (valid.length !== wanted.length) throw badRequest("invalid_members", "Unknown or disabled member");
  }
  const current = (await db.select({ userId: fileShares.userId }).from(fileShares).where(eq(fileShares.fileId, file.id))).map(
    (r) => r.userId,
  );
  const add = wanted.filter((id) => !current.includes(id));
  const remove = current.filter((id) => !wanted.includes(id));
  const stmts = [];
  for (const uid of add) {
    stmts.push(db.insert(fileShares).values({ fileId: file.id, userId: uid, grantedBy: owner.id, createdAt: now }).onConflictDoNothing());
    stmts.push(auditInsert(db, now, owner.id, "share.member_grant", "file", file.id, { userId: uid }));
  }
  for (const uid of remove) {
    stmts.push(db.delete(fileShares).where(and(eq(fileShares.fileId, file.id), eq(fileShares.userId, uid))));
    stmts.push(auditInsert(db, now, owner.id, "share.member_revoke", "file", file.id, { userId: uid }));
  }
  if (stmts.length) await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  return { added: add.length, removed: remove.length };
}

export async function createPublicLink(db: Db, env: Env, owner: User, fileId: string, origin: string, now: number) {
  const file = await fileFor(db, owner.id, fileId, "manage");
  const existing = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.fileId, file.id), isNull(shareLinks.revokedAt)))
    .get();
  if (existing) return { url: `${origin}/s/${await decryptString(encKey(env), existing.tokenEnc, existing.id)}`, created: false };
  const token = randomToken(32); // 43 chars base64url
  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(shareLinks).values({
        id,
        fileId: file.id,
        tokenHash: await sha256Hex(token),
        tokenEnc: await encryptString(encKey(env), token, id),
        createdBy: owner.id,
        createdAt: now,
        revokedAt: null,
        revokedBy: null,
        passwordHash: null,
        passwordSalt: null,
        passwordVersion: 0,
      }),
      auditInsert(db, now, owner.id, "share.link_create", "file", file.id, { linkId: id }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return createPublicLink(db, env, owner, fileId, origin, now); // concurrent create
    throw e;
  }
  return { url: `${origin}/s/${token}`, created: true };
}

export async function revokePublicLink(db: Db, owner: User, fileId: string, now: number) {
  const file = await fileFor(db, owner.id, fileId, "manage");
  const link = await db
    .select({ id: shareLinks.id })
    .from(shareLinks)
    .where(and(eq(shareLinks.fileId, file.id), isNull(shareLinks.revokedAt)))
    .get();
  if (!link) return { revoked: false };
  await db.batch([
    db.update(shareLinks).set({ revokedAt: now, revokedBy: owner.id }).where(eq(shareLinks.id, link.id)),
    auditInsert(db, now, owner.id, "share.link_revoke", "file", file.id, { linkId: link.id }),
  ]);
  return { revoked: true };
}

/** Resolve a public token to an active, non-trashed file and its link. Checked on EVERY request (no cache). */
export async function linkForToken(db: Db, token: string): Promise<{ file: FileRow; link: ShareLink }> {
  if (!SHARE_TOKEN_RE.test(token)) throw notFound();
  const hash = await sha256Hex(token);
  const row = await db
    .select({ f: files, l: shareLinks })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .innerJoin(users, eq(users.id, files.ownerId))
    .where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt), isNull(files.trashedAt), sql`${users.status} <> 'disabled'`))
    .get();
  if (!row) throw notFound();
  return { file: row.f, link: row.l };
}

export async function fileForToken(db: Db, token: string): Promise<FileRow> {
  return (await linkForToken(db, token)).file;
}

// ---------- password-protected links ----------

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const UNLOCK_TTL_MS = 12 * 3600_000;
export const FREE_ATTEMPTS = 5;
const MAX_LOCK_MS = 15 * 60_000;

/** Set (string) or clear (null) the password on the file's active public link. */
export async function setLinkPassword(db: Db, owner: User, fileId: string, password: unknown, now: number) {
  const file = await fileFor(db, owner.id, fileId, "manage");
  const link = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.fileId, file.id), isNull(shareLinks.revokedAt)))
    .get();
  if (!link) throw new HttpError(409, "no_public_link", "Create a public link first");
  if (password === null) {
    await db.batch([
      db
        .update(shareLinks)
        .set({ passwordHash: null, passwordSalt: null, passwordVersion: link.passwordVersion + 1 })
        .where(eq(shareLinks.id, link.id)),
      db.delete(shareUnlockAttempts).where(eq(shareUnlockAttempts.linkId, link.id)),
      auditInsert(db, now, owner.id, "share.link_password_clear", "file", file.id, { linkId: link.id }),
    ]);
    return;
  }
  if (typeof password !== "string" || [...password].length < PASSWORD_MIN || [...password].length > PASSWORD_MAX) {
    throw badRequest("invalid_password", `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`);
  }
  const salt = base64url(randomBytes(16));
  const hash = await hashPassword(password, salt);
  await db.batch([
    db
      .update(shareLinks)
      .set({ passwordHash: hash, passwordSalt: salt, passwordVersion: link.passwordVersion + 1 })
      .where(eq(shareLinks.id, link.id)),
    db.delete(shareUnlockAttempts).where(eq(shareUnlockAttempts.linkId, link.id)),
    auditInsert(db, now, owner.id, "share.link_password_set", "file", file.id, { linkId: link.id }),
  ]);
}

export type UnlockResult = { ok: true } | { ok: false; reason: "wrong"; remaining: number } | { ok: false; reason: "locked"; retryAfterMs: number };

/** Counters for a client are forgotten after a quiet day. */
const ATTEMPT_DECAY_MS = 24 * 3600_000;

/** Opaque per-link client key: SHA-256(link id + client IP). Raw IPs are never stored. */
export async function unlockClientKey(linkId: string, clientIp: string | null | undefined): Promise<string> {
  return (await sha256Hex(`${linkId}|${clientIp ?? "unknown"}`)).slice(0, 32);
}

/**
 * Verify a password attempt with a per-(link, client) budget: 5 attempts, then a
 * lock of 1, 2, 4… up to 15 minutes. The attempt is RESERVED atomically before
 * PBKDF2 runs, so concurrent requests cannot exceed the budget.
 */
export async function attemptUnlock(db: Db, link: ShareLink, clientKey: string, password: string, now: number): Promise<UnlockResult> {
  const reserved = await db.$client
    .prepare(
      `INSERT INTO share_unlock_attempts (link_id, client_key, failed_attempts, locked_until, updated_at)
       VALUES (?1, ?2, 1, CASE WHEN 1 >= ?3 THEN ?4 + 60000 ELSE NULL END, ?4)
       ON CONFLICT (link_id, client_key) DO UPDATE SET
         failed_attempts = CASE WHEN updated_at < ?4 - ?6 THEN 1 ELSE failed_attempts + 1 END,
         locked_until = CASE
           WHEN (CASE WHEN updated_at < ?4 - ?6 THEN 1 ELSE failed_attempts + 1 END) >= ?3
           THEN ?4 + min(?5, 60000 * (1 << min((CASE WHEN updated_at < ?4 - ?6 THEN 1 ELSE failed_attempts + 1 END) - ?3, 10)))
           ELSE NULL END,
         updated_at = ?4
       WHERE share_unlock_attempts.locked_until IS NULL OR share_unlock_attempts.locked_until <= ?4
       RETURNING failed_attempts, locked_until`,
    )
    .bind(link.id, clientKey, FREE_ATTEMPTS, now, MAX_LOCK_MS, ATTEMPT_DECAY_MS)
    .first<{ failed_attempts: number; locked_until: number | null }>();
  if (!reserved) {
    const cur = await db
      .select({ lockedUntil: shareUnlockAttempts.lockedUntil })
      .from(shareUnlockAttempts)
      .where(and(eq(shareUnlockAttempts.linkId, link.id), eq(shareUnlockAttempts.clientKey, clientKey)))
      .get();
    return { ok: false, reason: "locked", retryAfterMs: Math.max(1000, (cur?.lockedUntil ?? now + 60_000) - now) };
  }
  const good =
    !!link.passwordHash && !!link.passwordSalt && password.length <= PASSWORD_MAX * 4 && (await verifyPassword(password, link.passwordSalt, link.passwordHash));
  if (good) {
    await db
      .delete(shareUnlockAttempts)
      .where(and(eq(shareUnlockAttempts.linkId, link.id), eq(shareUnlockAttempts.clientKey, clientKey)));
    return { ok: true };
  }
  if (reserved.locked_until && reserved.locked_until > now) return { ok: false, reason: "locked", retryAfterMs: reserved.locked_until - now };
  return { ok: false, reason: "wrong", remaining: Math.max(0, FREE_ATTEMPTS - reserved.failed_attempts) };
}

/** Unlock cookie value: "<linkId>.<version>.<expiresAt>.<hmac>" */
export async function makeUnlockCookie(env: Env, link: ShareLink, now: number): Promise<string> {
  const body = `${link.id}.${link.passwordVersion}.${now + UNLOCK_TTL_MS}`;
  return `${body}.${await hmacSign(encKey(env), "share-unlock", body)}`;
}

export async function isUnlocked(env: Env, link: ShareLink, cookie: string | undefined, now: number): Promise<boolean> {
  if (!link.passwordHash) return true;
  if (!cookie || cookie.length > 300) return false;
  const parts = cookie.split(".");
  if (parts.length !== 4) return false;
  const [id, version, exp, sig] = parts as [string, string, string, string];
  if (id !== link.id || Number(version) !== link.passwordVersion || !(Number(exp) > now)) return false;
  return timingSafeEqual(await hmacSign(encKey(env), "share-unlock", `${id}.${version}.${exp}`), sig);
}
