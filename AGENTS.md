# FileNest — agent guide
Self-hosted file manager: one repo, one Cloudflare Worker (Hono) serving the React UI, `/api`, `/auth` and `/s` share links. Code: `src/worker`, `src/web`, `src/shared`, `packages/mcp`, `migrations/`, `tests/{worker,web}`, `e2e/`.

## Workflow (mandatory, skill `plan-guard`)
1. **Analyze** read-only. 2. **Propose** (Thai if the owner writes Thai): problem, files, impact, test method; mark what needs real Cloudflare/Google/device. 3. **Wait** for `ทำเลย` / `confirm` / `go ahead`; questions ≠ approval. 4. **Implement** approved scope only; scope grows ⇒ re-propose.
Provisioning, deploys, remote migrations, real Cloudflare/Google config ⇒ explicit instruction for *that* action.

## Routine work
- `FileNest-Master-Prompt.md` (root, if present) is reference only: search headings, read just the relevant section. Absent ⇒ use this file + code.
- Main agent first. Subagents/skills only for a clear role; hand over only scope, paths, diff. Don't have several agents re-explore the same area.
- Reuse existing code; change only what the task needs; new abstraction only with a real reason. No new deps/plugins without a plan.
- Read only the code/log ranges you need, but keep diagnostic error detail.
- After changes run the relevant tests; before handoff `pnpm typecheck && pnpm test && pnpm build` (+ `pnpm e2e` if UI/PWA/share/upload changed).
- Touching auth, permissions, share revocation, upload/R2 finalize, preview or PWA cache ⇒ regression tests + skill `project-security-review` + agent `security-audit`; fix findings in scope and re-test.
- Reply briefly: what changed, what was tested, results, what still needs confirmation. Add detail only for risks/decisions.

## Commands
Setup `pnpm install && pnpm setup:local` · Dev `pnpm dev` (app :8788, fake R2 :9000, `/auth/dev-login`) · E2E `pnpm e2e` (:8789/:9001) · `pnpm db:migrate:local` · `pnpm scan:secrets` before publishing.

## Invariants — do not break
- Authz: every file/folder access via `src/worker/authz.ts` (`fileFor`/`folderFor`/`writableFolderId`); unauthorized ⇒ 404; admin role grants no file access.
- Storage: client never picks it; bucket/endpoint/keys from D1; endpoint only `https://<32-hex>.r2.cloudflarestorage.com/<bucket>`. Upload sessions pin `storage_id`/`staging_key`/`final_key`.
- Placement + quota/capacity only in `createUpload`'s single `WITH pick … INSERT … SELECT … RETURNING` (priority, accepting, last check ok, `capacity_bytes` NULL = unlimited, `quota_unlimited`; trash + in-flight count). Client checks are UX only.
- Finalize: lease-claim → HEAD staging → `CopyObject` + `x-amz-copy-source-if-match` → HEAD final → sniff → insert `ON CONFLICT(upload_session_id) DO NOTHING`; idempotent, recovers R2-ok/D1-failed.
- Content streamed by Worker (`services/content.ts`): no R2 redirect/presigned GET/forwarded R2 headers; HEAD + single Range 206/416, `nosniff`, `no-store`, sandbox CSP; HTML/SVG/unknown ⇒ octet-stream attachment.
- Share tokens 256-bit, SHA-256 (+AES-GCM copy), checked in D1 every request. Share passwords PBKDF2 100k; unlock cookie HMAC(link, password_version, expiry) `Path=/s/<token>` Strict 12 h, re-checked on every `/s/*`; lockout per (link, client) in `share_unlock_attempts`, reserved before PBKDF2; unlock form uses `Sec-Fetch-Site` (page sends `Origin: null`).
- Sessions: SHA-256 in D1, `HttpOnly; Secure; SameSite=Lax`, rotated on login; CSRF header + Origin on state changes. All sign-ins end in `finishLogin` (`routes/auth.ts`; MFA challenge `fn_mfa`, `needsMfaSetup`).
- `reserveAttempt` BEFORE verifying passwords/MFA/re-auth; unknown accounts run PBKDF2 (dummy hash); generic login errors.
- PAT `fnpat_`: SHA-256, shown once, expiring, revocable, rate-limited; Bearer only for `auth/middleware.ts#TOKEN_ROUTES` (read/list/download, create folder, upload) — never add share/delete/rename/move/admin/token routes without a plan; cookie + Bearer ⇒ 400.
- Admin (`routes/admin.ts`): session-only, sensitive actions `recent()` (10 min); never private file names/contents. Correlated subqueries use literal `"users"."id"` (Drizzle drops the table prefix).
- D1: parameterized only, ≤100 params/statement (subqueries over big `IN`), `atomicBatch` for atomic multi-statement raw SQL. Migrations append-only; keep `db/schema.ts` in sync (`tests/worker/schema.test.ts`).
- Logs via `lib/log.ts`; never log tokens, cookies, presigned URLs, secrets.
- PWA caches app shell only; `/api`, `/auth`, `/s` network-only; no user data in Cache Storage/IndexedDB/Web Storage. Only Web Storage key: `filenest-theme` (`tests/web/storage-hygiene.test.ts`); `fn_theme` / `fn_lang` cookies ⇒ only `light`/`dark` / `en`/`th` on the share page; `public/theme-init.js` (no inline script).
- UI: shadcn/ui (`npx shadcn@latest add`, rewrite `cn` import to `@/lib/utils`) + theme tokens from `src/web/index.css`, no hard-coded colors, WCAG AA both themes.
- MCP (`packages/mcp`): local fs only through `Workdir` (no `..`, symlink escape, silent overwrite).

## Style
TS strict, ESM, 2 spaces, double quotes, comments explain *why*. UI text: English source string in `t("…")` (`src/web/i18n`) + Thai in `i18n/th.ts` (typecheck enforces); call `useLocale()` where text must re-render.
