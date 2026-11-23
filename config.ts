import { existsSync } from "node:fs";

/**
 * Wrangler config used by Vite/Vitest:
 *  - FILENEST_WRANGLER_CONFIG (E2E uses a generated config under .wrangler/e2e/)
 *  - else the installer's wrangler.jsonc, else the committed template.
 */
export const wranglerConfigPath =
  process.env.FILENEST_WRANGLER_CONFIG ?? (existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.example.jsonc");
