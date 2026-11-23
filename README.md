# FileNest

Self-hosted file manager for you and your team, running entirely on **your own Cloudflare account** (Workers, D1, R2) with **your own Google OAuth** client.

> **Status: in development (v0.1.0-dev).** All features below are implemented and covered by local tests (Worker in workerd, local D1, fake R2, Playwright).
> They have **not yet been verified against real Cloudflare R2, real Google sign-in, or real iOS devices.** See [Acceptance status](#acceptance-status).

## Features

- Sign in with Google (OpenID Connect + PKCE) or email and password, with optional or enforced two-factor authentication (authenticator app + recovery codes)
- Invitation links, Admin and Member roles, and an Admin Console for members, bans, invitations, public links, settings, storage and audit
- Drive: folders, breadcrumb, name search, drag-and-drop upload with per-file progress and retry, rename, move, trash, restore
- Preview images, video, audio, PDF and text **streamed through the Worker** (Range/seek supported). R2 is never exposed to browsers for reads.
- Private by default. Share a file with specific members (view and download), or create a revocable public link (`/s/<token>`), optionally protected by a password.
- **AI assistants via MCP**: a local MCP server lets Claude Code, Claude Desktop and other MCP clients download files into a working folder, process them with local tools (e.g. ffmpeg), and upload results back.
- Several R2 buckets, even in **different Cloudflare accounts**. The Admin chooses which one receives new uploads, without redeploying.
- Installable PWA. Only the app shell is cached; files and data are never stored offline.
- Light, Dark or System theme; shadcn/ui interface with a collapsible sidebar, ⌘K search, list/grid views, sorting and multi-select.

## Architecture

```
Browser ── same origin ──► Cloudflare Worker (Hono)
   React SPA (static assets)      /auth/*  Google OIDC, sessions in D1
                                  /api/*   Drive, uploads, sharing, admin
                                  /s/*     public share links
Worker ── S3 API ──► R2 bucket(s)          D1: users, sessions, folders, files,
Browser ── presigned PUT (staging key only) ─► R2     shares, upload sessions, storage targets, audit
```

Upload flow: the Worker creates an upload session and pins its bucket and keys. The browser PUTs the file to a short-lived presigned URL for a random *staging* key. On finalize, the Worker checks the size, copies staging to a *final* key guarded by the source ETag (`x-amz-copy-source-if-match`), sniffs the content, and only then shows the file in the Drive. Finalize is idempotent and safe to retry.

## Requirements

- Node.js ≥ 22 (24 recommended), pnpm ≥ 10
- A Cloudflare account (Workers, D1, R2)
- A Google Cloud project for OAuth

## Local development

```bash
pnpm install
```

```bash
pnpm setup:local
```

```bash
pnpm dev
```

- `setup:local` creates `wrangler.jsonc` and `.dev.vars` (both git-ignored; a fresh `APP_ENCRYPTION_KEY` is generated), applies D1 migrations locally, and adds a local storage target.
- `pnpm dev` starts a **fake R2** on `http://localhost:9000` (files in `.dev-data/`) and the app on `http://localhost:8788`.
- Open `http://localhost:8788/auth/dev-login` to sign in as `BOOTSTRAP_ADMIN_EMAIL` without Google. Dev login only works when `ENVIRONMENT=development`, `DEV_AUTH=1` **and** the host is localhost.
- To use real Google locally, put your client ID/secret in `.dev.vars` and add `http://localhost:8788/auth/callback` as an authorized redirect URI.

## Deploy to Cloudflare (first R2 account)

All commands run from the repo. Replace placeholders. Nothing here runs automatically.

### 1. Worker config

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc`:
- `vars.APP_ORIGIN`: your public origin, e.g. `https://files.example.com` (no trailing slash)
- `vars.GOOGLE_CLIENT_ID`: from step 3
- `vars.BOOTSTRAP_ADMIN_EMAIL`: the Google email of the first Admin
- Optional: `MAX_UPLOAD_BYTES` (default 512 MiB; max ≈ 5 GiB), `DEFAULT_QUOTA_BYTES` (10 GiB), `UPLOAD_RATE_PER_HOUR` (100), `TRASH_RETENTION_DAYS` (30)
- Custom domain (recommended): add `"routes": [{ "pattern": "files.example.com", "custom_domain": true }]`

### 2. D1

```bash
pnpm exec wrangler d1 create filenest
```

Put the returned `database_id` into `wrangler.jsonc`, then:

```bash
pnpm db:migrate:remote
```

### 3. Google OAuth

1. Google Cloud Console → APIs & Services → OAuth consent screen: configure (External or Internal), scopes `openid`, `email`, `profile`.
2. Credentials → Create OAuth client ID → **Web application**.
3. Authorized redirect URI: `https://files.example.com/auth/callback` (exactly `APP_ORIGIN + /auth/callback`).
4. Copy the client ID into `wrangler.jsonc`, and store the secret:

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
```

### 4. Encryption key (for re-copyable share links)

```bash
openssl rand -base64 32 | pnpm exec wrangler secret put APP_ENCRYPTION_KEY
```

### 5. R2 bucket, token and CORS

```bash
pnpm exec wrangler r2 bucket create filenest-files
```

- Dashboard → R2 → *Manage API tokens* → create a token with **Object Read & Write** limited to **this bucket only**. Note the Access Key ID and Secret Access Key.
- Pick a short credential ref, e.g. `MAIN`, and store the keys as Worker Secrets:

```bash
pnpm exec wrangler secret put R2_MAIN_ACCESS_KEY_ID
```

```bash
pnpm exec wrangler secret put R2_MAIN_SECRET_ACCESS_KEY
```

- CORS (browsers upload directly to R2): edit `docs/r2-cors.json` so `origins` is your `APP_ORIGIN`, then:

```bash
pnpm exec wrangler r2 bucket cors set filenest-files --file docs/r2-cors.json
```

  Only `PUT` with header `content-type` is needed, and `ETag` must be exposed. Reads never go to R2 from the browser.

### 6. Build and deploy

```bash
pnpm build
```

```bash
pnpm exec wrangler deploy
```

### 7. First sign-in

Open `APP_ORIGIN`, sign in with `BOOTSTRAP_ADMIN_EMAIL`. That account becomes Admin **only if no Admin exists yet**. Then:
- **Admin → Storage → Add R2 storage target**: name, Cloudflare **account ID** (32 hex), bucket, credential ref (`MAIN`). The first target becomes the default.
- Click **Check**. It writes, reads and deletes a probe object, then runs a CORS preflight. Fix anything it reports.
- **Admin → Members → Invite** teammates by their Google email.

## Adding a second R2 account

1. In the **other** Cloudflare account, create a bucket, a bucket-scoped Object Read & Write token, and the same CORS rule.
2. In the FileNest Worker, add secrets with a new ref, e.g. `B`: `R2_B_ACCESS_KEY_ID`, `R2_B_SECRET_ACCESS_KEY`.
3. Admin → Storage → Add target with the **other** account ID, the bucket and ref `B` → **Check**.
4. Click **Make default**. New uploads go to B. Existing files keep reading from A, and uploads that already started keep their original bucket.
5. To stop new files going to A, turn off **Accept** on A. Its files stay readable. A target that still has files or upload sessions cannot be deleted, and its bucket/account cannot be edited. Add a new target instead.

## Accounts, 2FA and the Admin Console

- **Bootstrap:** the first person to sign in with Google as `BOOTSTRAP_ADMIN_EMAIL` becomes Admin.
- **Invite people:** Admin Console → Invitations → *Create link*. Set role, number of uses and expiry, and optionally one email address. **Email-bound** links can be used with Google or with a password for that address. **Open** links (no email) accept Google sign-in only, so nobody can claim someone else's address with a password. Links are shown only after the Admin confirms it's them.
- **Passwords:** 10–128 characters, PBKDF2-SHA256 with 100,000 rounds (`PASSWORD_PBKDF2_ITERATIONS`, 10,000–100,000; Workers' WebCrypto is reported to reject more in production). Expect ~30–60 ms CPU per sign-in: use the Workers **Paid** plan. Guessing is limited per account+client (5), per account (30) and per client (30); a stranger cannot lock out the real user, and the same error is returned for unknown, wrong or disabled accounts.
- **Forgot password:** FileNest does not send email. An Admin opens the member and clicks *Password reset link* (single use, 30 minutes), then sends it through a trusted channel. Resetting signs the member out everywhere and revokes their API tokens. Reset links are refused for Google-only members and for members with 2FA (they can still sign in with their authenticator).
- **Two-factor authentication:** Settings → Security → *Set up authenticator app*. Ten one-time recovery codes are shown once. The Admin Console can require 2FA for Admins (default) or everyone; affected members must enroll at their next sign-in. An Admin can reset a member's 2FA after verifying who they are.
- **Admin Console** (`/admin`): Overview, Members (search, role, quota, ban with reason and duration, sign out everywhere, revoke API tokens, reset 2FA, reset link), Invitations, Public links (review and revoke), Settings (registration, sign-in methods, 2FA policy, default quota, max file size, session length, trash retention, public link policy), Storage and Audit log (filter, CSV export).
- Sensitive actions (ban, role changes, 2FA reset, reset links, settings, storage) ask the Admin to confirm with their authenticator code or password if they signed in more than 10 minutes ago.
- Admins see usage totals and member metadata, and the names of files that already have **public** links. They never see the names or contents of other members' private files.
- **Trust note:** because FileNest sends no email, an Admin who resets a member's 2FA *and then* issues a reset link could set that member's password. Both steps need re-authentication, are recorded in the audit log and the member's activity, and sign the member out (so they notice). Only give the Admin role to people you trust with that.
- Turning on the 2FA requirement applies immediately: members who must use 2FA but haven't set it up can only reach the enrollment screen, and their API tokens stop working until they enroll.

## AI assistants (MCP)

`packages/mcp` is a **local** MCP server (stdio). It runs on your computer, talks to FileNest with a personal access token, and reads/writes only inside one working folder.

1. In FileNest: account menu → **API tokens** → create a token (choose whether it may upload). Copy it once.
2. Store it so only you can read it:

```bash
mkdir -p ~/.config/filenest && pbpaste > ~/.config/filenest/token && chmod 600 ~/.config/filenest/token
```

3. Build the server:

```bash
pnpm mcp:build
```

4. Add it to your MCP client (Claude Desktop `claude_desktop_config.json`, or `.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "filenest": {
      "command": "node",
      "args": ["/absolute/path/to/file-nest/packages/mcp/dist/index.js"],
      "env": {
        "FILENEST_URL": "https://files.example.com",
        "FILENEST_TOKEN_FILE": "~/.config/filenest/token",
        "FILENEST_WORKDIR": "~/FileNest-work"
      }
    }
  }
}
```

Tools: `list_folder`, `search_files`, `list_shared`, `get_file_info`, `read_file_content` (small text/images inline), `download_file` (resumable, into the working folder), `upload_file` (from the working folder), `create_folder`.
Example prompt: *“Find interview.mp4 in FileNest, cut 0:10–0:30 with ffmpeg, and upload it as interview-clip.mp4.”*

Safety:
- Tokens act as you but **cannot** share, delete, trash, rename/move, use admin features or create other tokens. They expire (default 90 days), can be revoked any time, and are rate-limited (600 requests/min).
- The MCP server refuses paths outside `FILENEST_WORKDIR` (including `..` and symlinks) and never overwrites a local file unless asked. This limits what a prompt-injected instruction can touch on your machine.
- `FILENEST_URL` must be https (http only for localhost).

## Password-protected links

In the Share dialog, after creating a public link, choose **Add password** (8–128 characters). Viewers then see a password form; the file name, preview and download stay locked until the password is entered. Unlocking lasts 12 hours in that browser. Changing or removing the password, or revoking the link, invalidates earlier unlocks immediately. After 5 wrong attempts from the same client (IP), that client is locked out for 1 minute, doubling up to 15 minutes; other viewers are not affected, and counters reset after a quiet day. Attempts are counted before the password is checked, so parallel requests cannot exceed the limit. Raw IPs are not stored. For public deployments, also add a Cloudflare rate limiting rule for `POST /s/*/unlock`. Send the password through a different channel than the link.

## PWA

- Served from the app origin (`/manifest.webmanifest`, `/sw.js`). HTTPS is required in production.
- An **Install app** button appears when the browser offers an install prompt. On iOS Safari it shows *Share → Add to Home Screen* instructions. It is hidden when FileNest is already running standalone.
- Only the app shell (JS/CSS/HTML/icons) is cached. `/api`, `/auth`, `/s`, previews and downloads are always network-only.
- Offline: the app shows that an internet connection is needed. A failed upload shows **Retry**.
- When an update is available, an **Update** banner appears. If uploads are running, the reload waits until they finish.
- Replace the placeholder logo: overwrite `public/icons/favicon.svg` and `public/icons/maskable.svg`, then run `pnpm icons`.

## Tests

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm build
```

```bash
pnpm e2e
```

- `pnpm test` runs Worker integration tests inside workerd with a real local D1 and an in-memory fake R2 (S3 API), plus web unit tests.
- `pnpm e2e` runs Playwright against an **isolated local stack**: built bundle and service worker, fresh local D1, fake R2 on `:9001`, app on `:8789`, dev login. It does not use Google or Cloudflare.

## Limits and known constraints (v0.1)

- **Single-part uploads**: one presigned PUT per file. Default max is 512 MiB (configurable, ≈5 GiB hard limit). No resume; a failed upload restarts that file.
- The presigned PUT signs `Content-Type` and `Content-Length`, so R2 should reject a body that differs from the declared size (to be confirmed against real R2).
- What is checked **before** the upload URL is issued: sign-in, folder ownership, declared size ≤ max, quota (including in-flight uploads), hourly rate limit, name. What is checked **after** upload, at finalize: actual size, content type by magic bytes, and an ETag-guarded copy. A presigned PUT cannot enforce size in advance, so oversized or short uploads are rejected at finalize and cleaned up.
- Sharing is per **file** (folders cannot be shared yet).
- Inline preview allowlist: PNG, JPEG, GIF, WebP, AVIF, MP4/MOV, WebM, Ogg, MP3, WAV, M4A, PDF, plain text. Everything else, including HTML and SVG, downloads as an attachment.
- Search is a case-insensitive name match (no full-text search).
- Folder listings show up to 2,000 items.
- R2 jurisdictions (EU/FedRAMP endpoints) are not supported yet.
- The UI is English-only.

## Security notes

- Sessions: a random 256-bit token in an `HttpOnly; Secure; SameSite=Lax` cookie. Only its SHA-256 is stored. Sessions rotate on login and are revoked on logout or when a member is disabled.
- All state-changing API calls require a per-session CSRF header and a same-origin `Origin`.
- Authorization is checked in the Worker on every request. Files you cannot access return 404. The Admin role does **not** grant access to other people's private files.
- Public link tokens are 256-bit, stored as a hash (plus an AES-GCM copy so the owner can copy the link again), and checked on every request. Revoking takes effect immediately.
- Content responses use `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and a sandboxing CSP. Share routes add `Referrer-Policy: no-referrer`.
- Workers **invocation logs are off** in `wrangler.example.jsonc` (`observability.logs.invocation_logs: false`, `redact_query_string: true`), because request URLs contain share tokens (`/s/<token>`) and OAuth `code`/`state`. If you turn them on, anyone who can read Workers Logs in your account can collect live share links.
- Share passwords are hashed with PBKDF2-SHA256 (100,000 iterations). On the Workers **Free** plan (10 ms CPU per request) unlock attempts may exceed the CPU limit; measure on your plan before relying on it.
- API tokens (`fnpat_…`) are stored as SHA-256 only; `pnpm scan:secrets` flags any token committed by mistake.
- `GET /auth/login` writes a short-lived row per request (cleaned every 15 min). On a public deployment, add a Cloudflare **rate limiting rule** for `/auth/login` (e.g. 20 requests/min per IP).
- The app CSP allows `connect-src https://*.r2.cloudflarestorage.com` so the Admin can add R2 targets in other accounts **without redeploying**. If you use fixed accounts, tighten it in `public/_headers` to `https://<account-id>.r2.cloudflarestorage.com`.
- **Before publishing your fork**, run `pnpm scan:secrets`. It scans tracked files and the full git history. Keep `.dev.vars`, `.env*`, `wrangler.jsonc` and D1 exports out of the repo (they are git-ignored). If a secret was ever committed, **revoke/rotate it first**, then rewrite history.

## Acceptance status

| Criterion | Status |
|---|---|
| Allowlisted member signs in; others cannot reach Drive; members cannot switch R2 | ✅ local (mocked Google ID tokens) · 🟡 real Google |
| Member A cannot read/modify B's private file by ID (incl. HEAD, Range, search, mutations); non-owner cannot finalize | ✅ local |
| Upload on A → switch to B → upload; both in one Drive, served from the right bucket; mid-session switch keeps the original bucket | ✅ local (fake R2, per-host/credential assertions) · 🟡 real R2 |
| Incomplete upload cannot finalize; concurrent/repeat finalize creates one file; re-writing staging after finalize does not change the published file | ✅ local |
| Public share works signed-out; every new request (incl. Range/download) fails after revoke | ✅ local + E2E |
| Preview contacts only the app origin; Range/206/416; uploaded HTML/SVG not executed on the app origin | ✅ local + E2E · 🟡 video seek / PDF viewer in real browsers on production |
| Rename/move keeps the original object key | ✅ local |
| PWA install and standalone on Chromium; iOS Safari steps; Google Sign-In on devices | 🟡 manifest/SW verified locally; install and devices not yet tested |
| Offline shows status, no cached file list; no file reads via cache after logout; PWA update waits for uploads | ✅ E2E (offline, cache contents) · update deferral implemented, not E2E-tested |
| API tokens + MCP: list, inline image, download, path-escape refusal, upload | ✅ local (stdio MCP → Worker → local D1 → fake R2) · 🟡 real Claude Desktop/Code client |
| Password links: locked page, unlock in a real browser, cookie invalidation, lockout | ✅ local + E2E · 🟡 PBKDF2 CPU time on real Workers |
| Password sign-up via invitation, TOTP 2FA (enroll, sign in, recovery codes, replay protection), admin ban/reset/settings | ✅ local + E2E · 🟡 real authenticator apps on phones, PBKDF2 limits/CPU on deployed Workers |
| Fresh install from this README with one R2 account | 🟡 not yet run against real Cloudflare |

## License

MIT. See [LICENSE](LICENSE).
