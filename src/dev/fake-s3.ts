/**
 * Minimal in-process fake of the R2 S3 API, for tests and local development.
 * Supports: presigned PUT, PUT, HEAD, GET (+Range, If-Match), CopyObject with
 * x-amz-copy-source-if-match, DELETE, and CORS preflight.
 *
 * It does NOT verify SigV4 signatures (only presence + expiry). Never deploy it.
 * Written with erasable TypeScript only so Node can run it directly.
 */

export interface StoredObject {
  body: Uint8Array;
  etag: string;
  contentType: string;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | undefined>;
  put(key: string, obj: StoredObject): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export function memoryStore(): ObjectStore & { map: Map<string, StoredObject> } {
  const map = new Map<string, StoredObject>();
  return {
    map,
    get: async (k) => map.get(k),
    put: async (k, o) => {
      map.set(k, o);
    },
    delete: async (k) => {
      map.delete(k);
    },
    keys: async () => [...map.keys()],
  };
}

export interface FakeS3Options {
  store?: ObjectStore;
  allowedOrigins?: string[];
  now?: () => number;
  /** Simulate a provider that ignores x-amz-copy-source-if-match. */
  ignoreCopyIfMatch?: boolean;
}

export interface LoggedRequest {
  method: string;
  host: string;
  path: string;
  accessKeyId: string | null;
  presigned: boolean;
  range: string | null;
}

async function etagOf(body: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", body as unknown as ArrayBuffer);
  const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 32)}"`;
}

const unquote = (s: string) => s.replace(/^W\//, "").replace(/^"|"$/g, "");

function xmlError(status: number, code: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, {
    status,
    headers: { "Content-Type": "application/xml" },
  });
}

export function createFakeS3(opts: FakeS3Options = {}) {
  const store = opts.store ?? memoryStore();
  const allowed = opts.allowedOrigins ?? [];
  const now = opts.now ?? (() => Date.now());
  const requests: LoggedRequest[] = [];

  function corsHeaders(origin: string | null): Record<string, string> {
    if (!origin || !allowed.includes(origin)) return {};
    return {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "PUT, GET, HEAD",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Expose-Headers": "ETag",
      "Access-Control-Max-Age": "3600",
      Vary: "Origin",
    };
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const bucket = parts.shift() ?? "";
    const key = parts.join("/");
    const objKey = `${url.host}/${bucket}/${key}`;
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(origin);

    const auth = req.headers.get("Authorization");
    const presigned = url.searchParams.has("X-Amz-Signature");
    const cred = auth ? /Credential=([^/,\s]+)/.exec(auth)?.[1] : url.searchParams.get("X-Amz-Credential")?.split("/")[0];
    requests.push({
      method: req.method,
      host: url.host,
      path: `/${bucket}/${key}`,
      accessKeyId: cred ?? null,
      presigned,
      range: req.headers.get("Range"),
    });

    if (req.method === "OPTIONS") {
      return new Response(null, { status: cors["Access-Control-Allow-Origin"] ? 200 : 403, headers: cors });
    }
    if (!bucket || !key) return xmlError(400, "InvalidRequest");

    if (presigned) {
      const amzDate = url.searchParams.get("X-Amz-Date") ?? "";
      const expires = Number(url.searchParams.get("X-Amz-Expires") ?? "0");
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
      if (!m) return xmlError(403, "AccessDenied");
      const signedAt = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      if (now() > signedAt + expires * 1000) return xmlError(403, "AccessDenied");
      if (req.method !== "PUT") return xmlError(403, "AccessDenied");
    } else if (!auth || !auth.startsWith("AWS4-HMAC-SHA256")) {
      return xmlError(403, "AccessDenied");
    }

    if (req.method === "PUT") {
      const copySource = req.headers.get("x-amz-copy-source");
      if (copySource) {
        const src = decodeURIComponent(copySource.replace(/^\//, ""));
        const srcObj = await store.get(`${url.host}/${src}`);
        if (!srcObj) return xmlError(404, "NoSuchKey");
        const ifMatch = req.headers.get("x-amz-copy-source-if-match");
        if (ifMatch && !opts.ignoreCopyIfMatch && unquote(ifMatch) !== unquote(srcObj.etag)) {
          return xmlError(412, "PreconditionFailed");
        }
        await store.put(objKey, { ...srcObj, contentType: req.headers.get("Content-Type") ?? srcObj.contentType });
        return new Response(`<CopyObjectResult><ETag>${srcObj.etag}</ETag></CopyObjectResult>`, {
          status: 200,
          headers: { "Content-Type": "application/xml" },
        });
      }
      const body = new Uint8Array(await req.arrayBuffer());
      const etag = await etagOf(body);
      await store.put(objKey, { body, etag, contentType: req.headers.get("Content-Type") ?? "application/octet-stream" });
      return new Response(null, { status: 200, headers: { ETag: etag, ...cors } });
    }

    if (req.method === "DELETE") {
      await store.delete(objKey);
      return new Response(null, { status: 204 });
    }

    const obj = await store.get(objKey);
    if (!obj) return req.method === "HEAD" ? new Response(null, { status: 404 }) : xmlError(404, "NoSuchKey");
    const ifMatch = req.headers.get("If-Match");
    if (ifMatch && unquote(ifMatch) !== unquote(obj.etag)) return xmlError(412, "PreconditionFailed");

    const size = obj.body.length;
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.get("Range");
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return xmlError(416, "InvalidRange");
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size || end < start) return xmlError(416, "InvalidRange");
      status = 206;
    }
    const headers: Record<string, string> = {
      "Content-Type": obj.contentType,
      "Content-Length": String(end - start + 1),
      ETag: obj.etag,
      "Accept-Ranges": "bytes",
      // Simulate R2 response headers that must never be forwarded to clients.
      "x-amz-request-id": "fake-request",
      Server: "fake-r2",
      ...cors,
    };
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    if (req.method === "HEAD") return new Response(null, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
    return new Response(obj.body.slice(start, end + 1), { status, headers });
  }

  return {
    store,
    requests,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      handle(input instanceof Request && !init ? input : new Request(input, init))) as typeof fetch,
    handle,
  };
}

export type FakeS3 = ReturnType<typeof createFakeS3>;
