import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { timingSafeEqual } from "../lib/crypto.ts";
import { loadSession } from "./session.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin the app is served from (configured, else the request's own). */
export function appOrigin(c: { req: { url: string }; get: (k: "config") => { appOrigin: string | null } }) {
  return c.get("config").appOrigin ?? new URL(c.req.url).origin;
}

/**
 * Origin check for state-changing cookie-authenticated requests.
 * Requires Origin == app origin, or (no Origin) Sec-Fetch-Site: same-origin.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  const origin = c.req.header("Origin");
  const expected = appOrigin(c);
  if (origin) {
    if (origin !== expected) throw new HttpError(403, "bad_origin", "Cross-origin request blocked");
  } else if (c.req.header("Sec-Fetch-Site") !== "same-origin") {
    throw new HttpError(403, "bad_origin", "Cross-origin request blocked");
  }
  return next();
};

/** Require an active member. Also enforces the per-session CSRF token on unsafe methods. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await loadSession(c);
  if (!auth) throw new HttpError(401, "unauthenticated", "Sign in required");
  if (!SAFE_METHODS.has(c.req.method)) {
    const token = c.req.header("X-CSRF-Token") ?? "";
    if (!timingSafeEqual(token, auth.session.csrfToken)) {
      throw new HttpError(403, "bad_csrf", "Invalid CSRF token");
    }
  }
  c.set("auth", auth);
  return next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth || auth.user.role !== "admin") throw new HttpError(403, "forbidden", "Admin only");
  return next();
};

export function authOf(c: { get: (k: "auth") => AppEnv["Variables"]["auth"] }) {
  const a = c.get("auth");
  if (!a) throw new HttpError(401, "unauthenticated", "Sign in required");
  return a;
}
