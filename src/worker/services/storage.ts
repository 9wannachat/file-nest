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

export const DEFAULT_TARGET_CAPACITY = 10 * 1024 ** 3; // R2 free tier per account

export interface TargetUsage {
  id: string;
  usedBytes: number;
  reservedBytes: number;
}

async function usageByTarget(db: Db, now: number): Promise<Map<string, TargetUsage>> {
  const rows = await db.all<TargetUsage>(sql`
    SELECT t.id AS id,
      (SELECT coalesce(sum(f.size), 0) FROM files f WHERE f.storage_id = t.id) AS usedBytes,
      (SELECT coalesce(sum(s.declared_size), 0) FROM upload_sessions s WHERE s.storage_id = t.id
        AND (s.state = 'finalizing' OR (s.state = 'pending' AND s.expires_at >= ${now}))) AS reservedBytes
    FROM storage_targets t`);
  return new Map(rows.map((r) => [r.id, { id: r.id, usedBytes: Number(r.usedBytes), reservedBytes: Number(r.reservedBytes) }]));
}

/** Eligible for new files: accepting, not failing health checks. */
export const isEligible = (t: StorageTarget) => t.acceptingUploads && t.lastCheckOk !== false;

/** Summary used by admin pages: totals across targets (capacity null if any target is unlimited). */
export async function capacitySummary(db: Db, now: number) {
  const rows = await db.select().from(storageTargets).orderBy(asc(storageTargets.priority), asc(storageTargets.createdAt), asc(storageTargets.id));
  const usage = await usageByTarget(db, now);
  const eligible = rows.filter(isEligible);
  let capacity: number | null = 0;
  let free: number | null = 0;
  let largestFree: number | null = 0;
  for (const t of eligible) {
    const u = usage.get(t.id)!;
    if (t.capacityBytes === null) {
      capacity = null;
      free = null;
      largestFree = null;
      break;
    }
    const f = Math.max(0, t.capacityBytes - u.usedBytes - u.reservedBytes);
    capacity = (capacity ?? 0) + t.capacityBytes;
    free = (free ?? 0) + f;
    largestFree = Math.max(largestFree ?? 0, f);
  }
  const used = [...usage.values()].reduce((n, u) => n + u.usedBytes, 0);
  const next = eligible.find((t) => {
    const u = usage.get(t.id)!;
    return t.capacityBytes === null || t.capacityBytes - u.usedBytes - u.reservedBytes > 0;
  });
  return { capacityBytes: capacity, usedBytes: used, freeBytes: free, largestFreeBytes: largestFree, nextTargetId: next?.id ?? null, targets: rows.length, eligibleTargets: eligible.length };
}

/** Kept for compatibility: the target that would receive the next upload. */
export async function getDefaultStorageId(db: Db): Promise<string | null> {
  return (await capacitySummary(db, Date.now())).nextTargetId;
}

async function referenceCounts(db: Db, id: string) {
  const f = await db.select({ n: sql<number>`count(*)` }).from(files).where(eq(files.storageId, id)).get();
  const u = await db.select({ n: sql<number>`count(*)` }).from(uploadSessions).where(eq(uploadSessions.storageId, id)).get();
  return { files: f?.n ?? 0, uploadSessions: u?.n ?? 0 };
}

