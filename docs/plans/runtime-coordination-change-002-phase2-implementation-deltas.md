# Change Request — Phase 2 implementation deltas

| Field | Value |
|---|---|
| Change ID | `runtime-coordination-change-002` |
| Short name | Phase 2 implementation deltas |
| Original plan | [runtime-coordination-phase2-implementation-plan.md](runtime-coordination-phase2-implementation-plan.md) |
| Status | Review |
| Owner | Repository owner |
| Created | 2026-09-23 |
| Accepted | — |
| Applied | 2026-09-23 |

## 1. Change summary

The frozen Phase 2 plan was executed through WP-001 to WP-007. The implementation found five places
where a settled decision could not be carried out as written, or needed a detail the plan did not
state. None adds a tool, an event type, a role capability or contract prose. They are recorded here
instead of by editing the Active plan.

## 2. Compelling reason

Each item was forced by Paseo `0.9.1` behaviour read from its source, by an existing Phase 1 test the
plan requires to stay unchanged, or by a gap between two plan statements.

## 3. What changed

| # | Before (plan) | After | Reason |
|---|---|---|---|
| 1 | "Recovery reissues the identical create instead of searching by label" (§2, Peer create identities) | Recovery settles an unresolved Peer create by the **exact `agentId` recorded before the call**, and falls back to the Phase 1 label search only for a create recorded without one or an id Paseo does not know. It does not reissue an agent create. | Paseo fingerprints the whole raw create request, including the operator's current model/mode and Lead's `cwd`, which the intent does not carry, so a faithful reissue is not always possible. A reissue would also *create* a Peer that was never created, only to archive it, which contradicts the Phase 1 recovery test the plan keeps unchanged ("a create that never happened is recorded as failed"). The exact id is strictly stronger evidence than the label. Worktree creates are still reissued (delta §7): every field of that request is recorded. |
| 2 | "Every reporting generation … carries its epoch in the server-derived capability hash" (delta P2-D6; plan WP-006) | The capability format is unchanged. The epoch fences in two ways: every generation opened after a reclaim is numbered after any the prior Peer held, so its capability no longer matches the open generation; and a report from any agent in the lease's `priorAgentIds` is refused `report_stale` before anything else is checked. | The capability hash is persisted in `reporting.generation-opened`; changing how it is derived would change a v1 event's meaning. The same fence holds without it. |
| 3 | RPCs `runtime.workspaceClose` and `runtime.leaseReclaim` | `runtime.workspace-close` and `runtime.lease-reclaim` | Match the existing RPC names (`runtime.resolve-ownership`). |
| 4 | Refusal codes listed in WP-005 | Adds `base_unknown` (the base is not a commit of the repository), `isolation_required` (`serialOnly` without worktree isolation) and `isolation_not_writable` (worktree isolation for read-only work). An isolated dispatch does not run the Phase 1 `dispatchPrecondition` on Lead's checkout. | The worktree is cut from the recorded base, so Lead's checkout state is irrelevant to it; the base must still exist. The two input checks reject meaningless combinations before anything is recorded. |
| 5 | The collision rules decided "inside the project queue" | The same rules also run on replay: `lease.reserved` is checked with the §5.3 rules, and a Lead-workspace writer's `agent.create-requested` is refused while any lease is active. `assignment.dispatch-requested` and `ownership.reserved` now refuse only a *Lead-workspace* writer, because the dispatch mode is recorded one event later. | The projection must refuse a ledger that holds two colliding writers, as Phase 1's does for two writers. For a ledger with no lease this is exactly the Phase 1 rule. |

## 4. Impact

No REQ, work package, event type, tool or phase boundary changed. The affected beads (`pr-5wy.2`,
`pr-at7.2`, `pr-at7.4`, `pr-qrj.1`) were closed with these deltas. Technical design and delta text
are unchanged; this record is the pointer.

### Risk delta

Item 1: a Peer create that Paseo completes *after* recovery ran would leave an unprompted, labelled
Peer that the runtime recorded as failed. Phase 1 has the same window; the exact id makes the Peer
identifiable. Paseo's creation service admits requests serially and the plugin's recovery runs after
a restart, so the window is small.

## 5. Out of scope for this delta

Live qualification (WP-008) and any change to the qualified-daemon list.
