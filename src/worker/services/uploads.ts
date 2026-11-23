/**
 * Upload flow (single-part presigned PUT):
 *
 *  create   -> Worker checks auth, folder, size, quota, rate; pins storage_id,
 *              staging_key and final_key in D1; returns a short-lived presigned
 *              PUT for the STAGING key only.
 *  PUT      -> browser uploads straight to R2 staging.
 *  finalize -> Worker claims a lease, HEADs staging (size), copies staging->final
 *              with x-amz-copy-source-if-match (bytes published == bytes checked),
 *              sniffs the FINAL object (immutable, client cannot write it), then
 *              inserts the file row. Idempotent and safe under concurrent retries;
 *              recovers when R2 succeeded but D1 failed (final already exists).
 */
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { files, objectDeletions, uploadSessions, type UploadSession, type User } from "../db/schema.ts";
import type { Db } from "../env.ts";
import { atomicBatch } from "../db/client.ts";
import { writableFolderId } from "../authz.ts";
import { badRequest, HttpError, notFound } from "../lib/errors.ts";
import { decideContentType, inlineCandidate, normalizeMime, SNIFF_BYTES } from "../lib/mime.ts";
import { cleanName, withSuffix } from "../lib/names.ts";
import { log } from "../lib/log.ts";
import { StorageError } from "../storage/s3.ts";
import { fileDtoFor, isUniqueViolation } from "./drive.ts";
import { bucketById, targetForNewUpload, type StorageCtx } from "./storage.ts";
import { getSettings } from "./settings.ts";
import { reserveAttempt, tooMany } from "./authn.ts";

export const PUT_URL_TTL_S = 15 * 60;
export const SESSION_TTL_MS = 2 * 3600_000;
/** Must exceed the worst-case finalize time (server-side copy of up to ~5 GiB). */
export const LEASE_MS = 5 * 60_000;
/** Staging may only be deleted once its presigned URL can no longer be used. */
const stagingSafeAfter = (s: Pick<UploadSession, "createdAt">) => s.createdAt + PUT_URL_TTL_S * 1000 + 60_000;

