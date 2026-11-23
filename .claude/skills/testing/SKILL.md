---
name: testing
description: FileNest testing strategy: unit, Worker integration (workerd + D1 + fake S3), web unit, Playwright E2E, failure fixtures. Use when adding features or fixing bugs.
---

# testing

## When to use
Every change. Write the failing test first for bugs.

## Layers
| Layer | Tool | Location | Notes |
|---|---|---|---|
| Pure logic | Vitest | `tests/worker/lib.test.ts` | range, mime sniffing, headers, redaction |
| Worker integration | `@cloudflare/vitest-plugin` | `tests/worker/*.test.ts` | real local D1 (migrations applied in `setup.ts`), fake S3 with request log, injectable clock |
| Web unit | Vitest + jsdom + Testing Library | `tests/web/*` | components, upload provider, hygiene checks |
| E2E | Playwright | `e2e/*` | isolated local stack; SW in preview build |

## Failure fixtures to reuse
Short upload, missing staging, ETag change between check and copy, crash after copy (lease expiry), concurrent finalize, quota/rate exceed, missing credentials, storage 5xx/404 on read, revoked link, trashed parent, disabled member.

## Steps
1. Pick the lowest layer that can prove the behaviour.
2. Assert security-relevant headers and absence of R2 hosts.
3. Run `pnpm test` (and `pnpm e2e` for UI).

## Deliverable
Tests + results; note anything only verifiable with real services.
