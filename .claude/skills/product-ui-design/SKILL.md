---
name: product-ui-design
description: FileNest's own visual and interaction design: Drive, Share dialog, Storage Admin. Use when designing or restyling UI.
---

# product-ui-design

## When to use
New screens, layout changes, visual polish.

## Design language
- Name **FileNest**; logo `public/icons/favicon.svg` (replace with the owner's logo and run `pnpm icons`).
- Brand teal (`brand-700 #0f766e`) for primary actions and “receiving new files”; slate neutrals; amber for warnings/offline; red for destructive.
- Familiar file-manager patterns, original styling: left nav (My Drive / Shared with me / Trash / Admin), breadcrumb title, list with name/owner/modified/size, ⋯ row menu + right-click menu, drag-and-drop overlay, bottom-right upload panel.
- Share dialog: “General access” card that is visibly different for Private (lock, neutral) vs Public (globe, brand border), then members list.
- Storage Admin: status banner stating where new uploads go; per-target badges (Receiving new files / Accepting / Read-only / Healthy / Check failed / Secrets missing).
- Mobile: nav drawer, dialogs become bottom sheets, metadata collapses under the filename.

## Steps
1. Sketch states (loading/empty/error/offline) before visuals.
2. Reuse `components/ui/*`; extend variants instead of one-off styles.
3. Verify with `responsive-audit` and `ux-verification`.

## Deliverable
Screens/components with rationale and screenshots.