export async function createUpload(
  ctx: StorageCtx,
  user: User,
  input: { name?: unknown; size?: unknown; mime?: unknown; folderId?: unknown },
) {
  const { db, config, deps } = ctx;
  const now = deps.now();
  const name = cleanName(input.name);
  const size = typeof input.size === "number" ? input.size : NaN;
  if (!Number.isSafeInteger(size) || size < 0) throw badRequest("invalid_size", "Invalid file size");
  const settings = await getSettings(db, config);
  const maxUploadBytes = settings.maxUploadBytes;
  if (size > maxUploadBytes) {
    throw new HttpError(413, "file_too_large", `File exceeds the ${maxUploadBytes} byte limit`, { maxBytes: maxUploadBytes });
  }
  const declaredMime = normalizeMime(typeof input.mime === "string" ? input.mime : null);
  const folderId = await writableFolderId(db, user.id, input.folderId as string | null | undefined);

  const recent = await db
    .select({ n: sql<number>`count(*)` })
    .from(uploadSessions)
    .where(and(eq(uploadSessions.ownerId, user.id), sql`${uploadSessions.createdAt} > ${now - 3600_000}`))
    .get();
  if ((recent?.n ?? 0) >= config.uploadRatePerHour) {
    throw new HttpError(429, "rate_limited", "Too many uploads in the last hour. Try again later.");
  }

  const throttled = await db.$client
    .prepare("SELECT locked_until FROM auth_attempts WHERE scope = 'upload-rejected' AND key = ?1 AND locked_until > ?2")
    .bind(user.id, now)
    .first<{ locked_until: number }>();
  if (throttled) throw tooMany({ retryAfterMs: throttled.locked_until - now });
  const target = await targetForNewUpload(db);
  const id = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const s: UploadSession = {
    id,
    ownerId: user.id,
    folderId,
    fileId,
    name,
    declaredSize: size,
    declaredMime,
    storageId: target.id,
    stagingKey: `staging/${crypto.randomUUID()}`,
    finalKey: `files/${fileId}/${crypto.randomUUID()}`,
    state: "pending",
    leaseUntil: null,
    errorCode: null,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    completedAt: null,
  };

  // Member quota (files incl. trash + in-flight uploads) and the system-wide cap are
  // checked and reserved in ONE statement, so concurrent creates cannot overshoot.
  const cap = settings.storageCapBytes;
  const res = await db.run(sql`
    INSERT INTO upload_sessions (id, owner_id, folder_id, file_id, name, declared_size, declared_mime, storage_id,
                                 staging_key, final_key, state, created_at, expires_at)
    SELECT ${s.id}, ${s.ownerId}, ${s.folderId}, ${s.fileId}, ${s.name}, ${s.declaredSize}, ${s.declaredMime},
           ${s.storageId}, ${s.stagingKey}, ${s.finalKey}, 'pending', ${s.createdAt}, ${s.expiresAt}
    WHERE (
        (SELECT quota_unlimited FROM users WHERE id = ${user.id}) = 1
        OR (SELECT coalesce(sum(size), 0) FROM files WHERE owner_id = ${user.id})
         + (SELECT coalesce(sum(declared_size), 0) FROM upload_sessions
            WHERE owner_id = ${user.id} AND (state = 'finalizing' OR (state = 'pending' AND expires_at >= ${now})))
         + ${size} <= (SELECT quota_bytes FROM users WHERE id = ${user.id})
      )
      AND (
        ${cap} IS NULL
        OR (SELECT coalesce(sum(size), 0) FROM files)
         + (SELECT coalesce(sum(declared_size), 0) FROM upload_sessions
            WHERE state = 'finalizing' OR (state = 'pending' AND expires_at >= ${now}))
         + ${size} <= ${cap}
      )`);
  if (res.meta.changes !== 1) {
    // Rejected creates also spend a budget, so nobody can probe free space or force
    // repeated full-table sums for free.
    const budget = await reserveAttempt(db, "upload-rejected", user.id, now, 20);
    if (!budget.ok) throw tooMany(budget);
    // Tell the member which limit was hit (both are about storage, neither leaks data).
    const mine = await db.run(sql`SELECT 1 FROM users WHERE id = ${user.id} AND (quota_unlimited = 1 OR
        (SELECT coalesce(sum(size), 0) FROM files WHERE owner_id = ${user.id})
      + (SELECT coalesce(sum(declared_size), 0) FROM upload_sessions
         WHERE owner_id = ${user.id} AND (state = 'finalizing' OR (state = 'pending' AND expires_at >= ${now})))
      + ${size} <= quota_bytes)`);
    if (mine.results?.length) throw new HttpError(507, "system_storage_full", "FileNest is out of storage. Ask an Admin to free space or raise the limit.");
    throw new HttpError(413, "quota_exceeded", "Storage quota exceeded");
  }

  const contentType = declaredMime ?? "application/octet-stream";
  const bucket = await bucketById(ctx, target.id);
  // Content-Length is signed too, so the staging object cannot exceed the declared size.
  const putUrl = await bucket.presignPut(s.stagingKey, contentType, PUT_URL_TTL_S, size);
  return {
    uploadId: s.id,
    putUrl,
    putHeaders: { "Content-Type": contentType },
    expiresAt: now + PUT_URL_TTL_S * 1000,
    maxBytes: maxUploadBytes,
  };
}

function enqueueDelete(db: Db, storageId: string, key: string, reason: string, notBefore: number, now: number) {
  return db
    .insert(objectDeletions)
    .values({ id: crypto.randomUUID(), storageId, objectKey: key, reason, notBefore, attempts: 0, createdAt: now })
    .onConflictDoNothing();
}

/** Writes made by a finalizer are fenced on the exact lease it claimed. */
function holdsLease(s: UploadSession) {
  return and(eq(uploadSessions.id, s.id), eq(uploadSessions.state, "finalizing"), eq(uploadSessions.leaseUntil, s.leaseUntil ?? -1));
}

async function releaseLease(db: Db, s: UploadSession) {
  await db.update(uploadSessions).set({ state: "pending", leaseUntil: null }).where(holdsLease(s));
}

