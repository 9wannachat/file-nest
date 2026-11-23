/**
 * Personal access tokens for API clients such as the local MCP server.
 * Format: "fnpat_" + 43 base64url chars. Only SHA-256(token) is stored.
 * A token acts as its owner, limited by scopes and an endpoint allowlist
 * (auth/middleware.ts). It never grants admin, sharing, trash or delete rights.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { apiTokens, users, type ApiToken, type User } from "../db/schema.ts";
import type { Db } from "../env.ts";
import { randomToken, sha256Hex } from "../lib/crypto.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { auditInsert } from "./audit.ts";

export const TOKEN_PREFIX = "fnpat_";
export const TOKEN_RE = /^fnpat_[A-Za-z0-9_-]{43}$/;
export const SCOPES = ["files:read", "files:write"] as const;
export type Scope = (typeof SCOPES)[number];
export const MAX_TOKENS_PER_USER = 20;
export const TOKEN_RATE_PER_MINUTE = 600;

export function tokenDto(t: ApiToken) {
  return {
    id: t.id,
    name: t.name,
    scopes: t.scopes.split(" ").filter(Boolean),
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
  };
}

export async function listTokens(db: Db, user: User) {
  const rows = await db.select().from(apiTokens).where(eq(apiTokens.userId, user.id)).orderBy(desc(apiTokens.createdAt));
  return rows.map(tokenDto);
}

export async function createToken(
  db: Db,
  user: User,
  input: { name?: unknown; scopes?: unknown; expiresInDays?: unknown },
  now: number,
) {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 64) throw badRequest("invalid_name", "Name is required (max 64)");
  const scopes = input.scopes === undefined ? [...SCOPES] : input.scopes;
  if (!Array.isArray(scopes) || !scopes.length || !scopes.every((s) => (SCOPES as readonly unknown[]).includes(s))) {
    throw badRequest("invalid_scopes", `Scopes must be a subset of ${SCOPES.join(", ")}`);
  }
  const days = input.expiresInDays === undefined ? 90 : Number(input.expiresInDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) throw badRequest("invalid_expiry", "Expiry must be 1–365 days");
  const active = await db
    .select({ n: sql<number>`count(*)` })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, user.id), isNull(apiTokens.revokedAt), sql`${apiTokens.expiresAt} > ${now}`))
    .get();
  if ((active?.n ?? 0) >= MAX_TOKENS_PER_USER) throw conflict("too_many_tokens", "Revoke an existing token first");

  const token = TOKEN_PREFIX + randomToken(32);
  const row: ApiToken = {
    id: crypto.randomUUID(),
    userId: user.id,
    name,
    tokenHash: await sha256Hex(token),
    scopes: [...new Set(scopes as string[])].sort().join(" "),
    createdAt: now,
    lastUsedAt: null,
    expiresAt: now + days * 24 * 3600_000,
    revokedAt: null,
    windowStart: null,
    windowCount: 0,
  };
  await db.batch([
    db.insert(apiTokens).values(row),
    auditInsert(db, now, user.id, "token.create", "api_token", row.id, { scopes: row.scopes, days }),
  ]);
  return { token, info: tokenDto(row) };
}

export async function revokeToken(db: Db, user: User, id: string, now: number) {
  const t = await db.select().from(apiTokens).where(and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id))).get();
  if (!t) throw notFound();
  if (t.revokedAt) return tokenDto(t);
  await db.batch([
    db.update(apiTokens).set({ revokedAt: now }).where(eq(apiTokens.id, id)),
    auditInsert(db, now, user.id, "token.revoke", "api_token", id),
  ]);
  return tokenDto({ ...t, revokedAt: now });
}

export type BearerResult = { ok: true; user: User; token: ApiToken } | { ok: false; status: 401 | 429 };

/** Resolve a bearer token: unexpired, unrevoked, owner active, within its rate window. */
export async function authenticateBearer(db: Db, raw: string, now: number): Promise<BearerResult> {
  if (!TOKEN_RE.test(raw)) return { ok: false, status: 401 };
  const hash = await sha256Hex(raw);
  const row = await db
    .select({ t: apiTokens, u: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hash))
    .get();
  if (!row || row.t.revokedAt || row.t.expiresAt <= now || row.u.status !== "active") return { ok: false, status: 401 };
  // Fixed one-minute window, counted atomically in D1.
  const counted = await db.$client
    .prepare(
      `UPDATE api_tokens SET
         window_count = CASE WHEN window_start IS NOT NULL AND window_start > ?1 THEN window_count + 1 ELSE 1 END,
         window_start = CASE WHEN window_start IS NOT NULL AND window_start > ?1 THEN window_start ELSE ?2 END,
         last_used_at = ?2
       WHERE id = ?3
       RETURNING window_count`,
    )
    .bind(now - 60_000, now, row.t.id)
    .first<{ window_count: number }>();
  if ((counted?.window_count ?? 0) > TOKEN_RATE_PER_MINUTE) return { ok: false, status: 429 };
  return { ok: true, user: row.u, token: row.t };
}

export function hasScope(t: ApiToken, scope: Scope) {
  return t.scopes.split(" ").includes(scope);
}
