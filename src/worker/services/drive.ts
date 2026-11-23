import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { files, folders, users, type FileRow, type Folder } from "../db/schema.ts";
import type { Db } from "../env.ts";
import { atomicBatch } from "../db/client.ts";
import { fileFor, folderFor, writableFolderId } from "../authz.ts";
import { badRequest, conflict, HttpError } from "../lib/errors.ts";
import { cleanName, escapeLike, withSuffix } from "../lib/names.ts";

export const LIST_LIMIT = 2000;

export function isUniqueViolation(e: unknown): boolean {
  const s = String((e as Error)?.message ?? e) + String((e as { cause?: unknown })?.cause ?? "");
  return s.includes("UNIQUE constraint failed");
}

const nameTaken = () => conflict("name_taken", "An item with this name already exists here");

export type FileDto = ReturnType<typeof fileDto>;

export function fileDto(
  f: FileRow,
  viewerId: string,
  extra: { ownerEmail: string; ownerName: string | null; shareCount: number; hasLink: number | boolean },
) {
  const isOwner = f.ownerId === viewerId;
  return {
    id: f.id,
    kind: "file" as const,
    name: f.name,
    size: f.size,
    contentType: f.contentType,
    inline: f.inlineOk,
    folderId: isOwner ? f.folderId : null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    trashedAt: f.trashedAt,
    isOwner,
    owner: { id: f.ownerId, email: extra.ownerEmail, name: extra.ownerName },
    // Sharing details only for the owner.
    sharedWithCount: isOwner ? Number(extra.shareCount) : 0,
    hasPublicLink: isOwner ? Boolean(extra.hasLink) : false,
  };
}

export function folderDto(f: Folder) {
  return {
    id: f.id,
    kind: "folder" as const,
    name: f.name,
    parentId: f.parentId,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    trashedAt: f.trashedAt,
  };
}

/** Select files with owner + sharing extras. `where` must already include access control. */
async function selectFiles(db: Db, viewerId: string, where: ReturnType<typeof and>, limit = LIST_LIMIT) {
  const rows = await db
    .select({
      f: files,
      ownerEmail: users.email,
      ownerName: users.name,
      shareCount: sql<number>`(SELECT count(*) FROM file_shares s WHERE s.file_id = ${files.id})`,
      hasLink: sql<number>`EXISTS (SELECT 1 FROM share_links l WHERE l.file_id = ${files.id} AND l.revoked_at IS NULL)`,
    })
    .from(files)
    .innerJoin(users, eq(users.id, files.ownerId))
    .where(where)
    .orderBy(asc(sql`lower(${files.name})`))
    .limit(limit);
  return rows.map((r) => fileDto(r.f, viewerId, r));
}

export async function fileDtoFor(db: Db, viewerId: string, fileId: string) {
  const [dto] = await selectFiles(db, viewerId, and(eq(files.id, fileId)), 1);
  return dto!;
}

export async function breadcrumb(db: Db, userId: string, folderId: string) {
  return db.all<{ id: string; name: string }>(sql`
    WITH RECURSIVE anc(id, parent_id, name, depth) AS (
      SELECT id, parent_id, name, 0 FROM folders WHERE id = ${folderId} AND owner_id = ${userId}
      UNION ALL
      SELECT f.id, f.parent_id, f.name, a.depth + 1 FROM folders f JOIN anc a ON f.id = a.parent_id
      WHERE a.depth < 256
    )
    SELECT id, name FROM anc ORDER BY depth DESC`);
}

export async function listFolder(db: Db, userId: string, folderId: string | null) {
  const folder = folderId ? await folderFor(db, userId, folderId) : null;
  const childFolders = await db
    .select()
    .from(folders)
    .where(
      and(
        eq(folders.ownerId, userId),
        folderId ? eq(folders.parentId, folderId) : isNull(folders.parentId),
        isNull(folders.trashedAt),
      ),
    )
    .orderBy(asc(sql`lower(${folders.name})`))
    .limit(LIST_LIMIT);
  const childFiles = await selectFiles(
    db,
    userId,
    and(eq(files.ownerId, userId), folderId ? eq(files.folderId, folderId) : isNull(files.folderId), isNull(files.trashedAt)),
  );
  return {
    folder: folder ? folderDto(folder) : null,
    breadcrumb: folder ? await breadcrumb(db, userId, folder.id) : [],
    folders: childFolders.map(folderDto),
    files: childFiles,
    truncated: childFolders.length >= LIST_LIMIT || childFiles.length >= LIST_LIMIT,
  };
}

export async function listShared(db: Db, userId: string) {
  return selectFiles(
    db,
    userId,
    and(
      isNull(files.trashedAt),
      sql`EXISTS (SELECT 1 FROM file_shares s WHERE s.file_id = ${files.id} AND s.user_id = ${userId})`,
      sql`${users.status} <> 'disabled'`,
    ),
  );
}