export async function listTargets(ctx: StorageCtx) {
  const now = ctx.deps.now();
  const rows = await ctx.db.select().from(storageTargets).orderBy(asc(storageTargets.priority), asc(storageTargets.createdAt), asc(storageTargets.id));
  const usage = await usageByTarget(ctx.db, now);
  const summary = await capacitySummary(ctx.db, now);
  return Promise.all(
    rows.map(async (t, i) => {
      const u = usage.get(t.id)!;
      return {
        ...targetDto(t, ctx.env),
        order: i + 1,
        isDefault: t.id === summary.nextTargetId, // "receives the next upload"
        usedBytes: u.usedBytes,
        reservedBytes: u.reservedBytes,
        freeBytes: t.capacityBytes === null ? null : Math.max(0, t.capacityBytes - u.usedBytes - u.reservedBytes),
        eligible: isEligible(t),
        references: await referenceCounts(ctx.db, t.id),
      };
    }),
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
    capacityBytes: t.capacityBytes,
    priority: t.priority,
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

function parseCapacity(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw badRequest("invalid_capacity", "Capacity must be a non-negative integer (bytes) or null for unlimited");
  return v;
}

export async function createTarget(
  ctx: StorageCtx,
  actor: User,
  input: { name?: unknown; accountId?: unknown; bucket?: unknown; credentialRef?: unknown; capacityBytes?: unknown },
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
  const capacityBytes = input.capacityBytes === undefined ? DEFAULT_TARGET_CAPACITY : parseCapacity(input.capacityBytes);
  const now = ctx.deps.now();
  const dup = await ctx.db
    .select({ id: storageTargets.id })
    .from(storageTargets)
    .where(sql`${storageTargets.name} = ${name} OR (${storageTargets.accountId} = ${accountId} AND ${storageTargets.bucket} = ${bucket})`)
    .get();
  if (dup) throw conflict("storage_exists", "A storage target with this name or bucket already exists");
  const last = await ctx.db.select({ p: sql<number>`coalesce(max(priority), 0)` }).from(storageTargets).get();
  const t: StorageTarget = {
    id: crypto.randomUUID(),
    name,
    accountId,
    bucket,
    credentialRef,
    acceptingUploads: true,
    capacityBytes,
    priority: (last?.p ?? 0) + 1, // appended: filled after the existing targets
    lastCheckAt: null,
    lastCheckOk: null,
    lastCheckMessage: null,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.batch([
    ctx.db.insert(storageTargets).values(t),
    auditInsert(ctx.db, now, actor.id, "storage.create", "storage_target", t.id, { name, bucket, accountId, capacityBytes }),
  ]);
  return targetDto(t, ctx.env);
}

/**
 * Update a target. Account/bucket can only change while nothing references it;
 * otherwise add a new target instead. Capacity may go below current usage:
 * the target then simply receives no new files.
 */
export async function updateTarget(
  ctx: StorageCtx,
  actor: User,
  id: string,
  patch: { name?: unknown; acceptingUploads?: unknown; credentialRef?: unknown; accountId?: unknown; bucket?: unknown; capacityBytes?: unknown },
) {
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  const next: Partial<StorageTarget> = {};
  if (patch.name !== undefined) next.name = validateName(patch.name);
  if (patch.acceptingUploads !== undefined) {
    if (typeof patch.acceptingUploads !== "boolean") throw badRequest("invalid_accepting_uploads");
    next.acceptingUploads = patch.acceptingUploads;
  }
  if (patch.capacityBytes !== undefined) next.capacityBytes = parseCapacity(patch.capacityBytes);
  if (patch.credentialRef !== undefined) {
    const ref = typeof patch.credentialRef === "string" ? patch.credentialRef.trim().toUpperCase() : "";
    if (!CREDENTIAL_REF_RE.test(ref)) throw badRequest("invalid_credential_ref");
    next.credentialRef = ref; // rotation; same bucket
  }
  if (patch.accountId !== undefined || patch.bucket !== undefined) {
    const refs = await referenceCounts(ctx.db, id);
    if (refs.files > 0 || refs.uploadSessions > 0) {
      throw conflict("storage_in_use", "This target is in use. Add a new target instead.");
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
        ...(patch.capacityBytes !== undefined ? { previousCapacity: t.capacityBytes, newCapacity: next.capacityBytes ?? null } : {}),
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
  const refs = await referenceCounts(ctx.db, id);
  if (refs.files > 0 || refs.uploadSessions > 0) throw conflict("storage_in_use", "Files or uploads still reference this target");
  const now = ctx.deps.now();
  await ctx.db.batch([
    // Legacy pointer (pre-0005 default) has ON DELETE RESTRICT: clear it first.
    ctx.db.update(appSettings).set({ defaultStorageId: null }).where(eq(appSettings.defaultStorageId, id)),
    ctx.db.delete(storageTargets).where(eq(storageTargets.id, id)),
    auditInsert(ctx.db, now, actor.id, "storage.delete", "storage_target", id, { name: t.name }),
  ]);
}

/** Set the placement order (first = filled first). Must list every target exactly once. */
export async function reorderTargets(ctx: StorageCtx, actor: User, ids: unknown) {
  const all = await ctx.db.select({ id: storageTargets.id }).from(storageTargets);
  if (!all.length) throw badRequest("invalid_order", "There are no storage targets to order");
  if (!Array.isArray(ids) || ids.length !== all.length || new Set(ids).size !== ids.length || !ids.every((x) => all.some((t) => t.id === x))) {
    throw badRequest("invalid_order", "List every storage target exactly once");
  }
  const now = ctx.deps.now();
  await ctx.db.batch([
    ...(ids as string[]).map((id, i) => ctx.db.update(storageTargets).set({ priority: i + 1, updatedAt: now }).where(eq(storageTargets.id, id))),
    auditInsert(ctx.db, now, actor.id, "storage.reorder", "storage_target", ids[0] as string, { order: (ids as string[]).join(",") }),
  ] as unknown as [ReturnType<typeof auditInsert>]);
  return { order: ids };
}

/** Compatibility: "make default" = move this target to the front of the order. */
export async function setDefaultTarget(ctx: StorageCtx, actor: User, id: unknown) {
  if (typeof id !== "string") throw badRequest("invalid_storage_id");
  const t = await getTarget(ctx.db, id);
  if (!t) throw notFound();
  if (!t.acceptingUploads) throw conflict("not_accepting", "Enable uploads on this target first");
  const rows = await ctx.db.select({ id: storageTargets.id }).from(storageTargets).orderBy(asc(storageTargets.priority), asc(storageTargets.createdAt), asc(storageTargets.id));
  await reorderTargets(ctx, actor, [id, ...rows.map((r) => r.id).filter((x) => x !== id)]);
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
