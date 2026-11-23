import { asc, eq, sql } from "drizzle-orm";
import { appSettings, files, storageTargets, uploadSessions, type StorageTarget, type User } from "../db/schema.ts";
import { readSecret, type AppConfig, type Db, type Deps, type Env } from "../env.ts";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.ts";
import { CREDENTIAL_REF_RE, isValidAccountId, isValidBucket, MissingCredentialsError, R2Bucket } from "../storage/s3.ts";
import { auditInsert } from "./audit.ts";

export interface StorageCtx {
  db: Db;
  env: Env;
  config: AppConfig;
  deps: Deps;
}

export async function getTarget(db: Db, id: string): Promise<StorageTarget | undefined> {
  return db.select().from(storageTargets).where(eq(storageTargets.id, id)).get();
}

/** Build a client for a target. Throws a generic 502 if credentials are missing. */
export function bucketFor(ctx: StorageCtx, target: StorageTarget): R2Bucket {
  try {
    return new R2Bucket(target, ctx.env, ctx.config, ctx.deps.s3Fetch);
  } catch {
    throw new HttpError(502, "storage_unavailable", "Storage is unavailable");
  }
}

export async function bucketById(ctx: StorageCtx, storageId: string): Promise<R2Bucket> {
  const t = await getTarget(ctx.db, storageId);
  if (!t) throw new HttpError(502, "storage_unavailable", "Storage is unavailable");
  return bucketFor(ctx, t);
}

export async function getDefaultStorageId(db: Db): Promise<string | null> {
  const s = await db.select().from(appSettings).where(eq(appSettings.id, 1)).get();
  return s?.defaultStorageId ?? null;
}

/** Target for a NEW upload session: the current default, which must accept uploads. */
export async function targetForNewUpload(db: Db): Promise<StorageTarget> {
  const id = await getDefaultStorageId(db);
  const t = id ? await getTarget(db, id) : undefined;
  if (!t || !t.acceptingUploads) {
    throw new HttpError(503, "no_storage_accepting", "No storage is accepting uploads. Ask an Admin to configure storage.");
  }
  return t;
}

async function referenceCounts(db: Db, id: string) {
  const f = await db.select({ n: sql<number>`count(*)` }).from(files).where(eq(files.storageId, id)).get();
  const u = await db.select({ n: sql<number>`count(*)` }).from(uploadSessions).where(eq(uploadSessions.storageId, id)).get();
  return { files: f?.n ?? 0, uploadSessions: u?.n ?? 0 };
}

export async function listTargets(ctx: StorageCtx) {
  const rows = await ctx.db.select().from(storageTargets).orderBy(asc(storageTargets.createdAt));
  const def = await getDefaultStorageId(ctx.db);
  return Promise.all(
    rows.map(async (t) => ({
      ...targetDto(t, ctx.env),
      isDefault: t.id === def,
      references: await referenceCounts(ctx.db, t.id),
    })),
  );
}

export function targetDto(t: StorageTarget, env: Env) {
  return {
    id: t.id,
    name: t.name,
    accountId: t.accountId,
    bucket: t.bucket,
    credentialRef: t.credentialRef,
    credentialsPresent:
      !!readSecret(env, `R2_${t.credentialRef}_ACCESS_KEY_ID`) && !!readSecret(env, `R2_${t.credentialRef}_SECRET_ACCESS_KEY`),
    acceptingUploads: t.acceptingUploads,
    lastCheckAt: t.lastCheckAt,
    lastCheckOk: t.lastCheckOk,
    lastCheckMessage: t.lastCheckMessage,
    createdAt: t.createdAt,
  };
}

function validateName(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.trim().length > 64) throw badRequest("invalid_name", "Name is required (max 64)");
  return v.trim();
}

