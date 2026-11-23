import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("PWA data hygiene", () => {
  it("web code never persists data in localStorage, sessionStorage, IndexedDB or Cache Storage", () => {
    const offenders = walk("src/web")
      .filter((f) => /\.(ts|tsx)$/.test(f))
      .filter((f) => /\b(localStorage|sessionStorage|indexedDB|caches\.open)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("service worker config has no runtime caching and denylists dynamic routes", () => {
    const cfg = readFileSync("vite.config.ts", "utf8");
    expect(cfg).toMatch(/runtimeCaching:\s*\[\]/);
    for (const p of ["api", "auth", "s"]) expect(cfg).toContain(`/^\\/${p}\\//`);
  });
});

describe("Worker config hygiene", () => {
  it("invocation logs (which contain share-token URLs) are off and query strings redacted", () => {
    const cfg = readFileSync("wrangler.example.jsonc", "utf8");
    expect(cfg).toMatch(/"invocation_logs":\s*false/);
    expect(cfg).toMatch(/"redact_query_string":\s*true/);
  });
});
