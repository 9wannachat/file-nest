/**
 * Authorization. Deny by default: every accessor takes the caller and returns
 * the row only if the caller may perform that action; otherwise 404 (we do not
 * reveal that a resource exists). Admin role grants NO file access.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { fileShares, files, folders, type FileRow, type Folder } from "./db/schema.ts";
import type { Db } from "./env.ts";
import { notFound } from "./lib/errors.ts";

export type FileAction = "read" | "manage";

/** read = owner or member it is shared with (active files only). manage = owner only. */
export async function fileFor(db: Db, userId: string, fileId: string, action: FileAction, opts: { trashed?: boolean } = {}): Promise<FileRow> {
  const trashCond = opts.trashed ? sql`${files.trashedAt} IS NOT NULL` : isNull(files.trashedAt);
  const access =
    action === "manage"
      ? eq(files.ownerId, userId)
      : sql`(${files.ownerId} = ${userId} OR (EXISTS (SELECT 1 FROM ${fileShares} s WHERE s.file_id = ${files.id} AND s.user_id = ${userId})
             AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = ${files.ownerId} AND o.status = 'disabled')))`;
  const row = await db.select().from(files).where(and(eq(files.id, fileId), trashCond, access)).get();
  if (!row) throw notFound();
  return row;
}

/** Folders are never shared in v0.1: owner only. */
export async function folderFor(db: Db, userId: string, folderId: string, opts: { trashed?: boolean } = {}): Promise<Folder> {
  const trashCond = opts.trashed ? sql`${folders.trashedAt} IS NOT NULL` : isNull(folders.trashedAt);
  const row = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.ownerId, userId), trashCond))
    .get();
  if (!row) throw notFound();
  return row;
}

/** Resolve a destination folder id (null = root) the caller may write into. */
export async function writableFolderId(db: Db, userId: string, folderId: string | null | undefined): Promise<string | null> {
  if (folderId === null || folderId === undefined || folderId === "root") return null;
  if (typeof folderId !== "string") throw notFound();
  return (await folderFor(db, userId, folderId)).id;
}
