/**
 * Large files (>= multipartThresholdBytes, client opted in) use R2 multipart instead:
 *
 *  create   -> same placement/quota statement; R2 CreateMultipartUpload at FINAL_key.
 *  parts    -> per-part presigned PUTs (exact length signed), requested in batches;
 *              resumable after a reload: the client re-selects the file and must
 *              present the same fingerprint (SHA-256 of first+last MiB).
 *  finalize -> lease-claim -> ListParts from R2 (never the client's list): every part
 *              1..partCount present with the planned sizes -> Complete with exactly
 *              those ETags (a part re-uploaded meanwhile fails Complete) -> HEAD final
 *              -> sniff -> insert row. Same idempotency/recovery as below.
 *
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
import { files, multipartAborts, objectDeletions, uploadSessions, type UploadSession, type User } from "../db/schema.ts";
import { MAX_PARTS, SINGLE_PUT_LIMIT, type Db } from "../env.ts";
import { atomicBatch } from "../db/client.ts";
import { writableFolderId } from "../authz.ts";
import { badRequest, HttpError, notFound } from "../lib/errors.ts";
import { decideContentType, inlineCandidate, normalizeMime, SNIFF_BYTES } from "../lib/mime.ts";
import { cleanName, withSuffix } from "../lib/names.ts";
import { log } from "../lib/log.ts";
import { StorageError, type UploadedPart } from "../storage/s3.ts";
import { fileDtoFor, isUniqueViolation } from "./drive.ts";
import { bucketById, liveReservation, RESERVATION_GRACE_MS, URL_TTL_S, type StorageCtx } from "./storage.ts";
import { getSettings } from "./settings.ts";
import { reserveAttempt, tooMany } from "./authn.ts";

export const PUT_URL_TTL_S = URL_TTL_S;
export const SESSION_TTL_MS = 2 * 3600_000;
/** Multipart sessions live 24 h, extended by each parts request, never past 7 days. */
export const MULTIPART_TTL_MS = 24 * 3600_000;
export const MULTIPART_MAX_AGE_MS = 7 * 24 * 3600_000;
export const MAX_PARTS_PER_REQUEST = 100;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Plan parts so every part but the last has the same size (R2) and there are at most 10,000. */
export function planParts(size: number, basePart: number) {
  const partSize = Math.max(basePart, Math.ceil(size / MAX_PARTS));
  return { partSize, partCount: Math.max(1, Math.ceil(size / partSize)) };
}
const partLength = (s: Pick<UploadSession, "declaredSize" | "partSize" | "partCount">, n: number) =>
  n < s.partCount! ? s.partSize! : s.declaredSize - s.partSize! * (s.partCount! - 1);
/** Must exceed the worst-case finalize time (server-side copy of up to ~5 GiB). */
export const LEASE_MS = 5 * 60_000;
/** Staging may only be deleted once its presigned URL can no longer be used. */
const stagingSafeAfter = (s: Pick<UploadSession, "createdAt">) => s.createdAt + PUT_URL_TTL_S * 1000 + 60_000;

