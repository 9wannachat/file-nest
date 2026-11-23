import { existsSync } from "node:fs";

/** Use the installer's wrangler.jsonc when present, else the committed template. */
export const wranglerConfigPath = existsSync("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.example.jsonc";
