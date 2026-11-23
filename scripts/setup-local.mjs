// One-time local setup: config files, encryption key, local D1 migrations and
// a local storage target pointing at the fake S3. Safe to re-run.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

if (!existsSync("wrangler.jsonc")) {
  copyFileSync("wrangler.example.jsonc", "wrangler.jsonc");
  console.log("created wrangler.jsonc from template");
}
if (!existsSync(".dev.vars")) {
  const vars = readFileSync(".dev.vars.example", "utf8").replace(
    "REPLACE_WITH_BASE64_32_BYTES",
    randomBytes(32).toString("base64"),
  );
  writeFileSync(".dev.vars", vars, { mode: 0o600 });
  console.log("created .dev.vars with a fresh APP_ENCRYPTION_KEY");
}
const run = (args) => execFileSync("pnpm", ["exec", "wrangler", ...args], { stdio: "inherit" });
run(["d1", "migrations", "apply", "DB", "--local"]);
run(["d1", "execute", "DB", "--local", "--file", "scripts/seed-local.sql"]);
console.log("\nLocal setup done. Run `pnpm dev`, then open http://localhost:8788/auth/dev-login");