export async function createUpload(
  ctx: StorageCtx,
  user: User,
  input: { name?: unknown; size?: unknown; mime?: unknown; folderId?: unknown; multipart?: unknown; fingerprint?: unknown },
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
  // Clients opt in to multipart (older clients only know the single PUT).
  const multipart = input.multipart === true && size > 0 && size >= config.multipartThresholdBytes;
  if (!multipart && size > SINGLE_PUT_LIMIT) {
    throw new HttpError(413, "multipart_required", "Files over 5 GB need a client that supports multipart uploads");
  }
  const fingerprint = multipart ? input.fingerprint : null;
  if (multipart && (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint))) {
    throw badRequest("invalid_fingerprint", "A file fingerprint is required for large uploads");
  }
  const plan = multipart ? planParts(size, config.multipartPartBytes) : null;
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
  const id = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const s = {
    id,
    fileId,
    stagingKey: `staging/${crypto.randomUUID()}`,
    finalKey: `files/${fileId}/${crypto.randomUUID()}`,
    expiresAt: now + (multipart ? MULTIPART_TTL_MS : SESSION_TTL_MS),
  };
  const live = liveReservation(now);

  // ONE statement picks the storage target and reserves the space:
  //  - target: first by priority that accepts uploads, has not failed its last health
  //    check, and has room (capacity - stored files - live reservations >= size)
  //  - member: quota (files incl. trash + live reservations) unless unlimited
  // so concurrent creates can never overfill a target or a member's quota.
  const placed = await db.get<{ storage_id: string }>(sql`
    WITH pick AS (
      SELECT t.id AS id FROM storage_targets t
      WHERE t.accepting_uploads = 1 AND (t.last_check_ok IS NULL OR t.last_check_ok = 1)
        AND (t.capacity_bytes IS NULL OR
             (SELECT coalesce(sum(f.size), 0) FROM files f WHERE f.storage_id = t.id)
           + (SELECT coalesce(sum(us.declared_size), 0) FROM upload_sessions us WHERE us.storage_id = t.id AND ${live})
           + ${size} <= t.capacity_bytes)
      ORDER BY t.priority, t.created_at, t.id
      LIMIT 1
    )
    INSERT INTO upload_sessions (id, owner_id, folder_id, file_id, name, declared_size, declared_mime, storage_id,
                                 staging_key, final_key, state, created_at, expires_at, part_size, part_count, fingerprint)
    SELECT ${s.id}, ${user.id}, ${folderId}, ${s.fileId}, ${name}, ${size}, ${declaredMime},
           pick.id, ${s.stagingKey}, ${s.finalKey}, 'pending', ${now}, ${s.expiresAt},
           ${plan?.partSize ?? null}, ${plan?.partCount ?? null}, ${multipart ? (fingerprint as string) : null}
    FROM pick
    WHERE (SELECT quota_unlimited FROM users WHERE id = ${user.id}) = 1
       OR (SELECT coalesce(sum(size), 0) FROM files WHERE owner_id = ${user.id})
        + (SELECT coalesce(sum(declared_size), 0) FROM upload_sessions WHERE owner_id = ${user.id} AND ${live})
        + ${size} <= (SELECT quota_bytes FROM users WHERE id = ${user.id})
    RETURNING storage_id`);

  if (!placed) {
    // Rejected creates also spend a budget, so nobody can probe free space or force
    // repeated full-table sums for free.
    const budget = await reserveAttempt(db, "upload-rejected", user.id, now, 20);
    if (!budget.ok) throw tooMany(budget);
    const mine = await db.run(sql`SELECT 1 FROM users WHERE id = ${user.id} AND (quota_unlimited = 1 OR
        (SELECT coalesce(sum(size), 0) FROM files WHERE owner_id = ${user.id})
      + (SELECT coalesce(sum(declared_size), 0) FROM upload_sessions WHERE owner_id = ${user.id} AND ${live})
      + ${size} <= quota_bytes)`);
    if (!mine.results?.length) throw new HttpError(413, "quota_exceeded", "Storage quota exceeded");
    const eligible = await db.get<{ n: number }>(sql`SELECT count(*) AS n FROM storage_targets
      WHERE accepting_uploads = 1 AND (last_check_ok IS NULL OR last_check_ok = 1)`);
    if (!eligible?.n) throw new HttpError(503, "no_storage_accepting", "No storage is accepting uploads. Ask an Admin to configure storage.");
    // A single file cannot be split across buckets.
    throw new HttpError(507, "storage_full", "No storage location has room for a file this size. Ask an Admin to add capacity.");
  }
  const storageId = placed.storage_id;

  const contentType = declaredMime ?? "application/octet-stream";
  const bucket = await bucketById(ctx, storageId);
  if (plan) {
    let multipartId: string;
    try {
      // The object's R2 Content-Type is never trusted (content is served by the Worker).
    multipartId = await bucket.createMultipart(s.finalKey, "application/octet-stream");
    } catch (e) {
      // Release the reservation; nothing was stored yet.
      await db.update(uploadSessions).set({ state: "failed", errorCode: "storage_unavailable" }).where(eq(uploadSessions.id, s.id));
      if (e instanceof StorageError) throw new HttpError(502, "storage_unavailable", "Storage is unavailable; retry");
      throw e;
    }
    try {
      await db.update(uploadSessions).set({ multipartId }).where(eq(uploadSessions.id, s.id));
    } catch (e) {
      // Never leave an R2 upload nobody knows about, nor a reservation without one.
      await bucket.abortMultipart(s.finalKey, multipartId).catch(() => {});
      await db.update(uploadSessions).set({ state: "failed", errorCode: "storage_unavailable" }).where(eq(uploadSessions.id, s.id)).catch(() => {});
      throw e;
    }
    return { uploadId: s.id, mode: "multipart" as const, partSize: plan.partSize, partCount: plan.partCount, expiresAt: s.expiresAt, maxBytes: maxUploadBytes };
  }
  // Content-Length is signed too, so the staging object cannot exceed the declared size.
  const putUrl = await bucket.presignPut(s.stagingKey, contentType, PUT_URL_TTL_S, size);
  return {
    uploadId: s.id,
    mode: "single" as const,
    putUrl,
    putHeaders: { "Content-Type": contentType },
    expiresAt: now + PUT_URL_TTL_S * 1000,
    maxBytes: maxUploadBytes,
  };
}

