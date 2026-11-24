/**
 * Local fake R2 (S3 API) on http://localhost:9000 for `pnpm dev`.
 * Objects persist under .dev-data/fake-s3/. Never use in production.
 *   node scripts/fake-s3.ts
 */
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createFakeS3, type ObjectStore, type StoredObject } from "../src/dev/fake-s3.ts";

const PORT = Number(process.env.FAKE_S3_PORT ?? 9000);
const DIR = process.env.FAKE_S3_DIR ?? join(process.cwd(), ".dev-data", "fake-s3");
mkdirSync(DIR, { recursive: true });
const fileFor = (k: string) => join(DIR, createHash("sha256").update(k).digest("hex"));

const disk: ObjectStore = {
  async get(k) {
    const p = fileFor(k);
    if (!existsSync(p + ".json")) return undefined;
    const meta = JSON.parse(readFileSync(p + ".json", "utf8")) as Omit<StoredObject, "body">;
    return { ...meta, body: new Uint8Array(readFileSync(p + ".bin")) };
  },
  async put(k, o) {
    const p = fileFor(k);
    writeFileSync(p + ".bin", o.body);
    writeFileSync(p + ".json", JSON.stringify({ etag: o.etag, contentType: o.contentType, key: k }));
  },
  async delete(k) {
    const p = fileFor(k);
    rmSync(p + ".bin", { force: true });
    rmSync(p + ".json", { force: true });
  },
  async keys() {
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => (JSON.parse(readFileSync(join(DIR, f), "utf8")) as { key: string }).key);
  },
};

const origins = (process.env.FAKE_S3_ORIGINS ?? "http://localhost:8788,http://127.0.0.1:8788").split(",");
const s3 = createFakeS3({ store: disk, allowedOrigins: origins });

createServer(async (req, res) => {
  // A browser that reloads mid-upload aborts its request: never let that crash the server.
  try {
    await serve(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, () => console.log(`[fake-s3] listening on http://localhost:${PORT} (CORS: ${origins.join(", ")})`));

async function serve(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
  const request = new Request(`http://${req.headers.host}${req.url}`, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
  const out = await s3.handle(request);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(req.method === "HEAD" ? undefined : Buffer.from(await out.arrayBuffer()));
}
