/**
 * Scheduled maintenance (Cron Trigger):
 *  1. expire stale upload sessions and queue their staging/final keys
 *  2. delete queued R2 objects that NOTHING references any more
 *     (and abort unfinished multipart uploads, freeing their parts)
 *  3. purge trash older than TRASH_RETENTION_DAYS
 *  4. drop expired sessions and OAuth states
 */
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { files, multipartAborts, oauthStates, objectDeletions, shareUnlockAttempts, uploadSessions } from "../db/schema.ts";
import { log } from "../lib/log.ts";
import { purgeExpiredSessions } from "../auth/session.ts";
import { purgeAuthLeftovers } from "./authn.ts";
import { getSettings } from "./settings.ts";
import { HAS_SIGN_IN_SQL } from "./members.ts";
import { purgeTrashRoots } from "./drive.ts";
import { expireSession } from "./uploads.ts";
import { bucketById, type StorageCtx } from "./storage.ts";

const BATCH = 50;

export async function runCleanup(ctx: StorageCtx) {
  const { db, deps, config } = ctx;
  const now = deps.now();
  const stats = { expiredSessions: 0, deleted: 0, skippedInUse: 0, failed: 0, purgedRoots: 0, abortedMultipart: 0 };

  // 1. Expire sessions past their window (finalizing ones only once their lease lapsed).
  const stale = await db
    .select()
    .from(uploadSessions)
    .where(
      and(
        lt(uploadSessions.expiresAt, now),
        or(
          eq(uploadSessions.state, "pending"),
          and(eq(uploadSessions.state, "finalizing"), lt(uploadSessions.leaseUntil, now)),
        ),
      ),
    )
    .limit(BATCH);
  for (const s of stale) {
    await expireSession(db, s, now);
    stats.expiredSessions++;
  }

  // 2. Process the deletion queue.
  const due = await db
    .select()
    .from(objectDeletions)
    .where(lte(objectDeletions.notBefore, now))
    .orderBy(asc(objectDeletions.notBefore))
    .limit(BATCH);
  for (const d of due) {
    const referenced = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.storageId, d.storageId), eq(files.objectKey, d.objectKey)))
      .get();
    if (referenced) {
      // A live file uses this key: never delete it.
      await db.delete(objectDeletions).where(eq(objectDeletions.id, d.id));
      stats.skippedInUse++;
      continue;
    }
    const activeSession = await db
      .select({ id: uploadSessions.id })
      .from(uploadSessions)
      .where(
        and(
          eq(uploadSessions.storageId, d.storageId),
          inArray(uploadSessions.state, ["pending", "finalizing"]),
          or(eq(uploadSessions.stagingKey, d.objectKey), eq(uploadSessions.finalKey, d.objectKey)),
        ),
      )
      .get();
    if (activeSession) {
      await db.update(objectDeletions).set({ notBefore: now + 3600_000 }).where(eq(objectDeletions.id, d.id));
      stats.skippedInUse++;
      continue;
    }
    try {
      const bucket = await bucketById(ctx, d.storageId);
      await bucket.delete(d.objectKey);
      await db.delete(objectDeletions).where(eq(objectDeletions.id, d.id));
      stats.deleted++;
    } catch (e) {
      const backoff = Math.min(24 * 3600_000, 60_000 * 2 ** Math.min(d.attempts, 10));
      await db
        .update(objectDeletions)
        .set({ attempts: d.attempts + 1, notBefore: now + backoff, lastError: String((e as Error).message).slice(0, 200) })
        .where(eq(objectDeletions.id, d.id));
      stats.failed++;
    }
  }

  // 2b. Abort multipart uploads of closed sessions.
  const aborts = await db.select().from(multipartAborts).where(lte(multipartAborts.notBefore, now)).orderBy(asc(multipartAborts.notBefore)).limit(BATCH);
  for (const a of aborts) {
    const done = and(eq(multipartAborts.storageId, a.storageId), eq(multipartAborts.multipartId, a.multipartId));
    const live = await db
      .select({ id: uploadSessions.id })
      .from(uploadSessions)
      .where(and(eq(uploadSessions.storageId, a.storageId), eq(uploadSessions.multipartId, a.multipartId), inArray(uploadSessions.state, ["pending", "finalizing"])))
      .get();
    if (live) {
      await db.delete(multipartAborts).where(done); // queued by mistake: the session is still open
      continue;
    }
    try {
      const bucket = await bucketById(ctx, a.storageId);
      await bucket.abortMultipart(a.objectKey, a.multipartId);
      await db.delete(multipartAborts).where(done);
      stats.abortedMultipart++;
    } catch (e) {
      const backoff = Math.min(24 * 3600_000, 60_000 * 2 ** Math.min(a.attempts, 10));
      await db
        .update(multipartAborts)
        .set({ attempts: a.attempts + 1, notBefore: now + backoff, lastError: String((e as Error).message).slice(0, 200) })
        .where(done);
      stats.failed++;
    }
  }

  // 3. Purge old trash.
  const settings = await getSettings(db, config);
  const cutoff = now - settings.trashRetentionDays * 24 * 3600_000;
  const roots = await db.all<{ id: string }>(sql`
    SELECT id FROM folders WHERE trash_root_id = id AND trashed_at < ${cutoff}
    UNION ALL
    SELECT id FROM files WHERE trash_root_id = id AND trashed_at < ${cutoff}
    LIMIT ${BATCH}`);
  await purgeTrashRoots(
    db,
    roots.map((r) => r.id),
    now,
  );
  stats.purgedRoots = roots.length;

  // 4. Housekeeping.
  await purgeExpiredSessions(db, now);
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, now));
  await purgeAuthLeftovers(db, now);
  // Lift timed bans that have ended.
  await db.run(sql`UPDATE users SET
      status = CASE WHEN ${HAS_SIGN_IN_SQL} THEN 'active' ELSE 'invited' END,
      banned_reason = NULL, banned_until = NULL, banned_by = NULL, updated_at = ${now}
    WHERE status = 'disabled' AND banned_until IS NOT NULL AND banned_until <= ${now}`);
  await db.delete(shareUnlockAttempts).where(lt(shareUnlockAttempts.updatedAt, now - 2 * 24 * 3600_000));

  log.info("cleanup.done", stats);
  return stats;
}
