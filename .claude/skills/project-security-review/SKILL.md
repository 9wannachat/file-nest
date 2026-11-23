---
name: project-security-review
description: FileNest-specific security review checklist: auth, file access, staged upload, preview, PWA, public repo. Use for any change touching auth, share, upload, preview or before publishing the repo.
---

# project-security-review

## When to use
Changes in `auth/`, `authz.ts`, `routes/share.ts`, `services/{uploads,content,shares,storage}.ts`, `vite.config.ts` (PWA), `public/_headers`; and before making the repository public.

## Checklist
- [ ] OIDC: PKCE S256, state cookie + single-use DB row, nonce, iss/aud/exp/RS256, `email_verified`.
- [ ] Bootstrap admin only when no admin exists (conditional insert).
- [ ] Session token hashed, rotated on login, revoked on logout/disable; cookie flags.
- [ ] CSRF token + Origin/Sec-Fetch-Site on all unsafe methods (`/api/*`, `/auth/logout`).
- [ ] Every file/folder route uses authz accessors; unauthorized ⇒ 404; admin ≠ file access.
- [ ] Upload: size/quota/rate before presign; presign staging only, ≤15 min, signed Content-Type; finalize owner-only, ETag-guarded copy, sniff final; idempotent.
- [ ] Content: Worker-streamed, our headers only, nosniff, no-store, sandbox CSP, allowlisted inline, safe Content-Disposition, no R2 host anywhere.
- [ ] Share: 256-bit token, hash lookup per request, revoke immediate, no-referrer, noindex.
- [ ] PWA: app shell only; `/api|/auth|/s` denylisted; no data in Web Storage/IndexedDB/Cache Storage.
- [ ] Logs/errors redacted; no stack traces to clients.
- [ ] Public repo: `pnpm scan:secrets`, `git log -p` scan for keys, `.gitignore` covers `.dev.vars`, `.env*`, `wrangler.jsonc`, dumps. If a secret was ever committed: **revoke/rotate first**, then rewrite history.

## Deliverable
Checklist with evidence per item and regression tests for any fix.
