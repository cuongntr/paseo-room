# Change Request — Phase 1 implementation deltas

| Field | Value |
|---|---|
| Change ID | `runtime-coordination-change-001` |
| Short name | Phase 1 implementation deltas |
| Original plan | [runtime-coordination-phase1-implementation-plan.md](runtime-coordination-phase1-implementation-plan.md) |
| Status | Applied |
| Owner | Repository owner |
| Created | 2026-09-22 |
| Accepted | 2026-09-22 — recorded after the fact during Phase 1 execution; repository owner review requested at feature-done |
| Applied | 2026-09-22 |

## 1. Change summary

The frozen Phase 1 plan was executed as written, but implementation and live qualification exposed
facts the plan and design did not state. Each delta below stays inside the design's authority and
scope — no new tool, role capability, contract prose or phase — and is recorded here rather than by
editing the Active plan.

## 2. Compelling reason

Each item was forced by observed platform behaviour or by a gap the code review or the live run found.

## 3. What changed

| # | Before (plan / design) | After | Reason |
|---|---|---|---|
| 1 | Event union limited to design §4 records | Added `binding.refused` {agentId, reason} | A created Peer that fails its fresh-snapshot proof must be recorded against the assignment and archived, never adopted (§3.3, §5.3); no existing event could hold its agent id. |
| 2 | Plugin discovers its own paths | Setup writes `server/generated/location.ts` (plugin dir, runtime root) as a managed entry | Paseo evaluates plugin bundles from memory with no cwd or `import.meta` path. The manifest still carries no path. |
| 3 | Peer created with the exact provider id only | Model resolved from operator-owned config (room profile model, else provider default); none → `peer_model_unresolved` | Paseo's SDK requires `provider/model`; the runtime still never selects a model. |
| 4 | Entries default-export `const` contributions | Hoisted function declarations, plus a bundle test | Paseo copies CommonJS exports eagerly; the first live install failed. |
| 5 | Icon `workflow` | `Workflow` (Lucide component name), plus a naming test | The app resolves icons by component name; mobile rejected the panel. |
| 6 | `export --out <dir>` | `--out` optional; default under `~/.paseo-room/runtime/v1/exports`; writes only with `--apply` | Keeps CLI writes inside the room home and dry-run by default (AGENTS.md). |
| 7 | `@getpaseo/client` 0.8.0-beta.1 | Exact `0.8.0` | Peer dependency of `@getpaseo/plugin@0.8.0` (plan risk R-4). |
| 8 | Code-review hardening | gate_run proven and recorded inside the project queue; uncertain gates settle from late sidecars and stop blocking once archived; dispatch waits for session association and an initializing Peer; notices recorded before recipient reads | Six review findings, each with regression tests. |

## 4. Impact

No REQ, work package or phase boundary changed. Beads were not re-planned; each delta was absorbed by
the bead that surfaced it and is cited in that bead's close reason.