async function ownSession(db: Db, user: User, uploadId: string) {
  const s = await db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.ownerId, user.id)))
    .get();
  if (!s) throw notFound(); // also: not the owner
  return s;
}

/** A multipart session that can still receive parts. */
async function openMultipart(ctx: StorageCtx, user: User, uploadId: string) {
  const now = ctx.deps.now();
  const s = await ownSession(ctx.db, user, uploadId);
  if (!s.multipartId || !s.partSize || !s.partCount) throw notFound();
  if (s.state === "completed") throw new HttpError(409, "upload_completed", "This upload is already complete");
  if (s.state !== "pending") throw new HttpError(410, `upload_${s.state === "finalizing" ? "finalizing" : "closed"}`, "Upload session is no longer accepting parts");
  if (s.expiresAt < now) {
    await expireSession(ctx.db, s, now);
    throw new HttpError(410, "upload_expired", "Upload session expired");
  }
  return { s, now };
}

/** Presigned PUTs for some parts. The caller must present the file fingerprint given at create. */
export async function presignParts(ctx: StorageCtx, user: User, uploadId: string, input: { parts?: unknown; fingerprint?: unknown }) {
  const { s, now } = await openMultipart(ctx, user, uploadId);
  if (typeof input.fingerprint !== "string" || input.fingerprint !== s.fingerprint) {
    throw new HttpError(409, "file_mismatch", "This is not the same file that this upload started with");
  }
  const parts = input.parts;
  if (
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > MAX_PARTS_PER_REQUEST ||
    new Set(parts).size !== parts.length ||
    !parts.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= s.partCount!)
  ) {
    throw badRequest("invalid_parts", `Request 1–${MAX_PARTS_PER_REQUEST} distinct part numbers between 1 and ${s.partCount}`);
  }
  // Keep an active upload alive, but never past the maximum age.
  const expiresAt = Math.min(s.createdAt + MULTIPART_MAX_AGE_MS, now + MULTIPART_TTL_MS);
  if (expiresAt > s.expiresAt) {
    await ctx.db
      .update(uploadSessions)
      .set({ expiresAt })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.state, "pending")));
  }
  const bucket = await bucketById(ctx, s.storageId);
  const urls = await Promise.all(
    (parts as number[]).map(async (n) => ({ part: n, size: partLength(s, n), url: await bucket.presignPart(s.finalKey, s.multipartId!, n, partLength(s, n), PUT_URL_TTL_S) })),
  );
  return { urls, urlExpiresAt: now + PUT_URL_TTL_S * 1000, expiresAt: Math.max(expiresAt, s.expiresAt) };
}

