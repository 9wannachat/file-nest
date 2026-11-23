---
name: plan-guard
description: Enforces FileNest's Analyze → Propose → wait for approval → Implement workflow. Use at the start of every task and whenever scope grows.
---

# plan-guard

## When to use
Always. Especially when a request arrives that would edit files, install packages, or touch Cloudflare/Google.

## Steps
1. **Analyze (read-only)**: read AGENTS.md, relevant code, tests, config. No edits, installs, or resource creation.
2. **Propose**: plan in the owner's language (Thai if they write Thai) — architecture, schema, API, flows, files, expected results, risks, test plan; split *local-verifiable* vs *needs real services/devices*.
3. **Stop** and wait for an explicit approval word (`ทำเลย`, `confirm`, `go ahead`). Questions or discussion ≠ approval.
4. **Implement** only approved scope; run checks after each change; run `delivery-check` before handing off.
5. **Scope change** → write the delta plan and wait again.
6. **Real infrastructure** (provision, deploy, remote migrate, change OAuth/R2/CORS) → needs a specific instruction for that action.

## Deliverable
Either a plan ending in “waiting for approval”, or an implementation report that cites the approval.
