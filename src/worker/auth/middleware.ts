import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env.ts";
import { HttpError } from "../lib/errors.ts";
import { timingSafeEqual } from "../lib/crypto.ts";
import { authenticateBearer, hasScope, type Scope } from "../services/tokens.ts";
import { loadSession, sessionCookieName } from "./session.ts";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The origin the app is served from (configured, else the request's own). */
export function appOrigin(c: { req: { url: string }; get: (k: "config") => { appOrigin: string | null } }) {
  return c.get("config").appOrigin ?? new URL(c.req.url).origin;
}

/**
 * Endpoints a personal access token may call, and the scope each needs.
 * Everything else (admin, sharing, trash/delete, rename/move, token management)
 * is cookie-session only.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TOKEN_ROUTES: [method: "GET" | "POST", path: RegExp, scope: Scope][] = [
  ["GET", /^\/api\/me$/, "files:read"],
  ["GET", new RegExp(`^/api/folders/(root|${UUID})$`), "files:read"],
  ["GET", /^\/api\/search$/, "files:read"],
  ["GET", /^\/api\/shared$/, "files:read"],
  ["GET", new RegExp(`^/api/files/${UUID}(/preview|/download)?$`), "files:read"],
  ["POST", /^\/api\/folders$/, "files:write"],
  ["POST", /^\/api\/uploads$/, "files:write"],
  ["POST", new RegExp(`^/api/uploads/${UUID}/(finalize|abort)$`), "files:write"],
];

export function tokenRouteScope(method: string, path: string): Scope | null {
  const m = method === "HEAD" ? "GET" : method;
  return TOKEN_ROUTES.find(([rm, re]) => rm === m && re.test(path))?.[2] ?? null;
}

const bearerOf = (h: string | undefined) => (h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, "").trim() : null);

/**
 * Origin check for state-changing cookie-authenticated requests.
 * Requires Origin == app origin, or (no Origin) Sec-Fetch-Site: same-origin.
 * Bearer-token requests are exempt: browsers cannot attach an Authorization
 * header cross-origin without a CORS preflight, which this API never grants.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();
  // Only a Bearer token WITHOUT a session cookie is exempt (requireUser then validates it).
  // Browsers may attach other Authorization schemes (e.g. Basic behind a proxy) automatically.
  if (bearerOf(c.req.header("Authorization")) && !getCookie(c, sessionCookieName(c.get("config")))) return next();
  const origin = c.req.header("Origin");
  const expected = appOrigin(c);
  if (origin) {
    if (origin !== expected) throw new HttpError(403, "bad_origin", "Cross-origin request blocked");
  } else if (c.req.header("Sec-Fetch-Site") !== "same-origin") {
    throw new HttpError(403, "bad_origin", "Cross-origin request blocked");
  }
  return next();
};

/**
 * Require an active member, by cookie session (+ CSRF on unsafe methods) or by
 * personal access token (scoped, allowlisted endpoints). Never both at once.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (authHeader !== undefined) {
    if (getCookie(c, sessionCookieName(c.get("config")))) {
      throw new HttpError(400, "ambiguous_auth", "Send either a session cookie or a bearer token, not both");
    }
    const raw = bearerOf(authHeader);
    if (!raw) throw new HttpError(401, "invalid_token", "Invalid bearer token");
    const scope = tokenRouteScope(c.req.method, c.req.path);
    if (!scope) throw new HttpError(403, "token_not_allowed", "This endpoint is not available to API tokens");
    const r = await authenticateBearer(c.get("db"), raw, c.get("deps").now());
    if (!r.ok) {
      if (r.status === 429) throw new HttpError(429, "rate_limited", "Too many requests for this token");
      throw new HttpError(401, "invalid_token", "Invalid, expired or revoked token");
    }
    if (!hasScope(r.token, scope)) throw new HttpError(403, "insufficient_scope", `Token lacks scope ${scope}`);
    c.set("auth", { user: r.user, token: r.token });
    return next();
  }

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

/** Admin endpoints are cookie-session only. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth || !auth.session || auth.user.role !== "admin") throw new HttpError(403, "forbidden", "Admin only");
  return next();
};

export function authOf(c: { get: (k: "auth") => AppEnv["Variables"]["auth"] }) {
  const a = c.get("auth");
  if (!a) throw new HttpError(401, "unauthenticated", "Sign in required");
  return a;
}

/** Session object for cookie-only endpoints (e.g. token management). */
export function sessionOf(c: { get: (k: "auth") => AppEnv["Variables"]["auth"] }) {
  const a = authOf(c);
  if (!a.session) throw new HttpError(403, "token_not_allowed", "Sign in with a browser session");
  return a;
}
