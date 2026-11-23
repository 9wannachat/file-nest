---
name: product-ui-design
description: FileNest's own visual and interaction design: Drive, Share dialog, Storage Admin. Use when designing or restyling UI.
---

# product-ui-design

## When to use
New screens, layout changes, visual polish.

## Design language
- Name **FileNest**; logo `public/icons/favicon.svg` (replace with the owner's logo and run `pnpm icons`).
- shadcn/ui (new-york) on Tailwind v4 tokens in `src/web/index.css`; brand teal is `--primary` in both Light and Dark; `--warning`/`--success`/`--destructive` for states. Never hard-code colors; check both themes and AA contrast.
- App shell = shadcn Sidebar (collapsible to icons, Sheet on mobile) with storage meter and account menu (Theme: Light/Dark/System); ⌘K command palette for search and navigation.
- Familiar file-manager patterns, original styling: breadcrumb title, sortable list or grid view (URL params), checkbox multi-select with a bulk toolbar, ⋯ row menu (bottom Sheet on mobile) + right-click menu, drag-and-drop overlay, floating upload button on mobile, bottom-right upload panel.
- Share dialog: members first, then “General access” Select (Restricted / Anyone with the link) with lock/globe icon, copy link and optional password.
- Storage Admin: status banner stating where new uploads go; per-target badges (Receiving new files / Accepting / Read-only / Healthy / Check failed / Secrets missing).
- Mobile: nav drawer, dialogs become bottom sheets, metadata collapses under the filename.

## Steps
1. Sketch states (loading/empty/error/offline) before visuals.
2. Reuse `components/ui/*`; extend variants instead of one-off styles.
3. Verify with `responsive-audit` and `ux-verification`.

## Deliverable
Screens/components with rationale and screenshots.
