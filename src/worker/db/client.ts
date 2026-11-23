import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";
import type { Db } from "../env.ts";

export function getDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import type { SQL } from "drizzle-orm";

const dialect = new SQLiteSyncDialect();
type Compilable = SQL | { toSQL(): { sql: string; params: unknown[] } };

/**
 * Atomic D1 batch that accepts raw `sql` fragments and query builders alike.
 * (Drizzle's db.batch() does not accept db.run(sql`...`) items on D1.)
 */
export async function atomicBatch(d1: D1Database, items: Compilable[]) {
  const stmts = items.map((it) => {
    const q = "toSQL" in it ? it.toSQL() : dialect.sqlToQuery(it);
    return d1.prepare(q.sql).bind(...q.params);
  });
  return d1.batch(stmts);
}
