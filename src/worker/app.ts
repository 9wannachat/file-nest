import { Hono } from "hono";
import type { AppEnv, Deps, Env } from "./env.ts";
import { loadConfig } from "./env.ts";
import { getDb } from "./db/client.ts";
import { HttpError } from "./lib/errors.ts";
import { log, safePath } from "./lib/log.ts";
import { api } from "./routes/api.ts";
import { authRoutes } from "./routes/auth.ts";
import { shareRoutes } from "./routes/share.ts";

export function defaultDeps(): Deps {
  return {
    s3Fetch: (input, init) => fetch(input, init),
    oauthFetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
  };
}

export function createApp(overrides: Partial<Deps> = {}) {
  const deps: Deps = { ...defaultDeps(), ...overrides };
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("config", loadConfig(c.env));
    c.set("db", getDb(c.env.DB));
    c.set("requestId", crypto.randomUUID());
    await next();
  });

  app.route("/api", api);
  app.route("/auth", authRoutes);
  app.route("/s", shareRoutes);

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" } }, 404, { "Cache-Control": "no-store" }),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        { error: { code: err.code, message: err.message, ...(err.extra ?? {}) } },
        err.status,
        { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      );
    }
    log.error("unhandled", {
      requestId: c.get("requestId"),
      path: safePath(c.req.url),
      method: c.req.method,
      error: err instanceof Error ? `${err.name}: ${err.message}` : "unknown",
    });
    return c.json(
      { error: { code: "internal", message: "Something went wrong", requestId: c.get("requestId") } },
      500,
      { "Cache-Control": "no-store" },
    );
  });

  return app;
}

export type App = ReturnType<typeof createApp>;
export type { Env };
