# Paseo Room Runtime Coordination — Phase 2 MVP Implementation Plan

| Field | Value |
|---|---|
| Status | Archived |
| Plan-ready | PASS — 2026-09-23 — Bytes (self-evaluated under the repository owner's instruction to proceed) |
| Owner | Repository owner |
| Routing decision | [PRD routing decision](../product/runtime-coordination-prd.md#routing-decision): brownfield; trusted-plugin boundary, public tool/RPC contract, persistent local state, role authorization, concurrency, phased rollout with weak rollback; PRD → Technical Design (+ Phase 2 delta) → Implementation Plan → Beads |
| Source PRD / requirements | [Paseo Room Runtime Coordination PRD](../product/runtime-coordination-prd.md) — Accepted 2026-09-22: G-003, REQ-010, REQ-011, Roadmap row "Phase 2 MVP — Worktree concurrency" |
| Source Technical Design | [Phase 2 design delta](../design/runtime-coordination-phase2.md) — Active 2026-09-23, on top of the [Runtime Coordination Technical Design](../design/runtime-coordination.md) — Active |
| Related ADRs | N/A — no ADR directory exists; the governing authority change is the Lead-contract amendment landed in `53d488f` (delta §3), with [design.md](../design.md) and [AGENTS.md](../../AGENTS.md) |
| Phase | Phase 2 MVP — Worktree concurrency |

## 1. MVP-Lock

- **In this phase:** PRD REQ-010 and REQ-011, as the delta specifies them:
  - an `isolation: 'lead-workspace' | 'worktree'` choice on writable dispatch, default `lead-workspace` (Phase 1 behaviour, byte for byte);
  - runtime-requested Paseo worktree workspaces with runtime-chosen ids and idempotency keys, proven by Git after creation;
  - the setup-observability refusal;
  - writer leases with epochs, and the fixed cap `MAX_WORKTREE_LEASES = 3`;
  - the canonical scope grammar with a conservative in-repo overlap checker, including the collision refusals at dispatch;
  - scope conformance evidence at handoff;
  - gated workspace close and explicit reclaim, as two new Lead operations with Human panel forms;
  - recovery for every new intent;
  - status, panel, export, deselection and remove-warning updates;
  - runtime-chosen `agentId`/`idempotencyKey` for Peer creation on both isolation modes (delta Q-P2-04).
- **Out of this phase:**
  - merge, rebase, cherry-pick, conflict resolution, landing, push or branch deletion (delta §1);
  - running, skipping or observing `paseo.json` `worktree.setup` — repositories that declare it are refused until Q-P2-02 closes;
  - a configurable lease cap;
  - cross-project or remote coordination;
  - new Peer tools — `PEER_REPORTING_TOOLS` stays `ask`/`handoff`;
  - Phase 3 findings, incidents and budgets;
  - any sensor;
  - any further contract prose change beyond the landed §3 amendment;
  - widening the Paseo range.
- **Exit criteria:**
  1. every work-package exit condition below holds;
  2. `npm run verify` passes the complete chain, and a runtime room that never dispatches with
     `isolation: 'worktree'` produces the same event types and projections as Phase 1;
  3. delta §9 L-2 through L-7 pass live on Paseo `0.9.1` with exact `codex-peer`, `claude-peer` and
     `pi-peer` (WP-008);
  4. three concurrent writable assignments complete handoff and acceptance in three worktrees, and
     overlap, serial-path, cap, exclusive-writer and uncertain-writer cases refuse before any Paseo
     call (PRD Phase 2 success evidence);
  5. the Phase 2 delta, the Technical Design and the PRD record completion, and `feature-done` passes.
- **Default checkpoint posture:** Phase 2 behaviour is reached only through an explicit
  `isolation: 'worktree'` dispatch on a daemon version that passed delta §9, so every existing room
  keeps its Phase 1 behaviour until a Lead asks for isolation.
  - **Containment:** stop requesting `worktree` dispatch, then close or abandon the work; deselection additionally requires no non-released lease and no unresolved workspace close.
  - **Rollback:** reinstall the Phase 1 package. Its plugin pauses projects holding Phase 2 events and preserves them; it never converts them.
  - **Weak-rollback points:** persistent Phase 2 events, and worktrees left on disk. Both are owned by the R3 decision in WP-008 (risk owner: repository owner; rehearsal selected).

After activation this scope is frozen. A new tool, an event type outside delta §4, a contract prose
change, or a change of the lease cap requires a delta-change rather than an added bead.

## 2. Settled Implementation Decisions

| Decision | Resolution | Basis |
|---|---|---|
| Lease cap | `MAX_WORKTREE_LEASES = 3`, a constant in `shared/limits.ts`, not configuration. | Delta P2-D1, Q-P2-03 (settled by delta activation) |
| Qualified daemon gate | A constant list of daemon versions that passed delta §9 (initially empty; `0.9.1` is added only by WP-008 evidence). A `worktree` dispatch on any other version refuses `worktree_unqualified` before recording anything. | Delta §8 |
| Workspace identities | The runtime mints `wks_` + 16 lowercase hex for `workspaceId` and `ws-<assignmentId>-e<epoch>` for the idempotency key, and records both in `workspace.create-requested` before the call. Branch `paseo-room/<assignmentId>`; slug `<assignmentId>` lower-cased. | Delta P2-D3, P2-D4; probe §9.1 |
| Peer create identities | For both isolation modes, `agentId` = a fresh UUID and `idempotencyKey` = `<assignmentId>-g<generation>-create`, recorded in `agent.create-requested` as optional top-level fields. `payloadVersion` stays 1: the event reader's own rule (`server/events/schema.ts` header) ignores unknown additive top-level fields, so a Phase 1 reader still replays these events (see WP-002). Recovery reissues the identical create instead of searching by label. | Delta P2-D3, Q-P2-04 |
| Setup detection | Read `paseo.json` at the exact `baseCommit` through `git show <commit>:paseo.json`; non-empty `worktree.setup` refuses `worktree_setup_unobservable`. A missing file or no setup is allowed. | Delta P2-D5 |
| Scope checker | `server/domain/scope.ts`, no dependency: `parseScope`, `normalizeScope`, `overlaps`, `reaches` (serial path), `conforms(changedPaths, scopes)`. Tests use `node:path` `matchesGlob` only as an oracle. | Delta §5, §5.5 (resolves PRD Q-011) |
| New Lead operations | `workspace_close { assignmentId, discardUncommitted?: true, reason? }` and `lease_reclaim { assignmentId, reason }`, appended to `LEAD_OPERATIONS`; both require the caller to be the corroborated Lead of the assignment. `discardUncommitted` requires `reason`. | Delta §4, P2-D6, P2-D7 |
| Human forms | Extend the existing `runtime.recover` family with `runtime.workspaceClose` and `runtime.leaseReclaim` RPCs carrying `idempotencyKey`; the panel exposes them only on a retained workspace or a lease whose prior Peer is proven archived. | Delta §4; existing `shared/rpc-contracts.ts` |
| Gate cwd | For a `worktree` assignment the gate runs in the lease's `worktreePath`; every other gate rule is unchanged. | Delta §6; `server/gate.ts` |

## 3. Work Packages

### WP-001: Scope grammar and conservative overlap checker

- **Outcome:** a pure, dependency-free `server/domain/scope.ts`. It parses and normalises scope entries under the §5.1 grammar and refuses malformed ones with the offending item. It decides `overlaps`, serial-path `reaches` and handoff `conforms`, erring toward "overlapping" wherever overlap cannot be ruled out.
- **Requirement / AC coverage:** REQ-011 (canonical comparison; empty scope is the whole repository; overlap refused).
- **Design refs:** delta §5.1, §5.2, §5.4, §5.5.
- **Prerequisites:** none.
- **Sequencing:** grammar and normalisation, then overlap, then `reaches`/`conforms`, then the oracle soundness test.
- **Risk boundaries:** Soundness is the contract. A false "disjoint" is a defect; a false "overlap" is acceptable. Case folding and NFC apply before any comparison. No import outside `node:` and `zod`.
- **Exit condition:**
  - Unit tests cover every refused form: absolute, `..`, `.`, backslash, `!`, `{}`, `[]`, empty segment and over-limit.
  - Unit tests cover the implicit trailing `/**` and the prefix/suffix disjointness rules.
  - An oracle test enumerates every path up to depth 4 over a small alphabet and proves that `overlaps` never returns `false` where `matchesGlob` finds a common match.
  - The boundary test still passes.

### WP-002: Contracts, events and lease/workspace projection

- **Outcome:** Everything later WPs consume, validated and projected:
  - `assignment_dispatch` gains the optional `isolation` and `serialOnly` fields.
  - The two new Lead operations are added with strict schemas, tool descriptions and generated tool files.
  - The ten delta §4 event types are added at `payloadVersion: 1`.
  - `agent.create-requested` gains optional `agentId`/`idempotencyKey`.
  - The domain projection gains a lease record: state reserved → held → releasing → released/uncertain, plus epoch, workspace, scopes and `serialOnly`. It also gains a workspace record: create and close states, plus `directoryRemoved`.
  - The authorization matrix is extended so only the assignment's Lead (or Human through RPC) may close or reclaim.
- **Requirement / AC coverage:** REQ-010 (one writer per worktree represented in state), REQ-011 (scopes carried), REQ-016-style explicit discriminators for the new schemas.
- **Design refs:** delta §4, P2-D6, P2-D7; Technical Design §4.2–§4.4, §5.1, §5.3; `server/events/schema.ts`, `server/domain/state.ts`, `server/domain/authorize.ts`, `shared/policy.ts`.
- **Prerequisites:** WP-001, whose `parseScope` validates `writeScope`/`serialOnly` for `worktree` dispatch.
- **Sequencing:** schemas and policy tuple first, then event types with replay, then projection and authorization, then the generated Lead tool file.
- **Risk boundaries:** This is a **persisted-contract seam**. No existing v1 field changes meaning or requiredness. The only v1 change is two optional top-level fields on `agent.create-requested`, which the schema header permits as additive: prove that every Phase 1 fixture replays unchanged under the new reader, and that a Phase 1 reader replays a new `agent.create-requested`. A Phase 1 plugin meeting a new type must pause the project (already true — keep a test). `PEER_REPORTING_TOOLS` and `ROLE_PASEO_TOOLS` do not change.
- **Exit condition:**
  - Schema tests accept valid inputs and refuse unknown fields.
  - Replay of every Phase 1 fixture is byte-identical in projection.
  - Replay of each new event type drives the lease and workspace states as specified, with epoch monotonic.
  - Only the assignment's Lead is authorized for `workspace_close` and `lease_reclaim`.
  - The generated `tools/lead.json` lists exactly twelve operations, and the Peer tool files are unchanged.

### WP-003: Git evidence for worktrees

- **Outcome:** `server/git.ts` gains the worktree proofs the controller needs:
  - `provesWorktree(dir, { gitCommonDir, baseCommit })` checks common dir, exact `HEAD`, clean tree, and a directory that is not Lead's;
  - `closeReadiness(dir, { candidate, base })` returns clean at candidate/base, or dirty/unrecorded;
  - `setupDeclared(commonDir, baseCommit)` reads `paseo.json` at the commit;
  - candidate derivation works inside a worktree.

  Each is read-only.
- **Requirement / AC coverage:** REQ-010 (worktree identity and no reuse evidence), REQ-011 (changed paths for conformance).
- **Design refs:** delta P2-D4, P2-D5, P2-D7, §5.4; `server/git.ts`, Technical Design D5.
- **Prerequisites:** none.
- **Sequencing:** independent of WP-001/002; may run in parallel.
- **Risk boundaries:** Never run a mutating Git command. The existing-branch rename (delta §9.1) must be caught by the `HEAD` and branch check, not assumed away.
- **Exit condition:** Temporary-repository tests show:
  - an exact base passes;
  - a moved `HEAD`, a dirty tree, a foreign common dir and Lead's own directory each fail with distinct codes;
  - `setupDeclared` distinguishes absent, empty and non-empty setup;
  - `closeReadiness` separates clean-at-candidate, clean-at-base, dirty and unrecorded-commit.

### WP-004: Paseo port for workspaces and identified creation

- **Outcome:** `PaseoPort` and `sdkPaseoPort` gain:
  - `createWorktreeWorkspace`, with the explicit id, key and worktree source;
  - `archiveWorkspace`;
  - `getWorkspace`;
  - `createAgentInWorkspace`, through `workspaces.ref(id).agents.create` with parent, `agentId` and `idempotencyKey`.

  Phase 1 `createAgent` also passes `agentId`/`idempotencyKey`. The fake port in `test/runtime-fake-paseo.ts` models receipts (replay, key conflict), the branch-rename behaviour and placement.
- **Requirement / AC coverage:** REQ-010 (native Paseo worktree lifecycle stays authoritative).
- **Design refs:** delta P2-D3, P2-D4, P2-D7, P2-D8, §9.1; `server/paseo-port.ts` (the only module that calls Paseo's SDK — AGENTS.md).
- **Prerequisites:** none for the port; WP-002 for the create-intent fields it records (sequencing only through the controller in WP-005).
- **Sequencing:** port types and fake first, then the SDK implementation, then the Phase 1 create change behind the existing recovery tests.
- **Risk boundaries:** Only `server/paseo-port.ts` may touch the SDK. Receipt conflicts surface as a distinct error, never retried with a new key. No path-, slug- or title-based lookup is added.
- **Exit condition:**
  - The fake reproduces the §9.1 probe outcomes: replay, conflict, rename and placement.
  - Phase 1 dispatch and recovery tests pass with identified creation.
  - Recovery of a lost create reissues the identical request and gets the same agent.

### WP-005: Worktree dispatch, collision refusal and conformance

- **Outcome:** `assignment_dispatch` with `isolation: 'worktree'` runs the delta §6 lifecycle, in the project's serial lane:
  1. validate the qualified daemon version;
  2. check that setup is not declared;
  3. validate the grammar;
  4. run the §5.3 collision checks (`writer_exclusive`, `lease_cap`, `scope_overlap`, `serial_path`, `writer_uncertain`) before any Paseo call;
  5. reserve the lease;
  6. create the workspace, prove it with Git, or refuse and close it;
  7. create the Peer in the workspace with Lead as parent;
  8. bind, hold, open the generation, run.

  A `lead-workspace` dispatch is refused while any worktree lease is non-released. At handoff the candidate is derived from the worktree, and paths outside scope record `scope.exceeded`. Accepting such a candidate requires the existing override. Gates run in the worktree.
- **Requirement / AC coverage:** REQ-010, REQ-011 (all ACs), PRD Phase 2 "overlap and uncertain-writer cases fail before dispatch".
- **Design refs:** delta P2-D1, P2-D2, P2-D4, P2-D5, P2-D8, §5.3, §5.4, §6, §8; `server/controller.ts` `dispatch`, `server/handlers/peer.ts`, `server/domain/acceptance.ts`, `server/gate.ts`.
- **Prerequisites:** WP-001 (checker), WP-002 (events/projection), WP-003 (Git proofs), WP-004 (port).
- **Sequencing:** refusals first (they need no Paseo), then the happy path to `run`, then handoff conformance and gate cwd.
- **Risk boundaries:** This is the **concurrency seam**. Every refusal happens before `assignment.dispatch-requested` is written. Two concurrent dispatches in one project are serialized by the existing project lane, so collision is decided on a single projection. The `lead-workspace` path must stay byte-identical in events to Phase 1.
- **Exit condition:** Controller tests against the fake show:
  - each refusal code, with no Paseo call made;
  - three disjoint worktree dispatches all held at once;
  - a fourth refused `lease_cap`;
  - a created-but-unproven workspace recorded `workspace.create-refused` and closed with no Peer;
  - the Peer placed in the lease's workspace with Lead as parent;
  - `scope.exceeded` recorded and acceptance refused without override;
  - gates running in the worktree;
  - Phase 1 controller tests unchanged.

### WP-006: Workspace close, reclaim and recovery

- **Outcome:**
  - After writer release, the runtime requests a workspace close automatically only when `closeReadiness` is clean at candidate or base. Otherwise it retains the workspace and sends an `owner` notice naming `workspace_close`.
  - `workspace_close` with `discardUncommitted` and a reason closes a retained workspace.
  - `lease_reclaim` bumps the epoch only on Phase 1 archive/`closed` proof, and makes the prior generation's capability stale.
  - The Human RPC forms of both are added.
  - Recovery covers the delta §7 rows: identical-request reissue for `workspace.create-requested`, live record plus directory for `workspace.close-requested`, and lease-in-workspace Peer create.
- **Requirement / AC coverage:** REQ-010 ("a worktree is not reused while its previous agent may still write"; native teardown authoritative).
- **Design refs:** delta P2-D6, P2-D7, §7; Technical Design §6, §5.3; `server/recovery.ts`, `server/rpc.ts`, `shared/rpc-contracts.ts`.
- **Prerequisites:** WP-005, whose leases, workspaces and Peers exist to close or reclaim.
- **Sequencing:** close readiness and the automatic close, then `workspace_close`, then `lease_reclaim`, then recovery rows, then the RPC forms.
- **Risk boundaries:** This is the **destructive-effect seam**: Paseo's close runs `git worktree remove --force`.
  - Nothing closes a dirty or unrecorded worktree without an explicit `discardUncommitted` decision.
  - Time, idle state or turn end never releases or reclaims.
  - The runtime never deletes a directory or branch itself.
- **Exit condition:** Tests show:
  - a clean close records `directoryRemoved`;
  - a dirty worktree is retained with a notice, then closes only with discard and a reason;
  - a teardown failure yields `directoryRemoved: false` as cleanup evidence;
  - a reclaim is refused without archive proof;
  - after a reclaim, an old-epoch report fails `report_stale`;
  - a crash at every new intent/result boundary recovers without duplicate workspaces or Peers.

### WP-007: Status, panel, export, deselection, removal and documentation

- **Outcome:**
  - The status view and panel show leases (epoch, scopes, workspace, branch), retained workspaces and `scope.exceeded`, each with its evidence class. The panel says scope checks are collision prevention, not containment (REQ-011).
  - Export includes the new events.
  - Deselection refuses while a lease is non-released or a close is unresolved.
  - The `remove` warning counts retained runtime worktrees, which it does not delete.
  - The README runtime section, `docs/design.md` and the Technical Design are updated for Phase 2.
- **Requirement / AC coverage:** REQ-011 (UI statement), REQ-013/REQ-015 continuity for new state, REQ-010 containment.
- **Design refs:** delta §8; Technical Design §8, §10, §14; `server/domain/views.ts`, `client/views.tsx`, `src/runtime.ts`, `src/export.ts`, `src/commands.ts`.
- **Prerequisites:** WP-002 (projection). The panel's Human actions need WP-006.
- **Sequencing:** status view and export first, then deselection/remove, then panel, then docs.
- **Risk boundaries:** The CLI only reads `runtime/`. The panel returns no path outside the room's own projection and no credential.
- **Exit condition:**
  - RPC/view tests cover the new fields and evidence labels.
  - The deselection refusal has a test, and the remove warning shows the retained-worktree count.
  - View tests (`test/runtime-views.test.ts`) cover lease, retained-workspace and `scope.exceeded` rows with their evidence classes; the panel needs no new visual check beyond the Phase 1 wide/dark record.
  - The docs name `isolation: 'worktree'` and its refusals.

### WP-008: Live qualification (delta §9) and R3 rehearsal

- **Outcome:** Delta §9 L-2 through L-7 are proven on a real Paseo `0.9.1` daemon, and `0.9.1` is added to the qualified-version list. The proof uses an isolated home, as in the 2026-09-23 rehearsal, and exact `codex-peer`, `claude-peer` and `pi-peer` with real credentials where a turn is needed. It covers:
  - three concurrent worktree assignments to acceptance;
  - every refusal;
  - clean close, dirty retention and teardown failure;
  - daemon restart with three held leases and one unresolved workspace create;
  - setup refusal;
  - carrier and reporter arrival in a worktree Peer.

  The R3 rehearsal adds the Phase 1 downgrade (projects pause, events preserved) and deselection with retained worktrees.
- **Requirement / AC coverage:** PRD Phase 2 success evidence; exit criteria 3 and 4.
- **Design refs:** delta §8, §9, §9.1; Technical Design §14 R3 decision.
- **Prerequisites:** WP-005, WP-006, WP-007.
- **Sequencing:** L-3 carrier/reporter first (it can invalidate the Peer path), then L-2/L-4/L-5, then L-6 restart, then L-7, then R3.
- **Risk boundaries:** Never run destructive steps against the operator's room. Record evidence from the event ledger, not from agent prose.
- **Exit condition:**
  - Every §9 item is recorded as pass, or as a failing premise that sends the delta back to Review.
  - The qualified-version constant names `0.9.1` with a pointer to the evidence.
  - The R3 rehearsal is recorded.
  - `npm run verify` passes.

## 4. Dependencies

| Edge | Producer outcome needed |
|---|---|
| WP-001 → WP-002 | `parseScope` validates `worktree` scopes in the dispatch schema |
| WP-002 → WP-005 | events, lease/workspace projection and new action schemas |
| WP-003 → WP-005 | worktree proof, setup detection and in-worktree candidate derivation |
| WP-004 → WP-005 | workspace creation and in-workspace Peer creation |
| WP-001 → WP-005 | `overlaps`/`reaches`/`conforms` |
| WP-005 → WP-006 | leases, workspaces and Peers to close, reclaim and recover |
| WP-002 → WP-007 | projection the status/panel/export read |
| WP-006 → WP-007 | Human close/reclaim actions surfaced by the panel |
| WP-005, WP-006, WP-007 → WP-008 | the complete feature under live test |

Acyclic. WP-001, WP-003 and WP-004 can start in parallel.

## 5. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | The overlap checker says "disjoint" for overlapping scopes, allowing concurrent writers on one path. | Soundness-first rules and the exhaustive oracle test (WP-001); `scope.exceeded` at handoff as a second line of evidence. |
| R-2 | Paseo silently branches from an existing branch, or another plugin rewrites the create request. | Mandatory Git proof after create; a mismatch refuses and closes (WP-003/WP-005); proven live in §9.1. |
| R-3 | Automatic close destroys uncommitted Peer work. | Close only when clean at candidate or base; a discard needs an explicit Lead or Human decision with a reason (WP-006). |
| R-4 | Worktree setup races the first Peer turn. | Refuse repositories with `worktree.setup` until Q-P2-02 closes (WP-003/WP-005). |
| R-5 | A late call from a reclaimed Peer is accepted. | Epoch in the capability hash; `report_stale` test (WP-006). |
| R-6 | The Phase 1 path regresses. | Phase 1 event fixtures and controller tests run unchanged; `lead-workspace` stays the default (WP-002/WP-005). |
| R-7 | Paseo `0.10` changes the workspace API. | The range stays `<0.10.0`; worktree dispatch is refused on unqualified versions. |

## 6. Test Strategy

- **Deterministic** (Vitest, existing layout: one file per area, real temporary `$HOME` and Git repositories, the in-memory fake Paseo):
  - the scope checker with its oracle;
  - schema and replay fixtures;
  - projection and authorization;
  - Git proofs in temporary repositories with real worktrees;
  - controller dispatch, refusals, conformance, close, reclaim, and a crash at every new intent/result boundary;
  - RPC/view.
- **Boundary and package:** the runtime-plugin import boundary and the packed-package tests stay green.
- **Live:** WP-008 on an isolated Paseo `0.9.1` daemon. No test claims model obedience.
- **Coverage:** every new module has direct unit tests; no numeric coverage target is imposed, matching Phase 1.
- **Gate:** `npm run verify` in project order before any WP is declared done.

## 7. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-P2-02 | A supported signal for worktree setup completion. | Maintainer | open — non-blocking; the refusal ships (WP-003/WP-005) |

Q-P2-01, Q-P2-05 (resolved) and Q-P2-03, Q-P2-04 (settled in §2) do not block any work package.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-23 | Repository owner / Bytes | Owner accepted [change-002](runtime-coordination-change-002-phase2-implementation-deltas.md). All exit criteria hold; `feature-done` passed and the plan is Archived. Q-P2-02 stays open and non-blocking in the delta. |
| 2026-09-23 | Bytes | Executed WP-001–WP-008; every bead closed. Live qualification (delta §9.2) and the R3 rehearsal (Technical Design §14) passed on Paseo `0.9.1`, after fixing three recovery defects the live run exposed (2d2841c); `0.9.1` is qualified. Implementation deltas are recorded in [change-002](runtime-coordination-change-002-phase2-implementation-deltas.md), awaiting the repository owner's review; the plan stays Active until then. |
| 2026-09-23 | Bytes | Passed `plan-ready-for-beads` and activated; Phase 2 scope frozen (WP-001–WP-008). |
| 2026-09-23 | Bytes | Created Draft from the Active Phase 2 delta: eight work packages covering the scope checker, contracts/events/projection, Git worktree proofs, the Paseo workspace port, worktree dispatch with collision refusal, close/reclaim/recovery, status/panel/docs, and live qualification with R3 rehearsal. |
