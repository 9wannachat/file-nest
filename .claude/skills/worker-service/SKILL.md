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

## R2 capacity & placement checklist
1. Each target has `capacity_bytes` (NULL = unlimited) and `priority`; total capacity = sum of eligible targets.
2. `createUpload` picks the target AND reserves space in one `WITH pick … INSERT … SELECT … RETURNING storage_id` (first by `priority, created_at, id` that accepts uploads, has not failed its last check and has room). Never pick a target in a separate query.
3. `PUT /api/admin/storage-order` (and legacy `storage-default` = move to top) only reorders; existing sessions keep their pinned `storage_id`.
4. Tests: fill A, next file lands on B, a file larger than any single free space is 507, concurrent creates never overfill — assert fake-S3 host + access key per request.

## Deliverable
Code + tests + `pnpm typecheck && pnpm test:worker` output.
