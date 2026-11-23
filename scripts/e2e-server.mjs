// Isolated server for Playwright. Generates .wrangler/e2e/{wrangler.jsonc,.dev.vars}
// (git-ignored), a fresh local D1, fake R2 on :9001 and the app on :8789.
// Does not touch your `pnpm dev` data, wrangler.jsonc or .dev.vars.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const DIR = ".wrangler/e2e";
const CONFIG = `${DIR}/wrangler.jsonc`;
const STATE = `${DIR}/state`;
const S3DIR = `${DIR}/s3`;
rmSync(DIR, { recursive: true, force: true });
mkdirSync(S3DIR, { recursive: true });

writeFileSync(
  CONFIG,
  readFileSync("wrangler.example.jsonc", "utf8")
    .replace('"main": "src/worker/index.ts"', '"main": "../../src/worker/index.ts"')
    .replace('"migrations_dir": "migrations"', '"migrations_dir": "../../migrations"'),
);
writeFileSync(
  `${DIR}/.dev.vars`,
  [
    "ENVIRONMENT=development",
    "APP_ORIGIN=http://localhost:8789",
    "DEV_AUTH=1",
    "DEV_S3_ENDPOINT=http://localhost:9001",
    "R2_LOCAL_ACCESS_KEY_ID=e2e-access-key",
    "R2_LOCAL_SECRET_ACCESS_KEY=e2e-secret-key",
    "BOOTSTRAP_ADMIN_EMAIL=admin@example.test",
    "APP_ENCRYPTION_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    "GOOGLE_CLIENT_ID=e2e",
    "GOOGLE_CLIENT_SECRET=e2e",
  ].join("\n"),
);

const wr = (args) => execFileSync("pnpm", ["exec", "wrangler", ...args, "--config", CONFIG, "--persist-to", STATE], { stdio: "inherit" });
wr(["d1", "migrations", "apply", "DB", "--local"]);
wr(["d1", "execute", "DB", "--local", "--file", "scripts/seed-local.sql"]);

const env = {
  ...process.env,
  FILENEST_WRANGLER_CONFIG: CONFIG,
  FILENEST_STATE_DIR: STATE,
  FAKE_S3_PORT: "9001",
  FAKE_S3_DIR: S3DIR,
  FAKE_S3_ORIGINS: "http://localhost:8789",
  FILENEST_CSP_CONNECT_EXTRA: "http://localhost:9001",
};
const mode = process.argv[2] ?? "dev"; // "dev", or "preview" = built bundle with service worker
const procs = [spawn(process.execPath, ["scripts/fake-s3.ts"], { stdio: "inherit", env })];
if (mode === "preview") {
  execFileSync("pnpm", ["exec", "vite", "build"], { stdio: "inherit", env });
  procs.push(spawn("pnpm", ["exec", "vite", "preview", "--port", "8789", "--strictPort"], { stdio: "inherit", env }));
} else {
  procs.push(spawn("pnpm", ["exec", "vite", "--port", "8789", "--strictPort"], { stdio: "inherit", env }));
}
const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
