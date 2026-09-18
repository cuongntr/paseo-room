# Orchestration Quality Hardening — Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-18 — Repository owner |
| Owner | Repository owner |
| Routing decision | [Technical Design routing decision](../design/orchestration-quality-hardening.md#routing-decision): brownfield; contract and capability-boundary risks; plan → converter |
| Source PRD / requirements | [`ORCHESTRATION_REVIEW.md`](../../ORCHESTRATION_REVIEW.md) plus repository-owner implementation direction; no PRD amendment required because product intent is unchanged |
| Source Technical Design | [Orchestration Quality Hardening](../design/orchestration-quality-hardening.md) |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Phase | Phase 1 MVP — contract and capability hardening |

## 1. MVP-Lock

- **In this phase:** anti-pre-solving and independent-judgment contract; Supervisor observation/advice; documentation of the conservative writer policy; protocol-governed Peer model/effort defaults; Peer resource hygiene; exact Peer skill projection; bounded Paseo MCP conflict detection; Codex active-profile closure and fail-closed catalog capture; exact provider environment drift; warning-only risky thinking diagnostics; Claude MCP-name drift diagnostics; contract digest; managed replacement safety; active documentation deduplication and correction.
- **Out of this phase:** OS sandboxing; hostile shell/network containment; rewriting operator MCP/hooks/plugins; multi-writer worktree policy; Supervisor notebook; role-specific room-authored skill framework; stripping Codex catalog instruction fields; Claude CLI prompt injection; unverified hard prohibition of `ultra`/`ultracode`; Paseo upstream changes; release publication.
- **Exit criteria:** every work package exit condition is met; affected docs accurately distinguish guarantees, heuristics, and unresolved vendor behavior; no operator credential content is read; setup remains dry-run by default and idempotent; `npm run verify` passes completely; git diff contains no generated dependency or temporary Beads artifacts.
- **Default checkpoint posture:** no irreversible state. Each package is contained by reverting its source/docs changes or running the previous package version's `setup --apply`. Existing role credentials and operator homes are never rollback targets.

Scope is frozen. New vendor surfaces or unrelated review findings require a delta-change rather than expansion.

## 2. Work Packages

### WP-001: Strengthen the model-facing contract

- **Outcome:** Lead briefs preserve Peer judgment, Peer receives explicit independent-judgment guidance, Supervisor receives a positive observation/advice mandate, and task-risk model/effort policy is reconciled with Peer seat eligibility without changing the conservative writer limit.
- **Requirement / AC coverage:** C4, C5, C6 documentation decision, C7.
- **Design refs:** Technical Design D5, Boundaries, Compatibility.
- **Prerequisites:** none.
- **Sequencing:** update canonical Markdown and semantic registry/order first, then focused instruction tests and explanatory design text. Do not move discovery/recovery into a skill or add a notebook.
- **Exit condition:** rendered Lead/Peer/Supervisor documents contain the new semantic sections/phrases in deterministic order; Peer still lacks Topology; authority distribution is unchanged except for the explicit judgment/advice grants; instruction and prompt inventory tests pass.

### WP-002: Close known Peer configuration capabilities

- **Outcome:** Peer no longer receives shared executable orchestration resources, receives an exact non-Paseo skill projection, and setup/verify fail before apply when operator or role-owned MCP configuration recognizably exposes Paseo.
- **Requirement / AC coverage:** C1, C2b, Oracle C2c.
- **Design refs:** Technical Design D1–D3, Architecture, Compatibility.
- **Prerequisites:** none.
- **Sequencing:** introduce bounded MCP/resource helpers and characterization tests; add the exact managed-directory entry primitive; then update all three adapters. Preserve Supervisor/Lead behavior and all credential rules.
- **Risk boundaries / decomposition hints:** managed-directory filesystem behavior is a prerequisite consumed by adapter projection. MCP detection and resource projection are independently reviewable but jointly establish the Peer capability outcome.
- **Exit condition:** all three agent families exclude `paseo*` skills from Peer while retaining non-Paseo skills; Codex/Claude Peer omit plugin/hook/command resources with execution capability; Supervisor/Lead retain prior sharing; skill inventory drift is detected/repaired; recognized Paseo MCP declarations in Codex, Claude, Pi, or existing Claude role state fail with actionable diagnostics; benign MCP declarations pass.

### WP-003: Harden Codex and live-provider guarantees

- **Outcome:** active Codex profiles cannot override the room catalog or multi-agent feature flags, catalog scrubbing fails closed when evidence is unavailable, and live provider environment additions/removals are detected.
- **Requirement / AC coverage:** C2a, C3 invariant portion, Oracle provider-env finding.
- **Design refs:** Technical Design D4 and Testing Strategy.
- **Prerequisites:** none.
- **Sequencing:** extend `renderRoleConfig` with profile-supported fields only; change catalog failure diagnostics; then tighten provider env comparison and add negative drift tests.
- **Exit condition:** active-profile tests prove catalog path and both multi-agent feature representations are pinned; `[agents]` remains top-level; malformed/unavailable catalog prevents a Codex plan; provider comparison rejects extra/missing/different env keys while still ignoring unrelated top-level live fields.

### WP-004: Add provenance and bounded diagnostics

- **Outcome:** installed rooms identify their rendered contract generation; risky thinking selections and Claude MCP-name divergence are visible without claiming unsupported behavior or mutating runtime-owned state.
- **Requirement / AC coverage:** C8 digest portion, C9 warning-only, C10 diagnostics, C3 transparency portion.
- **Design refs:** Technical Design D6, Compatibility, Open Questions.
- **Prerequisites:** WP-002 for the shared MCP parser/detection semantics; WP-003 for final catalog failure policy.
- **Sequencing:** make marker schema backward compatible, compute a deterministic digest from all rendered role/workspace documents, then add diagnostics using the already-read live profile and narrowly parsed Claude MCP names.
- **Exit condition:** old markers parse; new markers deterministically contain a contract digest; verify warns—not fails—on `ultra`/`ultracode` while explicitly labeling delegation behavior unverified; Claude MCP-name drift warns without rewriting `.claude.json`; catalog-related failures/drift are distinguishable from generic prompt drift where evidence allows.

### WP-005: Make managed replacement safe

- **Outcome:** managed regular files and symlinks replace atomically, unexpected path types are preserved with actionable failure, and exact managed directories reconcile only declared children including the legacy Peer-skills migration.
- **Requirement / AC coverage:** C11 and the filesystem prerequisite of WP-002.
- **Design refs:** Technical Design D3, D7, Compatibility.
- **Prerequisites:** none for the primitive; WP-002 consumes its final API.
- **Sequencing:** implement refusal/type classification and tests first; add sibling-temp replacement and cleanup; add exact managed-directory migration/reconciliation last.
- **Risk boundaries / decomposition hints:** the exact managed-directory primitive and ordinary file/link atomic replacement have distinct validation, but both belong to one filesystem ownership contract. Never generalize exact reconciliation to role homes.
- **Exit condition:** tests prove unexpected directories/files/symlinks are not recursively removed; ordinary updates remain idempotent; temp siblings are cleaned; legacy Peer skill links migrate safely; credential tests remain green.

### WP-006: Align and deduplicate active documentation

- **Outcome:** design and operator guidance accurately describe implemented capability boundaries, catalog freezing, Claude carrier limitation, writer-policy divergence, contract provenance, and recovery while authoritative procedural prose remains canonical under `src/room/prompts/`.
- **Requirement / AC coverage:** C3 documentation, C6 divergence, C12, C13, D1 clarification.
- **Design refs:** Technical Design Boundaries, Decisions, Compatibility, Open Questions.
- **Prerequisites:** WP-001 through WP-005 so documentation reflects final behavior.
- **Sequencing:** update `docs/design.md` first, then shorten duplicated README procedure to links/summaries, and keep `docs/orchestration-model.md` conceptual rather than implementation-specific.
- **Exit condition:** no active documentation claims skill/MCP hygiene is a sandbox; no detailed Lead-discovery procedure is duplicated outside the canonical contract; Claude's weak carrier and unsupported stronger surface are stated; catalog generated-copy semantics and rerun/restart requirements are explicit; links resolve.

## 3. Dependencies

| Edge | Reason |
|---|---|
| WP-002 consumes WP-005's managed-directory primitive | Exact Peer skill projection requires bounded migration and stale-child reconciliation. |
| WP-004 depends on WP-002 | Claude/Pi/Codex MCP diagnostics must share the settled parser and conflict semantics. |
| WP-004 depends on WP-003 | Provenance and catalog diagnostics must describe the final fail-closed policy. |
| WP-006 depends on WP-001–WP-005 | Documentation must describe implemented contract and runtime behavior, not anticipated behavior. |

WP-001, WP-003, and the ordinary replacement portion of WP-005 may proceed independently after file-overlap checks. The graph is acyclic.

## 4. Test Strategy

Use Vitest with current temporary-home/fake-daemon fixtures. Tests stay with each implementation outcome. Run focused tests during each package and the full repository gate at closure:

```bash
npm run verify
```

No numeric coverage threshold is introduced because the repository has no coverage instrumentation. Minimum evidence is requirement-based: every new failure path, migration path, role distribution, provider comparison, marker compatibility path, and diagnostic has focused automated evidence, followed by the full 5-stage gate.

## 5. Security and Containment

- Policy boundary: Paseo remains the only supported control plane, but Peer is not an OS sandbox.
- Negative evidence: tests must prove room tools remain disabled, recognized Paseo MCP is rejected, executable shared resources are absent from Peer, active profile overrides are closed, and provider env additions drift.
- Review: perform one independent Oracle review over the bounded final diff because this changes model-facing authority and control-plane capability boundaries.
- Rollback: prior package setup regenerates prior desired state; no operator config or credential rollback.
- R3 decision: N/A — no destructive external state, schema, credential migration, or weak rollback.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Skill projection deletes operator data through a mistaken ownership assumption. | Exact reconciliation is limited to generated Peer skill directories; legacy symlink migration only; filesystem negative tests; repository owner. | mitigated by WP-005 design |
| R-002 | MCP heuristic blocks a benign server or misses an obfuscated Paseo endpoint. | Boundary-token matching, source-naming diagnostic, explicit heuristic documentation; never claim sandboxing; repository owner. | accepted |
| R-003 | Catalog fail-closed breaks unsupported old Codex versions. | Paseo-room requires a runtime that can supply the catalog needed for its documented third closure layer; actionable failure; repository owner. | accepted |
| R-004 | Contract changes are delivered through Claude memory and diluted. | Keep changes concise; document carrier limit; no unsupported command hack; Paseo upstream owns a stronger provider field. | accepted |
| Q-001 | Is hard rejection of top thinking tiers justified? | Vendor evidence is insufficient; implement warning-only. | answered |
| Q-002 | Should multiple worktree writers be enabled now? | No; retain current conservative policy and document divergence. | answered |

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | Bytes | Created and activated with six work packages after design-ready and plan-ready self-review; scope frozen for conversion. |
