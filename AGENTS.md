# FileNest — agent guide

Self-hosted file manager. **One repo, one Cloudflare Worker**, serving the React UI, the API and public share links on one origin.
This file is the shared source of conventions for every coding agent (Claude Code reads it via `CLAUDE.md`).

## Workflow (mandatory) — see `.claude/skills/plan-guard`
1. **Analyze** (read-only): no edits, installs, or Cloudflare/Google changes.
2. **Propose** (Thai if the owner writes Thai): architecture, D1 schema, API contracts, files, risks, tests; separate *local-verifiable* from *needs real Cloudflare/Google/device*.
3. **Wait** for an explicit go (`ทำเลย`, `confirm`, `go ahead`). Questions/discussion are not approval.
4. **Implement** only the approved scope. Run checks after each change; before handing off run `pnpm typecheck && pnpm test && pnpm build` (and `pnpm e2e` when UI/PWA/share/upload changed).
5. Provisioning, deploys, remote migrations, or changing real Cloudflare/Google config need an explicit instruction **for that action**.

## Layout
```
src/worker/         Hono Worker: routes/, services/, auth/, authz.ts, storage/s3.ts, lib/, db/
src/web/            React SPA (Vite, Tailwind v4, shadcn/ui in components/ui via components.json), theme.tsx, pwa/, upload/
src/shared/         API payload types
src/dev/fake-s3.ts  In-process fake R2 S3 API (tests + local dev only)
packages/mcp/       Local MCP server (stdio) for AI assistants, uses a personal access token
migrations/         Hand-written D1 SQL (source of truth); src/worker/db/schema.ts mirrors it
tests/worker        Vitest in workerd (@cloudflare/vitest-plugin) with real local D1 + fake S3
tests/web           Vitest + jsdom
e2e/                Playwright against an isolated local stack (scripts/e2e-server.mjs)
```

## Commands
| Task | Command |
|---|---|
| First local setup | `pnpm install && pnpm setup:local` |
| Dev (app :8788 + fake R2 :9000) | `pnpm dev` → open `http://localhost:8788/auth/dev-login` |
| Typecheck / unit+integration / build | `pnpm typecheck` · `pnpm test` · `pnpm build` |
| Browser E2E (isolated :8789/:9001) | `pnpm e2e` |
| Local D1 migration | `pnpm db:migrate:local` |
| Secret scan before publishing | `pnpm scan:secrets` |

