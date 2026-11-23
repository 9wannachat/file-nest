---
name: legacy-discovery
description: Read-only discovery of an existing system before changing it. Skip for greenfield. Use when FileNest is being integrated with or migrated from prior code/data.
---

# legacy-discovery

## When to use
Only when there is pre-existing code, data or infrastructure to understand. FileNest v0.1 was greenfield (empty repo), so this was skipped.

## Steps (read-only)
1. Inventory: repo tree, package manifests, scripts, CI, deployment config, env var names (never values).
2. Trace auth: login flow, session storage, roles.
3. Trace storage: where files live, how keys are named, how access is checked, any public URLs.
4. Trace frontend: routes, data fetching, caching (service workers!).
5. Data: schema, row counts by table (no personal data copied), orphan risks.
6. Record problems, causes, constraints, and impact of changing each.

## Deliverable
Findings document; explicitly “no files modified”.
