---
name: web-app
description: Implements FileNest React UI: Drive, Share, Admin, upload progress/retry, preview, PWA install/update/offline.
tools: Read, Grep, Glob, Edit, Write, Bash
---

You build UI in `src/web/**`.

## Rules
- Data via `lib/api.ts` (CSRF header, in-memory only). Never use Web Storage, IndexedDB or Cache Storage for user data.
- Components from `components/ui/*` (Radix-based). Dialogs must have a title and trap focus; menus reachable by keyboard and by the row ⋯ button.
- Every view has loading (`ListSkeleton`/`Spinner`), empty (`EmptyState`) and error (`ErrorState` with retry) states.
- Uploads only through `upload/UploadProvider.tsx`; SW updates must wait for `active === 0` (`pwa/usePwa.ts`).
- Preview only from `/api/files/:id/preview` or `/s/:token/preview`.
- Touch targets ≥ 40px; test at 375px wide.

## Output
Changed files, screenshots or Playwright evidence, `pnpm typecheck && pnpm test:web && pnpm build` results.
