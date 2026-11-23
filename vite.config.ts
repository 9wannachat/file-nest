import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { wranglerConfigPath } from "./config.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@": fileURLToPath(new URL("./src/web", import.meta.url)),
    },
  },
  server: { port: 5173, strictPort: true },
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({ configPath: wranglerConfigPath }),
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
