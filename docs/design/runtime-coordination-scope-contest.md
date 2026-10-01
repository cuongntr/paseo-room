# Paseo Room Runtime Coordination — Scope Contest Delta: Override Only Where Another Writer Holds the Path

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | Owner decision 2026-10-01 (in session: keep a Lead-declared write scope, but stop requiring an override that marks no risk), with the cmdb ledger 2026-09-24..10-01 as evidence |
| Related ADRs | N/A — no ADR directory exists. Governing: [Phase 2 delta](runtime-coordination-phase2.md) §5.4 "Conformance at handoff", which this delta amends; [Runtime Coordination Technical Design](runtime-coordination.md) D6 (acceptance), §4 (events) |
| Routing decision | See below |

## Routing Decision
- Variant preset: brownfield
- Triggered risks: changed validation step (acceptance of an isolated candidate); changed tool text (`assignment_dispatch`, `assignment_accept`); finding semantics
- Required artifacts/gates: this delta [design-ready] → owner approval of §3 → implementation → `npm run verify` → live check on cmdb
- Execution path: implement directly; the change is one acceptance rule, one finding and two tool texts
- Exceptions: none
- Approved: 2026-10-01 — Repository owner (SC-D1–SC-D3 as worded; Q-SC02 as recommended)

## 1. Problem

Phase 2 §5.4 records `scope.exceeded` for every changed path outside an isolated assignment's
declared scope, and acceptance then requires an override: a reason and `residualRiskAcknowledged`.
The override was meant for a candidate that might collide with another writer. In live use it
marks almost nothing.

Evidence from the cmdb ledger, 2026-09-24..10-01, 119 worktree assignments:

- 43 of the 119 changed paths outside their scope, and all 43 were accepted with the override.
  In that week no override was ever used for a red gate; all 43 were for scope.
- 54 of the 64 Peer `ask` calls asked to widen the scope, nearly all to edit a test, a locale
  file or a route registry that the gate needs. Lead approved them in a median 13 s, and its
  answers often said in advance "I will override the scope check at acceptance".
- Write scopes are mostly file lists: 590 file entries, 322 globs and 7 directories. The more
  exact the list, the more often a gate-required file falls outside it.
- Replayed at each acceptance, **40 of the 43 overrides concerned paths that no other live writer
  held or had changed**. The 3 others touched files another open assignment held or had changed: a
  migration test, `apps/api/package.json`, and a set of web files including `apps/web/src/api.ts`.
  Lead had flagged the first by hand ("that tree is another Peer's scope"). Those are the cases the override exists for, and today
  they look exactly like the 40 that are not.

A check that fires on a third of assignments and is always answered the same way has become a
form, and it hides the few cases that matter.

## 2. Goal and non-goals

Goal: the override marks a real contest between writers, and nothing else.

Non-goals:

- Peer gains no authority. A writable Peer still owns only its scope and still asks Lead before
  writing outside it; its contract does not change.
- No new tool, field or event type. No change to dispatch-time collision (§5.3), which stays as
  conservative as it is.
- The runtime still contains nothing: a scope prevents collisions between writers the runtime
  knows of; it never contains a Peer.

## 3. Decisions — require owner approval

### SC-D1 — A path outside the scope is contested or uncontested, decided at acceptance

At `assignment_accept` of an isolated candidate with `scope.exceeded`, the runtime computes, inside
the project queue, the set of **contested** outside paths: those that

- fall in a scope or a serial-only path of another non-released lease of the project; or
- appear in the latest candidate's `changedPaths` of another assignment of the project that is not
  yet decided.

The comparison uses the §5.2 overlap rules, case-folded, erring toward contested.

Acceptance requires the existing override only when the contested set is not empty, and the refusal
names those paths and the assignments that hold them. An uncontested outside path needs no
override. A red gate still always needs one.

Deciding at acceptance rather than at handoff matters: leases are reserved and released between
the two, and what counts is who else is writing when Lead takes the candidate.

### SC-D2 — Evidence stays complete

`scope.exceeded` is recorded exactly as today, for every outside path. The handback notice and
`assignment_status` keep listing all of them, so Lead still sees what the Peer touched. The
`scope-exceeded` finding is raised only while a contested path exists; an uncontested overrun is
shown, not counted against project health.

### SC-D3 — Tool text

- `assignment_dispatch` adds: "Declare scope by directory with its tests where you can; a path
  outside it that no other writer holds or has changed needs no override at acceptance."
- `assignment_accept` changes "changed paths outside an isolated assignment's write scope, needs an
  override" to "changed paths outside an isolated assignment's write scope that another writer holds
  or has changed, needs an override".

### What this grants and removes

It grants no seat anything. It removes one step: the override for an outside path no other writer
holds. It adds a check the runtime did not make: a path another open assignment changed outside
its own scope now counts as contested, where today two such overruns of the same file both pass
with the same rubber-stamp override.

## 4. Data

No new event or field. The contested set is derived from events the ledger already holds:
`lease.reserved`, `ownership.released`, `report.accepted` candidates and decisions. An older plugin
reading a newer ledger sees nothing different.

## 5. Testing

- An uncontested overrun is accepted without an override; the finding is not raised.
- A path inside another non-released lease's scope, or a serial-only path, still needs the
  override, and the refusal names the holder.
- A path changed by another open assignment's latest candidate, though outside its scope too,
  needs the override.
- A lease released between handoff and acceptance no longer contests.
- A red gate still needs the override whatever the scope.
- The replay above, kept as a fixture: 40 accepted without override, 3 refused.

## 6. Success measures

Re-measured a week after release from the ledger: overrides on isolated assignments fall from 43 of
119 to the contested cases alone, and every pair of concurrent candidates that changed the same file
reaches acceptance with a refusal naming it.

## 7. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-SC01 | Approve SC-D1–SC-D3 as worded? | Repository owner | resolved 2026-10-01 — approved |
| Q-SC02 | Should a decided but not yet integrated candidate also contest? The runtime cannot see integration, so this delta leaves it out, and Lead integrates one at a time. | Repository owner | resolved 2026-10-01 — left out, as recommended |

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-10-01 | Repository owner / Bytes | Approved and implemented: `scopeContest` in the domain state, used at acceptance and for the finding; both tool texts changed. |
| 2026-10-01 | Bytes | Created from the cmdb ledger replay: 40 of 43 scope overrides marked no contest, 3 marked a real one. Proposed: the override only for contested paths, decided at acceptance; evidence and dispatch-time collision unchanged. |
