import type { Context } from "hono";
import type { AppEnv } from "../env.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import type { StorageCtx } from "../services/storage.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function idParam(c: Context<AppEnv>, name = "id"): string {
  const v = c.req.param(name);
  if (!v || !UUID_RE.test(v)) throw notFound();
  return v;
}

export async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (!(c.req.header("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
    throw badRequest("invalid_content_type", "Expected application/json");
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("invalid_json");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("invalid_json");
  return body as Record<string, unknown>;
}

export function storageCtx(c: Context<AppEnv>): StorageCtx {
  return { db: c.get("db"), env: c.env, config: c.get("config"), deps: c.get("deps") };
}

export const now = (c: Context<AppEnv>) => c.get("deps").now();
