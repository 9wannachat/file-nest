/** Header helpers for controlled content and API responses. */

/** RFC 6266 / 5987 Content-Disposition with a safe ASCII fallback. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const cleaned = filename.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "download";
  const ascii = cleaned.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_").replace(/[;]/g, "_");
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Headers for any permission-controlled response. */
export function noStore(h: Headers): Headers {
  h.set("Cache-Control", "no-store, private");
  h.set("Pragma", "no-cache");
  h.set("X-Content-Type-Options", "nosniff");
  return h;
}

/**
 * CSP for streamed user content. Everything except PDF is sandboxed so even a
 * mislabelled file cannot run script on the app origin. Chromium's PDF viewer
 * refuses to render in a sandboxed document, so PDF only gets frame-ancestors.
 */
export function contentCsp(contentType: string, disposition: "inline" | "attachment"): string {
  if (disposition === "inline" && contentType === "application/pdf") {
    return "frame-ancestors 'self'";
  }
  return "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
}
