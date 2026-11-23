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
    // Only exception: the theme preference (src/web/theme.tsx + public/theme-init.js), one fixed key.
    const offenders = walk("src/web")
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith("src/web/theme.tsx"))
      .filter((f) => /\b(localStorage|sessionStorage|indexedDB|caches\.open)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the theme exception stores only the theme key", () => {
    for (const f of ["src/web/theme.tsx", "public/theme-init.js"]) {
      const src = readFileSync(f, "utf8");
      const keys = [...src.matchAll(/localStorage\.(?:get|set)Item\(([^,)]+)/g)].map((m) => m[1]!.trim());
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(["THEME_STORAGE_KEY", '"filenest-theme"']).toContain(k);
      expect(src).not.toMatch(/sessionStorage|indexedDB|caches\.open/);
    }
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
