import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema.ts";
import type { ApiToken, User, Session } from "./db/schema.ts";

/** Worker bindings and vars. Per-target R2 credentials are dynamic secrets. */
export interface Env {
  DB: D1Database;
  ENVIRONMENT?: string; // "production" | "development" | "test"
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  /** Optional: restrict Microsoft sign-in to one Entra tenant (GUID). Default: any tenant + personal accounts. */
  MICROSOFT_TENANT_ID?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  BOOTSTRAP_ADMIN_EMAIL?: string;
  APP_ENCRYPTION_KEY?: string;
  MAX_UPLOAD_BYTES?: string;
  /** Files at least this big upload as R2 multipart (resumable). Default 64 MiB. */
  MULTIPART_THRESHOLD_BYTES?: string;
  /** Base part size; grows so a file never needs more than 10,000 parts. Default 16 MiB, min 5 MiB outside dev/test. */
  MULTIPART_PART_BYTES?: string;
  DEFAULT_QUOTA_BYTES?: string;
  UPLOAD_RATE_PER_HOUR?: string;
  TRASH_RETENTION_DAYS?: string;
  DEV_AUTH?: string;
  DEV_S3_ENDPOINT?: string;
  PASSWORD_PBKDF2_ITERATIONS?: string;
}

export type Db = DrizzleD1Database<typeof schema> & { $client: D1Database };

/** Injectable dependencies (tests replace outbound fetches with fakes). */
export interface Deps {
  /** fetch used for R2 S3 API calls */
  s3Fetch: typeof fetch;
  /** fetch used for OAuth token endpoints and the GitHub API */
  oauthFetch: typeof fetch;
  /** resolvers for ID-token signing keys (jose JWKS functions); remote JWKS when absent */
  oauthJwks?: Partial<Record<"google" | "microsoft", import("jose").JWTVerifyGetKey>>;
  now: () => number;
}

/** Cookie session (browser) XOR personal access token (API/MCP clients). */
export type AuthContext = { user: User; session: Session; token?: undefined } | { user: User; session?: undefined; token: ApiToken };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: Db;
    deps: Deps;
    config: AppConfig;
    auth?: AuthContext;
    /** Policy requires 2FA and the member has not enrolled: only enrollment is reachable. */
    mfaSetupRequired?: boolean;
    requestId: string;
  };
};

export interface AppConfig {
  environment: string;
  isDev: boolean;
  appOrigin: string | null;
  secureCookies: boolean;
  maxUploadBytes: number;
  multipartThresholdBytes: number;
  multipartPartBytes: number;
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

/** R2 single PUT limit is 5 GiB; keep a small margin. Bigger files must use multipart. */
export const SINGLE_PUT_LIMIT = 5 * 1024 ** 3 - 5 * 1024 ** 2;
/** R2's largest object (multipart) is 4.995 TiB; stay just under it. */
export const MAX_OBJECT_BYTES = 4_995 * 1024 ** 3;
/** S3/R2 minimum size of every part except the last. */
export const MIN_PART_BYTES = 5 * 1024 ** 2;
export const MAX_PARTS = 10_000;

export function loadConfig(env: Env): AppConfig {
  const environment = env.ENVIRONMENT ?? "production";
  const appOrigin = env.APP_ORIGIN ? env.APP_ORIGIN.replace(/\/+$/, "") : null;
  return {
    environment,
    isDev: environment === "development",
    appOrigin,
    secureCookies: appOrigin ? appOrigin.startsWith("https://") : environment !== "development",
    maxUploadBytes: intVar(env.MAX_UPLOAD_BYTES, 512 * 1024 ** 2, MAX_OBJECT_BYTES),
    multipartThresholdBytes: Math.max(1, intVar(env.MULTIPART_THRESHOLD_BYTES, 64 * 1024 ** 2, SINGLE_PUT_LIMIT)),
    // Smaller parts are only for local tests against the fake S3; R2 rejects them.
    multipartPartBytes: Math.max(
      environment === "development" || environment === "test" ? 1 : MIN_PART_BYTES,
      intVar(env.MULTIPART_PART_BYTES, 16 * 1024 ** 2, 5 * 1024 ** 3),
    ),
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
