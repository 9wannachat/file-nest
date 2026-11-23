import { defineConfig } from "drizzle-kit";

// Migrations in ./migrations are hand-written SQL (partial/expression indexes,
// CHECK constraints). drizzle-kit is kept for `drizzle-kit check`/studio only;
// do not overwrite migrations with generated output without reviewing it.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/schema.ts",
  out: "./migrations",
});