/** Name search over the caller's own active items and files shared with them. */
export async function search(db: Db, userId: string, q: string) {
  const term = q.trim();
  if (term.length < 1 || term.length > 100) throw badRequest("invalid_query", "Search 1–100 characters");
  const like = `%${escapeLike(term.toLowerCase())}%`;
  const found = await selectFiles(
    db,
    userId,
    and(
      isNull(files.trashedAt),
      sql`lower(${files.name}) LIKE ${like} ESCAPE '\\'`,
      sql`(${files.ownerId} = ${userId} OR (EXISTS (SELECT 1 FROM file_shares s WHERE s.file_id = ${files.id} AND s.user_id = ${userId}) AND ${users.status} <> 'disabled'))`,
    ),
    200,
  );
  const fs = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, userId), isNull(folders.trashedAt), sql`lower(${folders.name}) LIKE ${like} ESCAPE '\\'`))
    .orderBy(asc(sql`lower(${folders.name})`))
    .limit(100);
  return { folders: fs.map(folderDto), files: found };
}

export async function listTrash(db: Db, userId: string) {
  const fs = await db
    .select()
    .from(folders)
    .where(and(eq(folders.ownerId, userId), sql`${folders.trashRootId} = ${folders.id}`))
    .orderBy(asc(folders.trashedAt));
  const fl = await selectFiles(db, userId, and(eq(files.ownerId, userId), sql`${files.trashRootId} = ${files.id}`));
  return { folders: fs.map(folderDto), files: fl };
}

// ---------- folders ----------

export async function createFolder(db: Db, userId: string, input: { name?: unknown; parentId?: unknown }, now: number) {
  const name = cleanName(input.name);
  const parentId = await writableFolderId(db, userId, input.parentId as string | null | undefined);
  const f: Folder = { id: crypto.randomUUID(), ownerId: userId, parentId, name, trashedAt: null, trashRootId: null, createdAt: now, updatedAt: now };
  try {
    await db.insert(folders).values(f);
  } catch (e) {
    if (isUniqueViolation(e)) throw nameTaken();
    throw e;
  }
  return folderDto(f);
}

async function subtreeIds(db: Db, folderId: string): Promise<string[]> {
  const rows = await db.all<{ id: string }>(sql`
    WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 0 FROM folders WHERE id = ${folderId}
      UNION ALL
      SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id WHERE s.depth < 256
    ) SELECT id FROM sub`);
  return rows.map((r) => r.id);
}

export async function updateFolder(db: Db, userId: string, id: string, patch: { name?: unknown; parentId?: unknown }, now: number) {
  const folder = await folderFor(db, userId, id);
  const next: Partial<Folder> = {};
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.parentId !== undefined) {
    const parentId = await writableFolderId(db, userId, patch.parentId as string | null);
    if (parentId) {
      const sub = await subtreeIds(db, folder.id);
      if (sub.includes(parentId)) throw badRequest("invalid_move", "Cannot move a folder into itself");
    }
    next.parentId = parentId;
  }
  try {
    await db.update(folders).set({ ...next, updatedAt: now }).where(eq(folders.id, folder.id));
  } catch (e) {
    if (isUniqueViolation(e)) throw nameTaken();
    throw e;
  }
  return folderDto({ ...folder, ...next, updatedAt: now });
}

export async function trashFolder(db: Db, userId: string, id: string, now: number) {
  const folder = await folderFor(db, userId, id);
  // Mark the whole active subtree with this folder as trash root.
  await atomicBatch(db.$client, [
    sql`
      WITH RECURSIVE sub(id, depth) AS (
        SELECT id, 0 FROM folders WHERE id = ${folder.id}
        UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id WHERE s.depth < 256
      )
      UPDATE files SET trashed_at = ${now}, trash_root_id = ${folder.id}, updated_at = ${now}
      WHERE folder_id IN (SELECT id FROM sub) AND trashed_at IS NULL`,
    sql`
      WITH RECURSIVE sub(id, depth) AS (
        SELECT id, 0 FROM folders WHERE id = ${folder.id}
        UNION ALL SELECT f.id, s.depth + 1 FROM folders f JOIN sub s ON f.parent_id = s.id WHERE s.depth < 256
      )
      UPDATE folders SET trashed_at = ${now}, trash_root_id = ${folder.id}, updated_at = ${now}
      WHERE id IN (SELECT id FROM sub) AND trashed_at IS NULL`,
  ]);
}

/** Find a free name in a parent by appending " (n)". */
async function freeName(db: Db, kind: "file" | "folder", ownerId: string, parentId: string | null, name: string, selfId: string) {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : withSuffix(name, n);
    const table = kind === "file" ? files : folders;
    const parentCol = kind === "file" ? files.folderId : folders.parentId;
    const hit = await db
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.ownerId, ownerId),
          parentId ? eq(parentCol, parentId) : isNull(parentCol),
          eq(table.name, candidate),
          isNull(table.trashedAt),
          sql`${table.id} <> ${selfId}`,
        ),
      )
      .get();
    if (!hit) return candidate;
  }
  throw conflict("name_taken");
}

async function activeFolderOrNull(db: Db, userId: string, folderId: string | null): Promise<string | null> {
  if (!folderId) return null;
  const f = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.ownerId, userId), isNull(folders.trashedAt)))
    .get();
  return f ? f.id : null;
}

