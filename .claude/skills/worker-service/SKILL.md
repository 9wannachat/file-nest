---
name: worker-service
description: FileNest Worker service patterns: Hono middleware, auth, D1 access, R2 routing, finalize, streaming. Use for any change under src/worker.
---

# worker-service

## When to use
Backend changes, R2 default switching, upload/finalize, content streaming.

## Patterns
- Middleware chain for `/api`: cache headers → `bodyLimit(64KB)` → `requireSameOrigin` → `requireUser` (session + CSRF) → optional `requireAdmin`.
- IDs: `idParam(c)` (UUID or 404). Bodies: `jsonBody(c)`.
- Access: `fileFor(db, userId, id, "read"|"manage")`, `folderFor`, `writableFolderId`.
- Storage: `bucketById(ctx, row.storageId)`; never the current default for existing objects.
- Atomic multi-write: `db.batch([...builders])` or ``atomicBatch(db.$client, [sql`...`, builder])``.
- Streaming: `serveFile(ctx, file, req, "preview"|"download", {share})`.

## R2 switching checklist
1. `PUT /api/admin/storage-default` only changes `app_settings.default_storage_id` (+audit).
2. New sessions read the default at creation; existing sessions keep their `storage_id`.
3. Tests: upload on A, switch, finish an A-pinned session, upload on B, read both — assert fake-S3 host + access key per request.

## Deliverable
Code + tests + `pnpm typecheck && pnpm test:worker` output.