/** Parts R2 already holds (sizes only), so a client can resume. */
/** Listing parts costs R2 requests: a generous per-member budget stops amplification. */
async function listBudget(db: Db, user: User, now: number) {
  const budget = await reserveAttempt(db, "upload-list", user.id, now, 2000);
  if (!budget.ok) throw tooMany(budget);
}

export async function uploadedParts(ctx: StorageCtx, user: User, uploadId: string) {
  const { s, now } = await openMultipart(ctx, user, uploadId);
  await listBudget(ctx.db, user, now);
  const bucket = await bucketById(ctx, s.storageId);
  let parts: UploadedPart[] | null;
  try {
    parts = await bucket.listParts(s.finalKey, s.multipartId!);
  } catch (e) {
    if (e instanceof StorageError) throw new HttpError(502, "storage_unavailable", "Storage is unavailable; retry");
    throw e;
  }
  if (!parts) throw new HttpError(410, "upload_closed", "Upload session is no longer accepting parts");
  return {
    size: s.declaredSize,
    partSize: s.partSize!,
    partCount: s.partCount!,
    expiresAt: s.expiresAt,
    // Only parts with the planned length count; anything else gets uploaded again.
    parts: parts.filter((p) => p.part <= s.partCount! && p.size === partLength(s, p.part)).map((p) => ({ part: p.part, size: p.size })),
  };
}

/** The member's unfinished large uploads (to resume after a reload). */
export async function resumableUploads(ctx: StorageCtx, user: User) {
  const now = ctx.deps.now();
  const rows = await ctx.db
    .select()
    .from(uploadSessions)
    .where(and(eq(uploadSessions.ownerId, user.id), eq(uploadSessions.state, "pending"), sql`${uploadSessions.multipartId} IS NOT NULL`, sql`${uploadSessions.expiresAt} >= ${now}`))
    .orderBy(sql`${uploadSessions.createdAt} DESC`)
    .limit(50);
  return {
    uploads: rows.map((s) => ({
      uploadId: s.id,
      name: s.name,
      size: s.declaredSize,
      mime: s.declaredMime,
      folderId: s.folderId,
      partSize: s.partSize!,
      partCount: s.partCount!,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    })),
  };
}

/** Abort in R2 once no part URL can be used any more (a part in flight could otherwise land after an abort). */
function enqueueAbort(db: Db, s: UploadSession, now: number) {
  return db
    .insert(multipartAborts)
    .values({ multipartId: s.multipartId!, storageId: s.storageId, objectKey: s.finalKey, notBefore: now + RESERVATION_GRACE_MS, attempts: 0, createdAt: now })
    .onConflictDoNothing();
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
    db.update(uploadSessions).set({ state: "failed", errorCode: code, leaseUntil: null, closedAt: now }).where(holdsLease(s)),
    enqueueDelete(db, s.storageId, s.stagingKey, "failed_upload", Math.max(now, stagingSafeAfter(s)), now),
    enqueueDelete(db, s.storageId, s.finalKey, "failed_upload", now, now),
    ...(s.multipartId ? [enqueueAbort(db, s, now)] : []),
  ]);
}

/**
 * Multipart: verify the parts R2 holds against the plan, then complete with
 * exactly those ETags. Returns false (lease released) when parts are missing.
 */