async function failSession(db: Db, s: UploadSession, code: string, now: number) {
  await db.batch([
    db.update(uploadSessions).set({ state: "failed", errorCode: code, leaseUntil: null }).where(holdsLease(s)),
    enqueueDelete(db, s.storageId, s.stagingKey, "failed_upload", Math.max(now, stagingSafeAfter(s)), now),
    enqueueDelete(db, s.storageId, s.finalKey, "failed_upload", now, now),
  ]);
}

export type FinalizeResult =
  | { status: "completed"; file: Awaited<ReturnType<typeof fileDtoFor>> }
  | { status: "in_progress" };

export async function finalizeUpload(ctx: StorageCtx, user: User, uploadId: string): Promise<FinalizeResult> {
  const { db, deps } = ctx;
  const now = deps.now();
  const s = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.ownerId, user.id)))
    .get();
  if (!s) throw notFound(); // also: not the owner

  if (s.state === "completed") return { status: "completed", file: await fileDtoFor(db, user.id, s.fileId) };
  if (s.state === "failed") throw new HttpError(422, s.errorCode ?? "upload_failed", "Upload failed verification");
  if (s.state === "expired" || s.state === "aborted") throw new HttpError(410, `upload_${s.state}`, "Upload session is no longer valid");
  if (s.expiresAt < now) {
    await expireSession(db, s, now);
    throw new HttpError(410, "upload_expired", "Upload session expired");
  }

  // Claim a lease. Only one finalizer runs at a time; a crashed one is taken over after LEASE_MS.
  const claimed = await db
    .update(uploadSessions)
    .set({ state: "finalizing", leaseUntil: now + LEASE_MS })
    .where(
      and(
        eq(uploadSessions.id, s.id),
        eq(uploadSessions.ownerId, user.id),
        or(eq(uploadSessions.state, "pending"), and(eq(uploadSessions.state, "finalizing"), lt(uploadSessions.leaseUntil, now))),
      ),
    )
    .returning()
    .get();
  if (!claimed) {
    const again = await db.select().from(uploadSessions).where(eq(uploadSessions.id, s.id)).get();
    if (again?.state === "completed") return { status: "completed", file: await fileDtoFor(db, user.id, again.fileId) };
    if (again?.state === "finalizing") return { status: "in_progress" };
    throw new HttpError(409, "upload_state_changed", "Upload state changed; retry");
  }

  try {
    return await runFinalize(ctx, user, claimed, now);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const current = await db.select().from(uploadSessions).where(eq(uploadSessions.id, claimed.id)).get();
    if (current && (current.state !== "finalizing" || current.leaseUntil !== claimed.leaseUntil)) {
      // We lost the lease (expired by cleanup or taken over): report state, not a storage fault.
      if (current.state === "expired") throw new HttpError(410, "upload_expired", "Upload session expired");
      throw new HttpError(409, "upload_state_changed", "Upload state changed; retry");
    }
    // Unexpected/storage error: hand the session back so the client can retry.
    await releaseLease(db, claimed);
    if (e instanceof StorageError) {
      log.warn("upload.finalize_storage_error", { op: e.op, status: e.status });
      throw new HttpError(502, "storage_unavailable", "Storage is unavailable; retry");
    }
    throw e;
  }
}

