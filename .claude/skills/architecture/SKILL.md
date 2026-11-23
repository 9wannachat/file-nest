---
name: architecture
description: FileNest architecture and trust boundaries: React SPA, single Hono Worker, central D1, multiple R2 targets via S3 API. Use when designing features that cross UI/Worker/D1/R2 or when explaining how data flows.
---

# architecture

## When to use
New feature spanning layers, storage changes, or any question “where should this live?”.

## Model
```
Browser ──same origin──► Worker (Hono)
  SPA assets (Workers Static Assets, _headers CSP)
  /auth/*  Google OIDC → sessions (D1)
  /api/*   requireSameOrigin → requireUser(+CSRF) → services → authz.ts → D1
  /s/*     share token → D1 → stream
Worker ──S3 API (aws4fetch)──► R2 target N  (account/bucket from storage_targets, creds R2_<REF>_*)
Browser ──presigned PUT (staging only)──► R2 target pinned in upload_sessions
Cron ──► cleanup (expire sessions, deletion queue, trash purge)
```
## Trust boundaries
1. Browser → Worker: untrusted input; validate everything; cookie + CSRF + Origin.
2. Worker → D1: source of truth for identity, metadata, permissions, storage routing.
3. Worker → R2: credentials per target, endpoint from validated config only.
4. Browser → R2: only a short-lived presigned PUT on a random staging key; never final keys, never GET.
5. Public: `/s/:token` only; token hashed; no cookies needed.

## Steps
1. Place logic: UI state in `src/web`, rules in `src/worker/services`, access in `authz.ts`.
2. Check which invariants in `AGENTS.md` apply.
3. Decide D1 changes first, then API, then UI.

## Deliverable
A short design note: components touched, data flow, boundary crossings, invariants preserved, open risks.
