---
name: delivery-check
description: Release gate for FileNest: acceptance criteria, tests, build, config, README install path. Use before saying work is done or tagging a version.
---

# delivery-check

## When to use
End of every Phase 3 task and before any release tag.

## Steps
1. `pnpm typecheck && pnpm test && pnpm build` — paste the summary lines.
2. `pnpm e2e` if UI, PWA, upload, share or preview changed.
3. `pnpm scan:secrets` and `git status` (no `.dev.vars`, `wrangler.jsonc`, dumps staged).
4. Walk the acceptance criteria (README “Acceptance status”) and mark each: ✅ local-verified · 🟡 needs real Cloudflare/Google/device · ❌ failing.
5. README: setup steps still match scripts/config names; env var table matches `wrangler.example.jsonc` and `.dev.vars.example`.
6. Migrations: new files listed; remote migration not run unless instructed.

## Deliverable
Report: files changed, decisions beyond spec, command results (actual output), acceptance table, open items. Separate local/mock results from real integration.
