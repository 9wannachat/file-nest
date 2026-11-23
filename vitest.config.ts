import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import { wranglerConfigPath } from "./config.ts";

const alias = {
  "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
  "@": fileURLToPath(new URL("./src/web", import.meta.url)),
};

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => ({
            main: "./src/worker/index.ts",
            wrangler: { configPath: wranglerConfigPath },
            miniflare: {
              bindings: {
                ENVIRONMENT: "test",
                APP_ORIGIN: "https://filenest.test",
                GOOGLE_CLIENT_ID: "test-client-id",
                GOOGLE_CLIENT_SECRET: "test-client-secret",
                BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
                APP_ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
                MAX_UPLOAD_BYTES: "10485760",
                DEFAULT_QUOTA_BYTES: "52428800",
                UPLOAD_RATE_PER_HOUR: "50",
                TRASH_RETENTION_DAYS: "30",
                PASSWORD_PBKDF2_ITERATIONS: "20000",
                R2_A_ACCESS_KEY_ID: "test-a-key",
                R2_A_SECRET_ACCESS_KEY: "test-a-secret",
                R2_B_ACCESS_KEY_ID: "test-b-key",
                R2_B_SECRET_ACCESS_KEY: "test-b-secret",
                TEST_MIGRATIONS: await readD1Migrations("./migrations"),
              },
            },
          })),
        ],
        test: {
          name: "worker",
          include: ["tests/worker/**/*.test.ts"],
          setupFiles: ["./tests/worker/setup.ts"],
        },
      },
      {
        resolve: { alias },
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["tests/web/**/*.test.{ts,tsx}"],
          setupFiles: ["./tests/web/setup.ts"],
        },
      },
    ],
  },
});
