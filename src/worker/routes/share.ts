/**
 * Public "anyone with the link" routes. The token is re-checked on every request.
 * Optional password: POST /s/:token/unlock sets an HMAC-signed cookie scoped to
 * Path=/s/<token>, bound to the link id + password version, valid 12 h.
 */
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { serveFile } from "../services/content.ts";
import { attemptUnlock, isUnlocked, linkForToken, makeUnlockCookie, UNLOCK_TTL_MS, unlockClientKey } from "../services/shares.ts";
import { appOrigin } from "../auth/middleware.ts";
import { getSettings } from "../services/settings.ts";
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
  "default-src 'none'; img-src 'self'; media-src 'self'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/* Light by default; dark when the viewer chose Dark in FileNest (fn_theme cookie) or System + OS dark. */
const DARK_VARS = "--tint:#ffffff0d;--bg:#11151f;--fg:#e8ecf2;--card:#181d29;--border:#262d3b;--muted:#9aa4b5;--brand:#3fb8a8;--brand-fg:#0d1f1d;--err:#fca5a5;--input:#0f131b";
const STYLE = `
:root{--tint:#0f172a0d;--bg:#f8fafc;--fg:#0f172a;--card:#fff;--border:#e2e8f0;--muted:#64748b;--brand:#0f766e;--brand-fg:#fff;--err:#b91c1c;--input:#fff;color-scheme:light}
:root.dark{${DARK_VARS};color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not(.light){${DARK_VARS};color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:.6rem;padding:.9rem 1.25rem;border-bottom:1px solid var(--border);background:var(--card)}
header b{color:var(--brand)}main{max-width:960px;margin:0 auto;padding:1.25rem}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1rem 1.25rem}
h1{font-size:1.15rem;margin:0 0 .25rem;word-break:break-word}.meta{color:var(--muted);font-size:.9rem}
input{background:var(--input);color:var(--fg);border-color:var(--border)!important}
.preview{margin:1rem 0;background:var(--tint);border-radius:8px;overflow:hidden;display:flex;justify-content:center}
.preview img,.preview video{max-width:100%;max-height:75vh;display:block}.preview iframe{width:100%;height:75vh;border:0}
.preview audio{width:100%;margin:1rem}
.btn{display:inline-flex;align-items:center;min-height:44px;padding:0 1.1rem;border-radius:8px;background:var(--brand);color:var(--brand-fg);text-decoration:none;font-weight:600}
.btn:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}
.err{color:var(--err);font-weight:600}
`;

/** Share page text. Language follows the viewer's FileNest choice (fn_lang cookie), else Accept-Language. */
const TEXT = {
  en: {
    sharedFile: "Shared file",
    unavailableTitle: "Link unavailable",
    unavailable: "This link is not available",
    unavailableHint: "It may have been revoked, or the file was removed.",
    pwTitle: "Password required",
    pwHeading: "This file is password protected",
    pwHint: "Enter the password you received from the person who shared it.",
    password: "Password",
    unlock: "Unlock",
    sameOrigin: "Please submit the form from this page.",
    locked: "Too many attempts. Try again in {n} minute(s).",
    wrong: "Incorrect password.",
    noPreview: "Preview is not available for this file type.",
    download: "Download",
  },
  th: {
    sharedFile: "ไฟล์ที่แชร์",
    unavailableTitle: "ลิงก์ใช้งานไม่ได้",
    unavailable: "ลิงก์นี้ใช้งานไม่ได้",
    unavailableHint: "ลิงก์อาจถูกเพิกถอน หรือไฟล์ถูกลบไปแล้ว",
    pwTitle: "ต้องใช้รหัสผ่าน",
    pwHeading: "ไฟล์นี้ป้องกันด้วยรหัสผ่าน",
    pwHint: "กรอกรหัสผ่านที่ได้รับจากผู้แชร์ไฟล์",
    password: "รหัสผ่าน",
    unlock: "ปลดล็อก",
    sameOrigin: "กรุณาส่งฟอร์มจากหน้านี้",
    locked: "ลองหลายครั้งเกินไป ลองใหม่ในอีก {n} นาที",
    wrong: "รหัสผ่านไม่ถูกต้อง",
    noPreview: "ดูตัวอย่างไฟล์ประเภทนี้ไม่ได้",
    download: "ดาวน์โหลด",
  },
} satisfies Record<string, Record<string, string>>;
type Lang = keyof typeof TEXT;

/** How the viewer wants the page: theme class ("dark" | "light" | "" = follow the OS) and language. */
interface View {
  theme: string;
  lang: Lang;
}

export function shareLang(cookie: string | undefined, acceptLanguage: string | undefined): Lang {
  if (cookie === "th" || cookie === "en") return cookie;
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("th") ? "th" : "en";
}

function viewOf(c: Context<AppEnv>): View {
  const t = getCookie(c, "fn_theme");
  return { theme: t === "dark" || t === "light" ? t : "", lang: shareLang(getCookie(c, "fn_lang"), c.req.header("Accept-Language")) };
}

