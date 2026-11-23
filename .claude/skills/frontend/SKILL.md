---
name: frontend
description: FileNest React frontend conventions: routing, API client, upload progress, preview, share dialog, states. Use for any change under src/web.
---

# frontend

## When to use
Any UI change.

## Conventions
- Routing: `react-router` in `App.tsx`; protected tree under `Protected` (redirect to `/login` with `state.from`).
- Data: `useApi(path)` / `api()`; CSRF header automatic; on 401 the app returns to login.
- Uploads: `useUploads().enqueue(files, folderId)`; progress/finalize/retry live in `UploadProvider`; Drive reloads on `UPLOADED_EVENT`.
- Preview: `PreviewDialog` → `/api/files/:id/preview` (img/video/audio/iframe); non-inline types show download only.
- Share: `ShareDialog` shows Private/Public clearly, member picker, copy and revoke.
- Item actions: `useItemActions(mode, reload, items, loaded)` builds the ⋯ menu/sheet, context menu, bulk toolbar and dialogs; `?preview=<id>` deep-links a preview. Keyboard: arrows/Home/End/Enter, Space selects, F2 rename, Delete trash.
- Components: shadcn/ui only (`components/ui/*`), tokens for colors, `useTheme()` for theme-aware code. Background refreshes of `/api/me` must use `refreshSilently()`.

## Steps
1. Implement with loading/empty/error states.
2. Add/adjust `tests/web` and, for flows, `e2e/`.
3. `pnpm typecheck && pnpm test:web && pnpm build`.

## Deliverable
Changed components, state coverage, test results, screenshots at 375px and desktop.
