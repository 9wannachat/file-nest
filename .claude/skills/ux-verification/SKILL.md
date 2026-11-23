---
name: ux-verification
description: Verify FileNest UX behaviour: keyboard/focus, loading, empty, error, offline, upload/update interplay. Use after UI changes.
---

# ux-verification

## When to use
After any UI change and before release.

## Steps
1. Keyboard-only pass: skip link → nav → search → toolbar → list rows (↑/↓/Home/End, Enter opens, F2 rename, Delete trash, ⋯ menu) → dialogs (initial focus, trap, Esc, focus return).
2. States: first load skeleton; empty Drive/Shared/Trash/Search; force API 500 (stop dev server) to see `ErrorState` + retry.
3. Offline (DevTools or `context.setOffline`): banner text, no file list from cache, upload blocked with message; restore network → retry works.
4. Upload: progress per file, error message + Retry, cancel; while uploading, trigger SW update → banner says it will apply after uploads.
5. Screen reader spot check: rows announce “File <name>”/“Folder <name>”; progress bars have labels; toasts are announced.

## Deliverable
Findings with severity, steps to reproduce, and fixes/tests.