export async function createTarget(
  ctx: StorageCtx,
  actor: User,
  input: { name?: unknown; accountId?: unknown; bucket?: unknown; credentialRef?: unknown },
) {
  const name = validateName(input.name);
  const accountId = typeof input.accountId === "string" ? input.accountId.trim().toLowerCase() : "";
  const bucket = typeof input.bucket === "string" ? input.bucket.trim() : "";
  const credentialRef = typeof input.credentialRef === "string" ? input.credentialRef.trim().toUpperCase() : "";
  if (!isValidAccountId(accountId)) throw badRequest("invalid_account_id", "Account ID must be 32 hex characters");
  if (!isValidBucket(bucket)) throw badRequest("invalid_bucket", "Invalid R2 bucket name");
  if (!CREDENTIAL_REF_RE.test(credentialRef)) {
    throw badRequest("invalid_credential_ref", "Credential ref must be A-Z, 0-9, _ (max 32), e.g. MAIN");
  }
  const now = ctx.deps.now();
  const dup = await ctx.db
    .select({ id: storageTargets.id })
    .from(storageTargets)
    .where(sql`${storageTargets.name} = ${name} OR (${storageTargets.accountId} = ${accountId} AND ${storageTargets.bucket} = ${bucket})`)
    .get();
  if (dup) throw conflict("storage_exists", "A storage target with this name or bucket already exists");
  const t: StorageTarget = {
    id: crypto.randomUUID(),
    name,
    accountId,
    bucket,
    credentialRef,
    acceptingUploads: true,
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckMessage: null,
    createdAt: now,
    updatedAt: now,
  };
  const def = await getDefaultStorageId(ctx.db);
  await ctx.db.batch([
    ctx.db.insert(storageTargets).values(t),
    auditInsert(ctx.db, now, actor.id, "storage.create", "storage_target", t.id, { name, bucket, accountId }),
    // The very first target becomes the default automatically.
    ...(def
      ? []
      : [ctx.db.update(appSettings).set({ defaultStorageId: t.id, updatedAt: now, updatedBy: actor.id }).where(eq(appSettings.id, 1))]),
  ]);
  return targetDto(t, ctx.env);
}

/**
 * Update a target. Account/bucket can only change while nothing references it;
 * otherwise add a new target and switch the default instead.
 */
