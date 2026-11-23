import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fileShares, files, shareLinks, users, type FileRow, type User } from "../db/schema.ts";
import type { Db, Env } from "../env.ts";
import { fileFor } from "../authz.ts";
import { badRequest, HttpError, notFound } from "../lib/errors.ts";
import { decryptString, encryptString, randomToken, sha256Hex } from "../lib/crypto.ts";
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
    publicLink: link ? { url: url!, createdAt: link.createdAt } : null,
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

/** Resolve a public token to an active, non-trashed file. Checked on EVERY request (no cache). */
export async function fileForToken(db: Db, token: string): Promise<FileRow> {
  if (!SHARE_TOKEN_RE.test(token)) throw notFound();
  const hash = await sha256Hex(token);
  const row = await db
    .select({ f: files })
    .from(shareLinks)
    .innerJoin(files, eq(files.id, shareLinks.fileId))
    .innerJoin(users, eq(users.id, files.ownerId))
    .where(and(eq(shareLinks.tokenHash, hash), isNull(shareLinks.revokedAt), isNull(files.trashedAt), sql`${users.status} <> 'disabled'`))
    .get();
  if (!row) throw notFound();
  return row.f;
}
