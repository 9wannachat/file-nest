/**
 * Scheduled maintenance (Cron Trigger):
 *  1. expire stale upload sessions and queue their staging/final keys
 *  2. delete queued R2 objects that NOTHING references any more
 *  3. purge trash older than TRASH_RETENTION_DAYS
 *  4. drop expired sessions and OAuth states
 */
import { and, asc, eq, inArray, lt, lte, or, sql } from "drizzle-orm";
import { files, oauthStates, objectDeletions, uploadSessions } from "../db/schema.ts";
import { log } from "../lib/log.ts";
import { purgeExpiredSessions } from "../auth/session.ts";
import { purgeTrashRoots } from "./drive.ts";
import { expireSession } from "./uploads.ts";
import { bucketById, type StorageCtx } from "./storage.ts";

const BATCH = 50;

export async function runCleanup(ctx: StorageCtx) {
  const { db, deps, config } = ctx;
  const now = deps.now();
  const stats = { expiredSessions: 0, deleted: 0, skippedInUse: 0, failed: 0, purgedRoots: 0 };

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

  // 3. Purge old trash.
  const cutoff = now - config.trashRetentionDays * 24 * 3600_000;
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

  log.info("cleanup.done", stats);
  return stats;
}