export async function restoreFolder(db: Db, userId: string, id: string, now: number) {
  const folder = await folderFor(db, userId, id, { trashed: true });
  if (folder.trashRootId !== folder.id) throw badRequest("not_trash_root", "Restore the parent folder instead");
  const parentId = await activeFolderOrNull(db, userId, folder.parentId);
  const name = await freeName(db, "folder", userId, parentId, folder.name, folder.id);
  await db.batch([
    db.update(folders).set({ trashedAt: null, trashRootId: null, updatedAt: now }).where(eq(folders.trashRootId, folder.id)),
    db.update(folders).set({ parentId, name }).where(eq(folders.id, folder.id)),
    db.update(files).set({ trashedAt: null, trashRootId: null, updatedAt: now }).where(eq(files.trashRootId, folder.id)),
  ]);
}

/** Permanently delete a trashed folder subtree; objects are deleted asynchronously. */
export async function purgeFolder(db: Db, userId: string, id: string, now: number) {
  const folder = await folderFor(db, userId, id, { trashed: true });
  if (folder.trashRootId !== folder.id) throw badRequest("not_trash_root");
  await purgeTrashRoots(db, [folder.id], now);
}

// ---------- files ----------

export async function updateFile(db: Db, userId: string, id: string, patch: { name?: unknown; folderId?: unknown }, now: number) {
  const file = await fileFor(db, userId, id, "manage");
  const next: Partial<FileRow> = {};
  if (patch.name !== undefined) next.name = cleanName(patch.name);
  if (patch.folderId !== undefined) next.folderId = await writableFolderId(db, userId, patch.folderId as string | null);
  try {
    // Metadata only: storage_id/object_key never change on rename or move.
    await db.update(files).set({ ...next, updatedAt: now }).where(eq(files.id, file.id));
  } catch (e) {
    if (isUniqueViolation(e)) throw nameTaken();
    throw e;
  }
  return fileDtoFor(db, userId, file.id);
}

export async function trashFile(db: Db, userId: string, id: string, now: number) {
  const file = await fileFor(db, userId, id, "manage");
  await db.update(files).set({ trashedAt: now, trashRootId: file.id, updatedAt: now }).where(eq(files.id, file.id));
}

export async function restoreFile(db: Db, userId: string, id: string, now: number) {
  const file = await fileFor(db, userId, id, "manage", { trashed: true });
  if (file.trashRootId !== file.id) throw badRequest("not_trash_root", "Restore the parent folder instead");
  const folderId = await activeFolderOrNull(db, userId, file.folderId);
  const name = await freeName(db, "file", userId, folderId, file.name, file.id);
  await db.update(files).set({ trashedAt: null, trashRootId: null, folderId, name, updatedAt: now }).where(eq(files.id, file.id));
}

export async function purgeFile(db: Db, userId: string, id: string, now: number) {
  const file = await fileFor(db, userId, id, "manage", { trashed: true });
  if (file.trashRootId !== file.id) throw badRequest("not_trash_root");
  await purgeTrashRoots(db, [file.id], now);
}

/**
 * Delete everything under the given trash roots: rows first (so nothing can
 * reference the object), then queue the R2 deletes for the cleanup job.
 */
export async function purgeTrashRoots(db: Db, roots: string[], now: number) {
  for (const root of roots) {
    // One atomic batch per root, using subqueries (no bound-parameter limits).
    await atomicBatch(db.$client, [
      // Queue R2 deletes before the rows disappear; the cleanup job re-checks references.
      sql`
        INSERT INTO object_deletions (id, storage_id, object_key, reason, not_before, attempts, created_at)
        SELECT lower(hex(randomblob(16))), storage_id, object_key, 'purge', ${now}, 0, ${now}
        FROM files WHERE trash_root_id = ${root}
        ON CONFLICT (storage_id, object_key) DO NOTHING`,
      // Items trashed separately earlier but living inside this subtree move to root level.
      sql`
        UPDATE files SET folder_id = NULL
        WHERE folder_id IN (SELECT id FROM folders WHERE trash_root_id = ${root})
          AND (trash_root_id IS NULL OR trash_root_id <> ${root})`,
      sql`
        UPDATE folders SET parent_id = NULL
        WHERE parent_id IN (SELECT id FROM folders WHERE trash_root_id = ${root})
          AND (trash_root_id IS NULL OR trash_root_id <> ${root})`,
      sql`DELETE FROM file_shares WHERE file_id IN (SELECT id FROM files WHERE trash_root_id = ${root})`,
      sql`DELETE FROM share_links WHERE file_id IN (SELECT id FROM files WHERE trash_root_id = ${root})`,
      sql`DELETE FROM files WHERE trash_root_id = ${root}`,
      sql`DELETE FROM folders WHERE trash_root_id = ${root}`,
    ]);
  }
}

export function requireString(v: unknown, code = "invalid_input"): string {
  if (typeof v !== "string" || !v) throw new HttpError(400, code, code);
  return v;
}