async function completeFromParts(bucket: Awaited<ReturnType<typeof bucketById>>, db: Db, s: UploadSession, now: number) {
  const parts = await bucket.listParts(s.finalKey, s.multipartId!);
  if (!parts) {
    await failSession(db, s, "upload_missing", now);
    throw new HttpError(410, "upload_missing", "The uploaded parts are no longer available; upload the file again");
  }
  const byNumber = new Map(parts.map((p) => [p.part, p]));
  const plan: UploadedPart[] = [];
  for (let n = 1; n <= s.partCount!; n++) {
    const p = byNumber.get(n);
    if (!p || p.size !== partLength(s, n)) {
      // Missing, or a wrong length (lengths are signed, so this is an interrupted or
      // tampered part): the client re-uploads that part and finalizes again.
      await releaseLease(db, s);
      throw new HttpError(409, "upload_incomplete", "The file has not finished uploading");
    }
    plan.push(p);
  }
  if (parts.length !== s.partCount) {
    await failSession(db, s, "size_mismatch", now);
    throw new HttpError(422, "size_mismatch", "Uploaded size does not match the declared size");
  }
  const r = await bucket.completeMultipart(s.finalKey, s.multipartId!, plan);
  if (r === "too_small") {
    // Configuration error (MULTIPART_PART_BYTES below R2's 5 MiB): retrying cannot help.
    log.error("upload.part_too_small", { partSize: s.partSize });
    await failSession(db, s, "part_too_small", now);
    throw new HttpError(422, "part_too_small", "Storage rejected the part size; ask an Admin to check the upload settings");
  }
  if (r === "invalid_part") {
    await releaseLease(db, s);
    throw new HttpError(409, "staging_changed", "The upload changed during verification; retry");
  }
  if (r === "no_such_upload" && !(await bucket.head(s.finalKey))) {
    await failSession(db, s, "upload_missing", now);
    throw new HttpError(410, "upload_missing", "The uploaded parts are no longer available; upload the file again");
  }
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
  if (!finalHead && s.multipartId) {
    try {
      await listBudget(db, user, now);
    } catch (e) {
      await releaseLease(db, s);
      throw e;
    }
    await completeFromParts(bucket, db, s, now);
    finalHead = await bucket.head(s.finalKey);
    if (!finalHead) throw new StorageError("head_final", 404);
  } else if (!finalHead) {
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
        // Multipart sessions never wrote their staging key.
        s.multipartId
          ? sql`SELECT 1`
          : enqueueDelete(db, s.storageId, s.stagingKey, "staging_done", Math.max(now, stagingSafeAfter(s)), now),
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
      .set({ state: "aborted", closedAt: now })
      .where(and(eq(uploadSessions.id, s.id), eq(uploadSessions.state, "pending"))),
    enqueueDelete(db, s.storageId, s.stagingKey, "aborted", Math.max(now, stagingSafeAfter(s)), now),
    ...(s.multipartId ? [enqueueAbort(db, s, now)] : []),
  ]);
  if (s.multipartId) {
    // Free the stored parts now (best effort); the queued abort runs again once all part URLs are dead.
    await (await bucketById(ctx, s.storageId)).abortMultipart(s.finalKey, s.multipartId).catch(() => {});
  }
  return { state: "aborted" };
}

export async function expireSession(db: Db, s: UploadSession, now: number) {
  await db.batch([
    db
      .update(uploadSessions)
      .set({ state: "expired", leaseUntil: null, closedAt: now })
      .where(and(eq(uploadSessions.id, s.id), inArray(uploadSessions.state, ["pending", "finalizing"]))),
    enqueueDelete(db, s.storageId, s.stagingKey, "expired", Math.max(now, stagingSafeAfter(s)), now),
    // The final key is only deleted if no file row references it (re-checked by the
    // job), and only after any finalizer's lease could have run out.
    enqueueDelete(db, s.storageId, s.finalKey, "expired", now + LEASE_MS + 60_000, now),
    ...(s.multipartId ? [enqueueAbort(db, s, now)] : []),
  ]);
}
