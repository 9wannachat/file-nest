---
name: db-migration
description: Plan and write D1 migrations for FileNest: constraints, indexes, Drizzle mirror, existing-data safety. Use whenever a table/column/index changes.
---

# db-migration

## When to use
Any change to `migrations/` or `src/worker/db/schema.ts`.

## Steps
1. New file `migrations/NNNN_<verb>_<thing>.sql`; never edit released migrations.
2. Prefer CHECK constraints for enums/format; partial unique indexes for “active” uniqueness (see `files_active_name_uq`).
3. FK actions: `NO ACTION` for self/hierarchy references that are deleted in one statement; `RESTRICT` for storage targets.
4. Add indexes for every new WHERE/JOIN path used by list/search/cleanup.
5. Backfill in SQL; avoid >100 bound parameters.
6. Update `schema.ts`; run `pnpm test:worker` (schema sync test) and `pnpm db:migrate:local` on a populated local DB.
7. Document remote rollout: `pnpm db:migrate:remote` — only on explicit instruction, after a D1 export backup kept **outside** the repo.

## Deliverable
Migration SQL, schema diff, index rationale, backfill/rollback notes, test output.
