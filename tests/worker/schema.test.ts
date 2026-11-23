import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/worker/db/schema.ts";
import { testEnv } from "./helpers.ts";

const tables = Object.values(schema).filter(
  (v): v is typeof schema.users => typeof v === "object" && v !== null && Symbol.for("drizzle:IsDrizzleTable") in v,
);

describe("schema.ts mirrors migrations", () => {
  it("covers every table", async () => {
    const { results } = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
    ).all<{ name: string }>();
    expect(tables.map((t) => getTableName(t)).sort()).toEqual(results.map((r) => r.name).sort());
  });

  for (const table of tables) {
    it(`columns of ${getTableName(table)}`, async () => {
      const { results } = await testEnv.DB.prepare(`PRAGMA table_info(${getTableName(table)})`).all<{ name: string }>();
      const cols = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(cols.sort()).toEqual(results.map((r) => r.name).sort());
    });
  }
});