function page(title: string, body: string, status: number, v: View) {
  const html = `<!doctype html><html lang="${v.lang}"${v.theme ? ` class="${v.theme}"` : ""}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>${esc(title)} · FileNest</title>
<style>${STYLE}</style></head><body><header><b>FileNest</b><span class="meta">${TEXT[v.lang].sharedFile}</span></header><main>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Language": v.lang,
      Vary: "Cookie, Accept-Language",
      "Content-Security-Policy": PAGE_CSP,
      "X-Frame-Options": "DENY",
    },
  });
}

function notAvailable(v: View) {
  const x = TEXT[v.lang];
  return page(x.unavailableTitle, `<div class="card"><h1>${x.unavailable}</h1><p class="meta">${x.unavailableHint}</p></div>`, 404, v);
}

const UNLOCK_COOKIE = "fn_unlock";

async function resolve(c: Context<AppEnv>) {
  try {
    const found = await linkForToken(c.get("db"), c.req.param("token") ?? "");
    const s = await getSettings(c.get("db"), c.get("config"));
    // Admin policy: links off entirely, or links without a password are inactive.
    if (!s.publicLinksEnabled || (s.publicLinksRequirePassword && !found.link.passwordHash)) return null;
    return found;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

async function unlocked(c: Context<AppEnv>, link: Awaited<ReturnType<typeof linkForToken>>["link"]) {
  return isUnlocked(c.env, link, getCookie(c, UNLOCK_COOKIE), c.get("deps").now());
}

function passwordPage(base: string, message: string | null, status: number, v: View) {
  const x = TEXT[v.lang];
  // The file name and size stay hidden until the password is accepted.
  return page(
    x.pwTitle,
    `<div class="card"><h1>${x.pwHeading}</h1>
<p class="meta">${x.pwHint}</p>
${message ? `<p role="alert" class="err">${esc(message)}</p>` : ""}
<form method="post" action="${base}/unlock" style="display:flex;flex-direction:column;gap:.75rem;margin-top:1rem;max-width:22rem">
<label for="pw" style="font-weight:600">${x.password}</label>
<input id="pw" name="password" type="password" required autocomplete="current-password" maxlength="512" autofocus
 style="min-height:44px;padding:0 .75rem;border:1px solid #cbd5e1;border-radius:8px;font:inherit">
<button class="btn" type="submit" style="border:0;cursor:pointer;font:inherit;font-weight:600">${x.unlock}</button>
</form></div>`,
    status,
    v,
  );
}

shareRoutes.post("/:token/unlock", async (c) => {
  const found = await resolve(c);
  const v = viewOf(c);
  if (!found) return notAvailable(v);
  const base = `/s/${encodeURIComponent(c.req.param("token"))}`;
  // Same-origin form posts only. Note: with Referrer-Policy: no-referrer browsers
  // send "Origin: null" on this form post, so Sec-Fetch-Site is the primary signal.
  const sameSite = c.req.header("Sec-Fetch-Site") === "same-origin" || c.req.header("Origin") === appOrigin(c);
  if (!sameSite) {
    return passwordPage(base, TEXT[v.lang].sameOrigin, 403, v);
  }
  if (!found.link.passwordHash) return c.redirect(base, 303);
  let password = "";
  try {
    const form = await c.req.formData();
    const pw = form.get("password");
    password = typeof pw === "string" ? pw : "";
  } catch {
    password = "";
  }
  const now = c.get("deps").now();
  const clientKey = await unlockClientKey(found.link.id, c.req.header("CF-Connecting-IP"));
  const r = await attemptUnlock(c.get("db"), found.link, clientKey, password, now);
  if (!r.ok) {
    if (r.reason === "locked") {
      const res = passwordPage(base, TEXT[v.lang].locked.replace("{n}", String(Math.ceil(r.retryAfterMs / 60_000))), 429, v);
      res.headers.set("Retry-After", String(Math.ceil(r.retryAfterMs / 1000)));
      return res;
    }
    return passwordPage(base, TEXT[v.lang].wrong, 401, v);
  }
  setCookie(c, UNLOCK_COOKIE, await makeUnlockCookie(c.env, found.link, now), {
    httpOnly: true,
    secure: c.get("config").secureCookies,
    sameSite: "Strict",
    path: base,
    maxAge: UNLOCK_TTL_MS / 1000,
  });
  return c.redirect(base, 303);
});

shareRoutes.get("/:token", async (c) => {
  const found = await resolve(c);
  const v = viewOf(c);
  if (!found) return notAvailable(v);
  const base = `/s/${encodeURIComponent(c.req.param("token"))}`;
  if (!(await unlocked(c, found.link))) return passwordPage(base, null, 401, v);
  const file = found.file;
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
${preview ? `<div class="preview">${preview}</div>` : `<p class="meta">${TEXT[v.lang].noPreview}</p>`}
<a class="btn" href="${base}/download">${TEXT[v.lang].download}</a></div>`,
    200,
    v,
  );
});

for (const mode of ["preview", "download"] as const) {
  shareRoutes.get(`/:token/${mode}`, async (c) => {
    const found = await resolve(c);
    if (!found) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
    if (!(await unlocked(c, found.link))) {
      return c.json({ error: { code: "password_required", message: "Password required" } }, 401);
    }
    return serveFile(storageCtx(c), found.file, c.req.raw, mode, { share: true });
  });
}
