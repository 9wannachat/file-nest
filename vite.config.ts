import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { wranglerConfigPath } from "./config.ts";

/**
 * Local/E2E only: allow presigned uploads to a fake R2 on localhost by
 * appending FILENEST_CSP_CONNECT_EXTRA to connect-src in the built _headers.
 * Production builds leave the CSP untouched.
 */
function cspConnectExtra(): Plugin {
  return {
    name: "filenest-csp-connect-extra",
    apply: "build",
    closeBundle() {
      const extra = process.env.FILENEST_CSP_CONNECT_EXTRA;
      const file = "dist/client/_headers";
      if (!extra || !/^[a-z0-9:/. -]+$/i.test(extra) || !existsSync(file)) return;
      writeFileSync(file, readFileSync(file, "utf8").replace("connect-src 'self'", `connect-src 'self' ${extra}`));
    },
  };
}

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: { port: 8788, strictPort: true },
  plugins: [
    cspConnectExtra(),
    react(),
    tailwindcss(),
    cloudflare({
      configPath: wranglerConfigPath,
      // E2E runs use an isolated local D1/state directory.
      persistState: process.env.FILENEST_STATE_DIR ? { path: process.env.FILENEST_STATE_DIR } : true,
    }),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/apple-touch-icon.png", "icons/favicon.svg"],
      manifest: {
        id: "/",
        name: "FileNest",
        short_name: "FileNest",
        description: "Self-hosted file manager",
        start_url: "/",
        scope: "/",
        display: "standalone",
        theme_color: "#0f766e",
        background_color: "#f8fafc",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell + shared static assets only. Everything dynamic is network-only
        // because no runtimeCaching rule exists for it.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest,woff2}"],
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/auth\//, /^\/s\//, /^\/__dev\//],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
        clientsClaim: false,
        skipWaiting: false,
      },
      devOptions: { enabled: false },
    }),
  ],
});
