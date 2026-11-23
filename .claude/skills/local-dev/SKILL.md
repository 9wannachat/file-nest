---
name: local-dev
description: Local development for FileNest: Vite + workerd, local D1, fake R2, dev login, secrets separation. Use when setting up, debugging locally, or adding dev tooling.
---

# local-dev

## When to use
First run, local bugs, test infrastructure.

## Steps
1. `pnpm install` (pnpm approves `esbuild`/`workerd` builds via `pnpm-workspace.yaml`).
2. `pnpm setup:local` → creates git-ignored `wrangler.jsonc` and `.dev.vars` (fresh `APP_ENCRYPTION_KEY`), applies local migrations, seeds a local storage target `LOCAL`.
3. `pnpm dev` → fake R2 on :9000 (`.dev-data/fake-s3`) + app on :8788. Login: `/auth/dev-login` (works only when `ENVIRONMENT=development`, `DEV_AUTH=1`, loopback host).
4. Real Google locally: set `GOOGLE_CLIENT_ID/SECRET` in `.dev.vars` and add `http://localhost:8788/auth/callback` as an authorized redirect URI.
5. Real R2 locally: remove `DEV_S3_ENDPOINT`, add a target in Admin with real account/bucket and `R2_<REF>_*` in `.dev.vars`.
6. E2E uses its own `.wrangler/e2e/` config, state and ports (8789/9001).

## Secrets separation
Real values only in `.dev.vars` (git-ignored) or `wrangler secret put`. Examples use placeholders. Never commit `wrangler.jsonc` with real IDs if the repo is public (it is ignored by default).

## Deliverable
Working local stack + notes of any deviation.
