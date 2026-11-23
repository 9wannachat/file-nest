import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema.ts";
import type { User, Session } from "./db/schema.ts";

/** Worker bindings and vars. Per-target R2 credentials are dynamic secrets. */
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string; // "production" | "development" | "test"
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  APP_ENCRYPTION_KEY?: string;
  MAX_UPLOAD_BYTES?: string;
  DEFAULT_QUOTA_BYTES?: string;
  UPLOAD_RATE_PER_HOUR?: string;
  TRASH_RETENTION_DAYS?: string;
  DEV_AUTH?: string;
  DEV_S3_ENDPOINT?: string;
}

export type Db = DrizzleD1Database<typeof schema> & { $client: D1Database };

/** Injectable dependencies (tests replace outbound fetches with fakes). */
export interface Deps {
  /** fetch used for R2 S3 API calls */
  s3Fetch: typeof fetch;
  /** fetch used for the Google token endpoint */
  googleFetch: typeof fetch;
  /** resolver for Google's signing keys (jose JWKS function) */
  googleJwks?: import("jose").JWTVerifyGetKey;
  now: () => number;
}

export type AuthContext = { user: User; session: Session };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    deps: Deps;
    config: AppConfig;
    auth?: AuthContext;
    requestId: string;
  };
};

export interface AppConfig {
  environment: string;
  isDev: boolean;
  appOrigin: string | null;
  secureCookies: boolean;
  maxUploadBytes: number;
  defaultQuotaBytes: number;
  uploadRatePerHour: number;
  trashRetentionDays: number;
}

function intVar(v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

/** R2 single PUT limit is 5 GiB; keep a small margin. */
export const SINGLE_PUT_LIMIT = 5 * 1024 ** 3 - 5 * 1024 ** 2;

export function loadConfig(env: Env): AppConfig {
  const environment = env.ENVIRONMENT ?? "production";
  const appOrigin = env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/+$/, "") : null;
  return {
    environment,
    isDev: environment === "development",
    appOrigin,
    secureCookies: appOrigin ? appOrigin.startsWith("https://") : environment !== "development",
    maxUploadBytes: intVar(env.MAX_UPLOAD_BYTES, 512 * 1024 ** 2, SINGLE_PUT_LIMIT),
    defaultQuotaBytes: intVar(env.DEFAULT_QUOTA_BYTES, 10 * 1024 ** 3),
    uploadRatePerHour: intVar(env.UPLOAD_RATE_PER_HOUR, 100),
    trashRetentionDays: intVar(env.TRASH_RETENTION_DAYS, 30, 3650),
  };
}

/** Read a dynamically named secret (e.g. R2_MAIN_ACCESS_KEY_ID). */
export function readSecret(env: Env, name: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
