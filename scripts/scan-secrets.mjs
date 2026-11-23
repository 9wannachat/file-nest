// Scan tracked files AND full git history for likely secrets before publishing.
//   pnpm scan:secrets
// Exit code 1 when something suspicious is found. Matches are redacted in output.
import { execFileSync } from "node:child_process";

const RULES = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["Google OAuth client secret", /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{35}/],
  ["AWS-style access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["Cloudflare API token (assignment)", /(?:CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[=:]\s*["']?[A-Za-z0-9_-]{40}/],
  ["R2 secret access key (64 hex)", /(?:SECRET_ACCESS_KEY|secret_access_key)\s*[=:]\s*["']?[0-9a-f]{64}\b/],
  ["encryption key assignment", /APP_ENCRYPTION_KEY\s*[=:]\s*["']?(?!REPLACE_WITH)[A-Za-z0-9+/]{43}=/],
  ["session cookie value", /__Host-fn_session=[A-Za-z0-9_-]{30,}/],
  ["share link token", /\/s\/[A-Za-z0-9_-]{43}\b/],
];
// Deterministic test-only key (bytes 0..31) used by tests and the isolated E2E stack.
const ALLOW = [/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=/];
const FORBIDDEN_FILES = [/^\.dev\.vars$/, /^\.env(\..*)?$/, /^wrangler\.jsonc$/, /\.sqlite3?$/, /(^|\/)dumps?\//];

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const findings = [];
const redact = (s) => s.slice(0, 6) + "…[redacted]";

function scan(text, where) {
  text.split("\n").forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const [name, re] of RULES) {
      const m = re.exec(line);
      if (m) findings.push(`${where}:${i + 1}  ${name}  ${redact(m[0])}`);
    }
  });
}

const tracked = git(["ls-files"]).split("\n").filter(Boolean);
for (const f of tracked) {
  if (FORBIDDEN_FILES.some((r) => r.test(f))) findings.push(`${f}  file must not be committed`);
  if (/\.(png|jpe?g|gif|webp|ico|zip|woff2?)$/.test(f) || f === "pnpm-lock.yaml") continue;
  try {
    scan(git(["show", `:${f}`]), f);
  } catch {
    /* deleted in index */
  }
}

// History: every added line in every commit.
const log = git(["log", "--all", "-p", "--no-color", "--format=commit %H"]);
let commit = "";
let file = "";
for (const line of log.split("\n")) {
  if (line.startsWith("commit ")) commit = line.slice(7, 15);
  else if (line.startsWith("+++ b/")) {
    file = line.slice(6);
    if (FORBIDDEN_FILES.some((r) => r.test(file))) findings.push(`history ${commit} ${file}  file was committed`);
  } else if (line.startsWith("+") && !line.startsWith("+++") && file !== "pnpm-lock.yaml") scan(line.slice(1), `history ${commit} ${file}`);
}

const unique = [...new Set(findings)];
if (unique.length) {
  console.error(`Possible secrets found (${unique.length}):\n` + unique.join("\n"));
  console.error("\nIf a real secret was ever committed: revoke/rotate it FIRST, then rewrite history before publishing.");
  process.exit(1);
}
console.log(`No secrets found in ${tracked.length} tracked files and git history.`);
