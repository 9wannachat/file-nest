import { createApp, defaultDeps } from "./app.ts";
import type { Env } from "./env.ts";
import { loadConfig } from "./env.ts";
import { getDb } from "./db/client.ts";
import { runCleanup } from "./services/cleanup.ts";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCleanup({ db: getDb(env.DB), env, config: loadConfig(env), deps: defaultDeps() }));
  },
} satisfies ExportedHandler<Env>;