## Invariants — do not break
- **Deny by default.** Every file/folder access goes through `src/worker/authz.ts` (`fileFor`, `folderFor`, `writableFolderId`). Unauthorized ⇒ **404**. Admin role grants **no** file access.
- **Client never picks storage.** Bucket, endpoint and object keys come from D1 (`storage_targets`, `upload_sessions`). Endpoint = `https://<32-hex account>.r2.cloudflarestorage.com/<bucket>` only.
- **Upload sessions pin** `storage_id`, `staging_key`, `final_key` at creation. Switching the default affects only new sessions.
- **Finalize**: lease-claim → HEAD staging (size) → `CopyObject` with `x-amz-copy-source-if-match` → HEAD final → sniff final → insert row with `ON CONFLICT(upload_session_id) DO NOTHING`. Must stay idempotent and recover when R2 succeeded but D1 didn't.
- **Content is streamed by the Worker** (`services/content.ts`): never redirect to R2, never return presigned GETs, never forward R2 headers. HEAD + single byte range, 206/416, `nosniff`, `no-store`, sandbox CSP; HTML/SVG/unknown ⇒ `application/octet-stream` attachment.
- **Share tokens**: 256-bit random, stored as SHA-256 (+ AES-GCM copy for re-copying the link). Checked against D1 on **every** request.
- **Sessions**: random token, SHA-256 in D1, `HttpOnly; Secure; SameSite=Lax`, rotated on login; CSRF header + Origin check on every state-changing request.
- **API tokens (PAT)** `fnpat_…`: SHA-256 in D1, shown once, expiring, revocable, rate-limited. Bearer requests are matched against the allowlist in `auth/middleware.ts#TOKEN_ROUTES` (read/list/download, create folder, upload). Never add sharing, trash/delete, rename/move, admin or token management to it without a plan. Cookie + Bearer together ⇒ 400.
- **Share passwords**: PBKDF2-SHA256 (100k) + salt; unlock cookie is HMAC(link id, password_version, expiry), `Path=/s/<token>`, `SameSite=Strict`, 12 h; every `/s/*` request re-checks it. Lockout is per (link, client) in `share_unlock_attempts`, reserved atomically before PBKDF2. The unlock form relies on `Sec-Fetch-Site` because the page's `no-referrer` makes browsers send `Origin: null`.
- **Sign-in paths all end in `finishLogin`** (`routes/auth.ts`): 2FA members get an MFA challenge (cookie `fn_mfa`, 5 min) instead of a session; policy-required members without 2FA get a session limited to enrollment (`needsMfaSetup`). Never create a session directly elsewhere.
- **Brute-force budgets** use `reserveAttempt` BEFORE verifying (passwords, MFA codes, re-auth). Unknown accounts still run PBKDF2 (dummy hash). Login errors stay generic.
- **Storage limits**: enforced only in `createUpload`'s single INSERT…SELECT (member quota or `quota_unlimited`, plus `storageCapBytes`; trash and unexpired in-flight sessions count). Keep any new upload path going through it. Client pre-checks are UX only.
- **Admin Console**: `routes/admin.ts`, session-only; sensitive actions call `recent()` (re-auth within 10 min). Admins never get private file names/contents — only aggregates, member metadata and public links. In correlated subqueries write table-qualified columns literally (`"users"."id"`); Drizzle renders `${table.col}` unqualified without joins.
- **MCP** (`packages/mcp`): local stdio server; all local reads/writes go through `Workdir` (no `..`, no symlink escape, no silent overwrite).
- **Logs** go through `lib/log.ts` (redaction). Never log tokens, cookies, presigned URLs or secrets.
- **UI**: use shadcn/ui components and theme tokens (`bg-background`, `text-muted-foreground`, `bg-primary`, …) from `src/web/index.css`; no hard-coded palette colors. Add components with `npx shadcn@latest add <name>` and rewrite `from "cn"` imports to `@/lib/utils`. Keep text pairs ≥ WCAG AA in both themes.
- **Theme**: Light/Dark/System via `.dark` on `<html>`; `public/theme-init.js` applies it before paint (CSP forbids inline script). The only Web Storage use allowed is the `filenest-theme` key (enforced by `tests/web/storage-hygiene.test.ts`); `fn_theme` cookie only ever maps to `light`/`dark` on the share page.
- **PWA** caches the app shell only; `/api`, `/auth`, `/s` are network-only. No user data in Cache Storage / IndexedDB / Web Storage.
- **D1**: parameterized queries only (Drizzle / `sql` template). ≤100 bound params per statement — prefer subqueries over large `IN (...)` lists. Use `atomicBatch` for multi-statement atomic writes mixing raw SQL.
- **Migrations** are append-only once released. Keep `schema.ts` in sync (`tests/worker/schema.test.ts`).

## Agents & skills
Project agents: `.claude/agents/*.md` (planner, doctor, db-migration, worker-service, web-app, test-writer, e2e-test, ux-verify, reviewer, security-audit).
Project skills: `.claude/skills/<name>/SKILL.md`.
Routing: R2 switching ⇒ `worker-service` + `testing` + `reviewer`. Anything touching auth, share, upload or preview ⇒ also `security-audit` + `project-security-review`. Findings must be fixed in scope and re-tested.

## Style
TypeScript strict, ESM, 2-space indent, double quotes. UI copy in English (i18n not yet in scope). Keep comments for *why*, not *what*.
