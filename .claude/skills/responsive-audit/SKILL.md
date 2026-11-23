---
name: responsive-audit
description: Audit FileNest layouts and touch targets across viewports. Use after UI changes or before release.
---

# responsive-audit

## When to use
Any layout change; release checks.

## Steps
1. Viewports: 375×812 (phone), 768×1024 (tablet), 1280×800 and 1920×1080 (desktop). Also landscape phone.
2. For Drive, Shared, Trash, Search, Admin (Members/Storage/Audit), Login, Not-authorized, public share page:
   - no horizontal scrolling; long file names truncate, not overflow
   - touch targets ≥ 40×40 (buttons use `size="icon"` = 40px)
   - dialogs are bottom sheets < 640px and fit `92dvh`
   - upload panel does not cover primary actions permanently (collapsible)
3. Use Playwright `@mobile` specs or the browser pane’s viewport emulation; capture screenshots.

## Deliverable
Table: screen × viewport → pass/issue, with screenshots and fixes.
