# Change Request — Admit the exact macOS Paseo Desktop launcher

| Field | Value |
|---|---|
| Change ID | `paseo-room-phase-1-change-001` |
| Short name | Admit the exact macOS Paseo Desktop launcher |
| Original plan | [Paseo Room Phase 1 Implementation Plan](paseo-room-phase-1-implementation-plan.md) |
| Status | Applied |
| Owner | Repository owner |
| Created | 2026-09-10 |
| Accepted | 2026-09-10 |
| Applied | 2026-09-10 |

## Decision

The frozen plan assumed every selected Paseo executable could satisfy the ordinary safe-parent rule. A standard Desktop installation places `/Applications/Paseo.app/Contents/Resources/bin/paseo` below root-owned mode-`0775` `/Applications`, so the generic parent rule prevents the required owner-managed macOS Desktop/daemon R3 rehearsal.

The Repository owner approved a minimal exception on 2026-09-10 and explicitly simplified it later that day. On `darwin` only, and only for that exact canonical executable path, `/Applications` may be mode-writable when `lstat` identifies it as a root-owned directory and its real path is exactly `/Applications`.

Every other invariant remains unchanged: the executable must be a canonical, regular, executable, single-link file owned by the current user or root; every other parent must pass the ordinary safe-directory rule. No Linux exception or other `.app` path is admitted. The exact Desktop `#!/bin/sh` launcher is invoked directly with provider-free `PATH=/usr/bin:/bin`; password handling, ownership checks, and rollback behavior are unchanged.

## Scope and impact

- `paseo-room-b9k.1` implements and proves this exact exception.
- `paseo-room-czd` remains dependent on it; this delta does not execute or approve R3.
- The PRD, public lifecycle/JSON/exit contracts, daemon admission evidence, frozen plan body, schema, dependencies, and credential behavior are unchanged.
- Arbitrary bundle paths, any other unsafe parent, writes or repairs to Paseo, and daemon lifecycle management remain out of scope.

Risk is bounded by exact platform/path matching, root ownership and canonical real-directory proof for `/Applications`, and unchanged checks everywhere else. Repository-local unit, documentation, typecheck, lint, and isolated contract evidence are sufficient for this internal developer-tool exception; no extra review gate is introduced.

## Approval and application

Approved-by: Repository owner, in-session 2026-09-10.

Application updates the Active Technical Design, implementation, focused tests, operator guide, acceptance record, and the original plan's revision-history link. The real Desktop/user-home R3 remains a separate owner-approved operation.

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-10 | Repository owner | Accepted the exact macOS Desktop launcher exception. |
| 2026-09-10 | Repository owner | Simplified the exception to platform/path and `/Applications` metadata checks only; removed the superseded subprocess and extra review requirements. |
| 2026-09-10 | Implementation agent | Applied the simplified implementation, tests, and documentation; R3 remains pending. |
