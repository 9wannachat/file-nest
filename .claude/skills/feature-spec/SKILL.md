---
name: feature-spec
description: Write a FileNest feature spec: user flows, API contracts, permission matrix, failure cases. Use before implementing any user-facing feature.
---

# feature-spec

## When to use
Phase 2 for new features or behaviour changes.

## Steps
1. User stories per role: owner, shared member, admin (no implicit file access), anonymous link holder.
2. Flows step by step including offline / retry.
3. API contract per endpoint: method, path, auth, CSRF, request JSON, response JSON, status + `error.code` list.
4. Permission matrix rows = actions (list, search, HEAD, Range, preview, download, rename, move, trash, restore, purge, upload, share) × columns = roles; default deny.
5. Failure cases: invalid input, not found vs forbidden (both 404), quota/size/rate, storage unavailable, concurrent edits, revoked links.
6. Acceptance criteria as testable statements; mark which need real services.

## Deliverable
Spec markdown with the sections above.