async function runFinalize(ctx: StorageCtx, user: User, s: UploadSession, now: number): Promise<FinalizeResult> {
  const { db } = ctx;
  // Destination folder must still be writable by the owner.
  let folderId: string | null;
  try {
    folderId = await writableFolderId(db, user.id, s.folderId);
  } catch {
    await failSession(db, s, "folder_unavailable", now);
    throw new HttpError(409, "folder_unavailable", "The destination folder no longer exists");
  }
  if (s.folderId && !folderId) {
    await failSession(db, s, "folder_unavailable", now);
    throw new HttpError(409, "folder_unavailable", "The destination folder no longer exists");
  }

  const bucket = await bucketById(ctx, s.storageId); // pinned target, never the current default

  let finalHead = await bucket.head(s.finalKey);
  if (!finalHead) {
    const staging = await bucket.head(s.stagingKey);
    if (!staging) {
      await releaseLease(db, s);
      throw new HttpError(409, "upload_incomplete", "The file has not finished uploading");
    }
    if (staging.size !== s.declaredSize) {
      await failSession(db, s, "size_mismatch", now);
      throw new HttpError(422, "size_mismatch", "Uploaded size does not match the declared size");
    }
    const copied = await bucket.copyIfMatch(s.stagingKey, s.finalKey, staging.etag);
    if (copied === "precondition_failed") {
      await releaseLease(db, s);
      throw new HttpError(409, "staging_changed", "The upload changed during verification; retry");
    }
    finalHead = await bucket.head(s.finalKey);
    if (!finalHead) throw new StorageError("head_final", 404);
  }
  if (finalHead.size !== s.declaredSize) {
    await failSession(db, s, "size_mismatch", now);
    throw new HttpError(422, "size_mismatch", "Uploaded size does not match the declared size");
  }

  // Sniff the FINAL object: immutable from the client's point of view.
  let head: Uint8Array | null = null;
  if (inlineCandidate(s.name, s.declaredMime)) {
    head = await bucket.readHead(s.finalKey, SNIFF_BYTES, finalHead.etag, finalHead.size);
  }
  const { contentType, inlineOk } = decideContentType(s.name, s.declaredMime, head);

  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = attempt === 1 ? s.name : withSuffix(s.name, attempt);
    let completed = false;
    try {
      // Fenced: the row is inserted and the session completed only if we still
      // hold the exact lease we claimed (cleanup or another finalizer may have
      // taken over or expired the session in the meantime).
      const results = await atomicBatch(db.$client, [
        sql`INSERT INTO files (id, owner_id, folder_id, name, size, mime_declared, content_type, inline_ok, storage_id,
                               object_key, etag, upload_session_id, created_at, updated_at)
            SELECT ${s.fileId}, ${s.ownerId}, ${folderId}, ${name}, ${finalHead.size}, ${s.declaredMime}, ${contentType},
                   ${inlineOk ? 1 : 0}, ${s.storageId}, ${s.finalKey}, ${finalHead.etag}, ${s.id}, ${now}, ${now}
            WHERE EXISTS (SELECT 1 FROM upload_sessions WHERE id = ${s.id} AND state = 'finalizing' AND lease_until = ${s.leaseUntil})
            ON CONFLICT (upload_session_id) DO NOTHING`,
        db
          .update(uploadSessions)
          .set({ state: "completed", completedAt: now, leaseUntil: null })
          .where(holdsLease(s)),
        enqueueDelete(db, s.storageId, s.stagingKey, "staging_done", Math.max(now, stagingSafeAfter(s)), now),
      ]);
      completed = (results[1]?.meta.changes ?? 0) === 1;
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 20) continue; // name taken in folder -> "name (2)"
      throw e;
    }
    if (!completed) {
      const again = await db.select().from(uploadSessions).where(eq(uploadSessions.id, s.id)).get();
      if (again?.state === "completed") break; // another finalizer won; same file
      throw new HttpError(409, "upload_state_changed", "Upload state changed during finalize; retry");
    }
    break;
  }
  return { status: "completed", file: await fileDtoFor(db, user.id, s.fileId) };
}

export async function abortUpload(ctx: StorageCtx, user: User, uploadId: string) {
  const { db, deps } = ctx;
  const now = deps.now();
  const s = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.ownerId, user.id)))
    .get();
  if (!s) throw notFound();
  if (s.state !== "pending") return { state: s.state };
  await db.batch([
    db
      .update(uploadSessions)
      .set({ state: "aborted" })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.state, "pending"))),
    enqueueDelete(db, s.storageId, s.stagingKey, "aborted", Math.max(now, stagingSafeAfter(s)), now),
  ]);
  return { state: "aborted" };
}

export async function expireSession(db: Db, s: UploadSession, now: number) {
  await db.batch([
    db
      .update(uploadSessions)
      .set({ state: "expired", leaseUntil: null })
      .where(and(eq(uploadSessions.id, s.id), inArray(uploadSessions.state, ["pending", "finalizing"]))),
    enqueueDelete(db, s.storageId, s.stagingKey, "expired", Math.max(now, stagingSafeAfter(s)), now),
    // The final key is only deleted if no file row references it (re-checked by the
    // job), and only after any finalizer's lease could have run out.
    enqueueDelete(db, s.storageId, s.finalKey, "expired", now + LEASE_MS + 60_000, now),
  ]);
}
