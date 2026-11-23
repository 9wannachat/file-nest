import { AwsClient } from "aws4fetch";
import type { StorageTarget } from "../db/schema.ts";
import { readSecret, type AppConfig, type Env } from "../env.ts";
import { HttpError } from "../lib/errors.ts";

const ACCOUNT_RE = /^[0-9a-f]{32}$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const CREDENTIAL_REF_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const KEY_RE = /^(staging|files|\.filenest)\/[A-Za-z0-9/_.-]{1,200}$/;

export interface ObjectHead {
  size: number;
  etag: string;
}

export class StorageError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
  ) {
    super(`storage ${op} failed (${status})`);
  }
}

/** Public error surfaced to clients; never contains host, key or signature. */
export const storageUnavailable = () => new HttpError(502, "storage_unavailable", "Storage is unavailable");

/**
 * S3-API client for one R2 bucket. The endpoint is built only from validated
 * D1 config (account id + bucket); clients never supply hosts or keys.
 */
export class R2Bucket {
  private readonly aws: AwsClient;
  private readonly base: string;
  private readonly bucketName: string;

  constructor(
    target: Pick<StorageTarget, "accountId" | "bucket" | "credentialRef">,
    env: Env,
    config: AppConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    if (!ACCOUNT_RE.test(target.accountId)) throw new Error("invalid account id");
    if (!BUCKET_RE.test(target.bucket)) throw new Error("invalid bucket");
    if (!CREDENTIAL_REF_RE.test(target.credentialRef)) throw new Error("invalid credential ref");
    const accessKeyId = readSecret(env, `R2_${target.credentialRef}_ACCESS_KEY_ID`);
    const secretAccessKey = readSecret(env, `R2_${target.credentialRef}_SECRET_ACCESS_KEY`);
    if (!accessKeyId || !secretAccessKey) throw new MissingCredentialsError(target.credentialRef);
    this.aws = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
    const devOverride = config.isDev && env.DEV_S3_ENDPOINT ? env.DEV_S3_ENDPOINT.replace(/\/+$/, "") : null;
    const host = devOverride ?? `https://${target.accountId}.r2.cloudflarestorage.com`;
    this.base = `${host}/${target.bucket}`;
    this.bucketName = target.bucket;
  }

  private url(key: string): string {
    if (!KEY_RE.test(key) || key.includes("..")) throw new Error("invalid object key");
    return `${this.base}/${key}`;
  }

  private async send(op: string, url: string, init: RequestInit): Promise<Response> {
    const req = await this.aws.sign(url, init);
    try {
      return await this.fetchImpl(req);
    } catch {
      throw new StorageError(op, 0);
    }
  }

  /** Presigned PUT for a staging key. Content-Type is part of the signature. */
  async presignPut(key: string, contentType: string, expiresSeconds: number, contentLength: number): Promise<string> {
    const u = new URL(this.url(key));
    u.searchParams.set("X-Amz-Expires", String(expiresSeconds));
    const signed = await this.aws.sign(u.toString(), {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(contentLength) },
      // allHeaders: sign Content-Type and Content-Length, so the browser must send exactly them.
      aws: { signQuery: true, allHeaders: true },
    });
    return signed.url;
  }

  async head(key: string): Promise<ObjectHead | null> {
    const res = await this.send("head", this.url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new StorageError("head", res.status);
    const size = Number(res.headers.get("content-length"));
    const etag = res.headers.get("etag");
    if (!Number.isSafeInteger(size) || !etag) throw new StorageError("head", 502);
    return { size, etag };
  }

  /** Ranged GET. Returns the raw response so the body can be streamed. */
  async get(key: string, opts: { range?: { start: number; end: number }; ifMatch?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (opts.range) headers["Range"] = `bytes=${opts.range.start}-${opts.range.end}`;
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    const res = await this.send("get", this.url(key), { method: "GET", headers });
    if (res.status === 412) throw new StorageError("get", 412);
    if (res.status === 404) throw new StorageError("get", 404);
    if (!(res.status === 200 || res.status === 206)) throw new StorageError("get", res.status);
    return res;
  }

  /** Read the first `n` bytes (for content sniffing), pinned to an ETag. */
  async readHead(key: string, n: number, ifMatch: string, size: number): Promise<Uint8Array> {
    if (size === 0) return new Uint8Array();
    const res = await this.get(key, { range: { start: 0, end: Math.min(n, size) - 1 }, ifMatch });
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.subarray(0, n);
  }

  /**
   * Server-side copy guarded by the source ETag. If the staging object was
   * overwritten after we inspected it, R2 answers 412 and nothing is copied.
   */
  async copyIfMatch(srcKey: string, dstKey: string, srcEtag: string): Promise<"ok" | "precondition_failed"> {
    this.url(srcKey); // validates the key
    const res = await this.send("copy", this.url(dstKey), {
      method: "PUT",
      headers: {
        "x-amz-copy-source": `/${this.bucketName}/${srcKey}`,
        "x-amz-copy-source-if-match": srcEtag,
        "x-amz-metadata-directive": "REPLACE",
        "Content-Type": "application/octet-stream",
      },
    });
    if (res.status === 412) return "precondition_failed";
    // S3 CopyObject can return 200 with an <Error> body.
    const body = res.ok ? await res.text() : "";
    if (!res.ok || body.includes("<Error>")) {
      if (body.includes("PreconditionFailed")) return "precondition_failed";
      throw new StorageError("copy", res.ok ? 500 : res.status);
    }
    return "ok";
  }

  async put(key: string, body: string, contentType = "text/plain"): Promise<void> {
    const res = await this.send("put", this.url(key), { method: "PUT", body, headers: { "Content-Type": contentType } });
    if (!res.ok) throw new StorageError("put", res.status);
  }

  async delete(key: string): Promise<void> {
    const res = await this.send("delete", this.url(key), { method: "DELETE" });
    if (!(res.ok || res.status === 404)) throw new StorageError("delete", res.status);
  }

  /** CORS preflight against the bucket as the browser would send it. */
  async corsPreflight(origin: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/staging/cors-check`, {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "PUT",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      const allowOrigin = res.headers.get("access-control-allow-origin");
      const allowMethods = (res.headers.get("access-control-allow-methods") ?? "").toUpperCase();
      return res.ok && (allowOrigin === origin || allowOrigin === "*") && allowMethods.includes("PUT");
    } catch {
      return false;
    }
  }
}

export class MissingCredentialsError extends Error {
  constructor(readonly ref: string) {
    super(`missing credentials for ${ref}`);
  }
}

export function isValidAccountId(s: string) {
  return ACCOUNT_RE.test(s);
}
export function isValidBucket(s: string) {
  return BUCKET_RE.test(s) && !s.includes("--");
}
