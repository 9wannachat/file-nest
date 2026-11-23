import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E against an isolated LOCAL stack (see scripts/e2e-server.mjs):
 * built bundle + service worker served by Vite preview/workerd, local D1,
 * fake R2 (S3 API) on :9001, DEV_AUTH login. No Google or Cloudflare services.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8789",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] }, grepInvert: /@mobile/ },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs preview",
    url: "http://localhost:8789/api/health",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
