import type { ContentfulStatusCode } from "hono/utils/http-status";

/** Errors safe to show to clients. Never put secrets, keys or URLs in `message`. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message?: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message ?? code);
  }
}

export const notFound = (what = "not_found") => new HttpError(404, what, "Not found");
export const forbidden = (msg = "Forbidden") => new HttpError(403, "forbidden", msg);
export const badRequest = (code: string, msg?: string) => new HttpError(400, code, msg ?? code);
export const conflict = (code: string, msg?: string) => new HttpError(409, code, msg ?? code);
