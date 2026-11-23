/**
 * Stream a file from R2 through the Worker. Never redirects to R2 and never
 * exposes R2 hosts, keys or signed URLs. Supports HEAD and single byte ranges.
 */
import type { FileRow } from "../db/schema.ts";
import { log } from "../lib/log.ts";
import { contentCsp, contentDisposition, noStore } from "../lib/headers.ts";
import { parseRange } from "../lib/range.ts";
import { StorageError } from "../storage/s3.ts";
import { bucketById, type StorageCtx } from "./storage.ts";

export type ContentMode = "preview" | "download";

export async function serveFile(ctx: StorageCtx, file: FileRow, req: Request, mode: ContentMode, opts: { share?: boolean } = {}) {
  const disposition = mode === "preview" && file.inlineOk ? "inline" : "attachment";
  const contentType = disposition === "inline" ? file.contentType : file.inlineOk ? file.contentType : "application/octet-stream";

  const h = noStore(new Headers());
  h.set("Content-Type", contentType);
  h.set("Content-Disposition", contentDisposition(disposition, file.name));
  h.set("Content-Security-Policy", contentCsp(file.contentType, disposition));
  h.set("Accept-Ranges", "bytes");
  h.set("ETag", file.etag.startsWith('"') || file.etag.startsWith("W/") ? file.etag : `"${file.etag}"`);
  h.set("Last-Modified", new Date(file.createdAt).toUTCString());
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  h.set("X-Frame-Options", "SAMEORIGIN");
  h.set("Referrer-Policy", "no-referrer");
  if (opts.share) h.set("X-Robots-Tag", "noindex, nofollow");

  // If-Range with a different validator => full response (RFC 9110 §13.1.5).
  const ifRange = req.headers.get("If-Range");
  const rangeHeader = ifRange && ifRange !== h.get("ETag") ? null : req.headers.get("Range");
  const range = parseRange(rangeHeader, file.size);

  if (range.kind === "unsatisfiable") {
    h.set("Content-Range", `bytes */${file.size}`);
    h.set("Content-Length", "0");
    h.delete("Content-Disposition");
    return new Response(null, { status: 416, headers: h });
  }

  const status = range.kind === "partial" ? 206 : 200;
  const length = range.kind === "partial" ? range.end - range.start + 1 : file.size;
  if (range.kind === "partial") h.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
  h.set("Content-Length", String(length));

  if (req.method === "HEAD") return new Response(null, { status, headers: h });
  if (length === 0) return new Response(null, { status, headers: h });

  try {
    const bucket = await bucketById(ctx, file.storageId);
    const res = await bucket.get(file.objectKey, {
      range: range.kind === "partial" ? { start: range.start, end: range.end } : undefined,
      ifMatch: file.etag,
    });
    const upstreamLen = Number(res.headers.get("content-length"));
    if (Number.isSafeInteger(upstreamLen) && upstreamLen !== length) {
      log.error("content.length_mismatch", { fileId: file.id });
      await res.body?.cancel();
      return storageErrorResponse();
    }
    // Stream through: only OUR headers go to the client.
    return new Response(res.body, { status, headers: h });
  } catch (e) {
    log.warn("content.storage_error", { fileId: file.id, status: e instanceof StorageError ? e.status : 0 });
    return storageErrorResponse();
  }
}

function storageErrorResponse() {
  const h = noStore(new Headers({ "Content-Type": "application/json" }));
  return new Response(JSON.stringify({ error: { code: "storage_unavailable", message: "File is temporarily unavailable" } }), {
    status: 502,
    headers: h,
  });
}
