/** Public "anyone with the link" routes. No cookies needed; token re-checked on every request. */
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { serveFile } from "../services/content.ts";
import { fileForToken } from "../services/shares.ts";
import { storageCtx } from "./util.ts";

export const shareRoutes = new Hono<AppEnv>();

shareRoutes.use("*", async (c, next) => {
  await next();
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store, private");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Robots-Tag", "noindex, nofollow");
});

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function formatBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
}

const PAGE_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f8fafc;color:#0f172a}
header{display:flex;align-items:center;gap:.6rem;padding:.9rem 1.25rem;border-bottom:1px solid #e2e8f0;background:#fff}
header b{color:#0f766e}main{max-width:960px;margin:0 auto;padding:1.25rem}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:1rem 1.25rem}
h1{font-size:1.15rem;margin:0 0 .25rem;word-break:break-word}.meta{color:#64748b;font-size:.9rem}
.preview{margin:1rem 0;background:#0f172a0d;border-radius:8px;overflow:hidden;display:flex;justify-content:center}
.preview img,.preview video{max-width:100%;max-height:75vh;display:block}.preview iframe{width:100%;height:75vh;border:0}
.preview audio{width:100%;margin:1rem}
a.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 1.1rem;border-radius:8px;background:#0f766e;color:#fff;text-decoration:none;font-weight:600}
a.btn:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
@media (prefers-color-scheme:dark){body{background:#0b1220;color:#e2e8f0}header,.card{background:#111a2e;border-color:#1e293b}.meta{color:#94a3b8}}
`;

function page(title: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · FileNest</title>
<style>${STYLE}</style></head><body><header><b>FileNest</b><span class="meta">Shared file</span></header><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CSP, "X-Frame-Options": "DENY" },
  });
}

function notAvailable() {
  return page(
    "Link unavailable",
    `<div class="card"><h1>This link is not available</h1><p class="meta">It may have been revoked, or the file was removed.</p></div>`,
    404,
  );
}

async function resolve(c: Context<AppEnv>) {
  try {
    return await fileForToken(c.get("db"), c.req.param("token") ?? "");
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

shareRoutes.get("/:token", async (c) => {
  const file = await resolve(c);
  if (!file) return notAvailable();
  const base = `/s/${encodeURIComponent(c.req.param("token"))}`;
  const ct = file.contentType;
  let preview = "";
  if (file.inlineOk) {
    if (ct.startsWith("image/")) preview = `<img src="${base}/preview" alt="${esc(file.name)}">`;
    else if (ct.startsWith("video/")) preview = `<video src="${base}/preview" controls preload="metadata" playsinline></video>`;
    else if (ct.startsWith("audio/")) preview = `<audio src="${base}/preview" controls preload="metadata"></audio>`;
    else if (ct === "application/pdf" || ct.startsWith("text/plain"))
      preview = `<iframe src="${base}/preview" title="${esc(file.name)}"></iframe>`;
  }
  return page(
    file.name,
    `<div class="card"><h1>${esc(file.name)}</h1><div class="meta">${formatBytes(file.size)}</div>
${preview ? `<div class="preview">${preview}</div>` : `<p class="meta">Preview is not available for this file type.</p>`}
<a class="btn" href="${base}/download">Download</a></div>`,
  );
});

for (const mode of ["preview", "download"] as const) {
  shareRoutes.get(`/:token/${mode}`, async (c) => {
    const file = await resolve(c);
    if (!file) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    return serveFile(storageCtx(c), file, c.req.raw, mode, { share: true });
  });
}
