import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  url: string;
  token: string;
  workdir: string;
  warnings: string[];
}

const expand = (p: string) => (p === "~" || p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p));

/**
 * FILENEST_URL         https origin (http only for localhost)
 * FILENEST_TOKEN_FILE  file containing the token (preferred, chmod 600)
 * FILENEST_TOKEN       token directly (less safe: visible in client config)
 * FILENEST_WORKDIR     local working folder (default ~/FileNest-work)
 */
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const warnings: string[] = [];
  const raw = env.FILENEST_URL?.trim();
  if (!raw) throw new Error("FILENEST_URL is required (e.g. https://files.example.com)");
  const u = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("FILENEST_URL must use https (http is allowed only for localhost)");

  let token = env.FILENEST_TOKEN?.trim() ?? "";
  if (env.FILENEST_TOKEN_FILE) {
    const file = expand(env.FILENEST_TOKEN_FILE);
    token = (await readFile(file, "utf8")).trim();
    const mode = (await stat(file)).mode & 0o777;
    if (process.platform !== "win32" && mode & 0o077) warnings.push(`Token file ${file} is readable by other users; run: chmod 600 ${file}`);
  } else if (token) {
    warnings.push("Token passed via FILENEST_TOKEN; prefer FILENEST_TOKEN_FILE so it is not stored in the assistant's config.");
  }
  if (!/^fnpat_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("A valid FileNest token is required (FILENEST_TOKEN_FILE or FILENEST_TOKEN)");

  return { url: u.origin, token, workdir: expand(env.FILENEST_WORKDIR ?? "~/FileNest-work"), warnings };
}