export async function updateTarget(
  ctx: StorageCtx,
  actor: User,
  id: string,
  patch: { name?: unknown; acceptingUploads?: unknown; credentialRef?: unknown; accountId?: unknown; bucket?: unknown },
) {
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  const next: Partial<StorageTarget> = {};
  if (patch.name !== undefined) next.name = validateName(patch.name);
  if (patch.acceptingUploads !== undefined) {
    if (typeof patch.acceptingUploads !== "boolean") throw badRequest("invalid_accepting_uploads");
    if (!patch.acceptingUploads && (await getDefaultStorageId(ctx.db)) === id) {
      throw conflict("is_default", "Switch the default to another target before pausing this one");
    }
    next.acceptingUploads = patch.acceptingUploads;
  }
  if (patch.credentialRef !== undefined) {
    const ref = typeof patch.credentialRef === "string" ? patch.credentialRef.trim().toUpperCase() : "";
    if (!CREDENTIAL_REF_RE.test(ref)) throw badRequest("invalid_credential_ref");
    next.credentialRef = ref; // rotation; same bucket
  }
  if (patch.accountId !== undefined || patch.bucket !== undefined) {
    const refs = await referenceCounts(ctx.db, id);
    if (refs.files > 0 || refs.uploadSessions > 0) {
      throw conflict("storage_in_use", "This target is in use. Add a new target and switch the default instead.");
    }
    if (patch.accountId !== undefined) {
      const a = typeof patch.accountId === "string" ? patch.accountId.trim().toLowerCase() : "";
      if (!isValidAccountId(a)) throw badRequest("invalid_account_id");
      next.accountId = a;
    }
    if (patch.bucket !== undefined) {
      const b = typeof patch.bucket === "string" ? patch.bucket.trim() : "";
      if (!isValidBucket(b)) throw badRequest("invalid_bucket");
      next.bucket = b;
    }
  }
  const now = ctx.deps.now();
  try {
    await ctx.db.batch([
      ctx.db.update(storageTargets).set({ ...next, updatedAt: now }).where(eq(storageTargets.id, id)),
      auditInsert(ctx.db, now, actor.id, "storage.update", "storage_target", id, {
        name: next.name ?? null,
        acceptingUploads: next.acceptingUploads ?? null,
        credentialRef: next.credentialRef ?? null,
        bucket: next.bucket ?? null,
        accountId: next.accountId ?? null,
      }),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw conflict("storage_exists");
    throw e;
  }
  return targetDto((await getTarget(ctx.db, id))!, ctx.env);
}

export async function deleteTarget(ctx: StorageCtx, actor: User, id: string) {
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  if ((await getDefaultStorageId(ctx.db)) === id) throw conflict("is_default", "Cannot delete the default target");
  const refs = await referenceCounts(ctx.db, id);
  if (refs.files > 0 || refs.uploadSessions > 0) throw conflict("storage_in_use", "Files or uploads still reference this target");
  const now = ctx.deps.now();
  await ctx.db.batch([
    ctx.db.delete(storageTargets).where(eq(storageTargets.id, id)),
    auditInsert(ctx.db, now, actor.id, "storage.delete", "storage_target", id, { name: t.name }),
  ]);
}

/** Switch where NEW upload sessions go. Existing sessions keep their pinned storage_id. */
export async function setDefaultTarget(ctx: StorageCtx, actor: User, id: unknown) {
  if (typeof id !== "string") throw badRequest("invalid_storage_id");
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  if (!t.acceptingUploads) throw conflict("not_accepting", "Enable uploads on this target first");
  const now = ctx.deps.now();
  const prev = await getDefaultStorageId(ctx.db);
  await ctx.db.batch([
    ctx.db.update(appSettings).set({ defaultStorageId: id, updatedAt: now, updatedBy: actor.id }).where(eq(appSettings.id, 1)),
    auditInsert(ctx.db, now, actor.id, "storage.default_switch", "storage_target", id, { previous: prev }),
  ]);
  return { defaultStorageId: id };
}

/**
 * Health check: write, read and delete a probe object, then a CORS preflight
 * for browser uploads. Messages are generic so no host/secret leaks.
 */
export async function checkTarget(ctx: StorageCtx, id: string, origin: string) {
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  const result = { ok: false, credentials: false, write: false, read: false, delete: false, cors: false, message: "" };
  let bucket: R2Bucket;
  try {
    bucket = new R2Bucket(t, ctx.env, ctx.config, ctx.deps.s3Fetch);
    result.credentials = true;
  } catch (e) {
    result.message = e instanceof MissingCredentialsError ? `Missing secrets R2_${t.credentialRef}_*` : "Invalid configuration";
    await saveCheck(ctx, id, result);
    return result;
  }
  const key = `.filenest/health-check-${crypto.randomUUID()}`;
  try {
    await bucket.put(key, "ok");
    result.write = true;
    const head = await bucket.head(key);
    result.read = !!head && head.size === 2;
    await bucket.delete(key);
    result.delete = true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    result.message = `Object API check failed${status ? ` (HTTP ${status})` : ""}. Check the API token scope and bucket name.`;
  }
  result.cors = await bucket.corsPreflight(origin);
  if (!result.message && !result.cors) result.message = `CORS does not allow PUT from ${origin}`;
  result.ok = result.write && result.read && result.delete && result.cors;
  if (result.ok) result.message = "OK";
  await saveCheck(ctx, id, result);
  return result;
}

async function saveCheck(ctx: StorageCtx, id: string, r: { ok: boolean; message: string }) {
  await ctx.db
    .update(storageTargets)
    .set({ lastCheckAt: ctx.deps.now(), lastCheckOk: r.ok, lastCheckMessage: r.message.slice(0, 300) })
    .where(eq(storageTargets.id, id));
}
