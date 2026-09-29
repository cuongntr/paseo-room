# Paseo Room Runtime Coordination — Phase 2 Design Delta: Worktree Concurrency

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [Paseo Room Runtime Coordination PRD](../product/runtime-coordination-prd.md) — Accepted 2026-09-22: G-003, REQ-010, REQ-011, Roadmap row "Phase 2 MVP — Worktree concurrency", Q-011 |
| Related ADRs | N/A — no ADR directory exists. Governing: [Runtime Coordination Technical Design](runtime-coordination.md) (Active; this document is a delta on it and changes nothing it does not name), [design.md](../design.md), [Orchestration Quality Hardening](orchestration-quality-hardening.md) Q-003 |
| Routing decision | Brownfield delta: canonical-contract authority change, new Paseo lifecycle surface (workspaces), persisted-event additions, concurrency. Delta design → repository-owner approval of §3 → Implementation Plan → Beads. Phase 1 design §13 "Deferred to Phase 2 MVP" is the entry gate. |

Paseo facts below are read from the installed `0.9.1` packages and cited by path. `S/` is
`@getpaseo/server/dist/server/` under the global `@getpaseo/cli` install; `C/` and `P/` are
`node_modules/@getpaseo/client/dist/` and `node_modules/@getpaseo/protocol/dist/` in this repository.
Reading source is not qualification: everything a running daemon must confirm is listed in §9, and
only that live run qualifies a line (§8).

## 1. Scope

**In:** PRD REQ-010 (concurrent writable assignments only in distinct Paseo worktree-backed
workspaces, one writer each, never reused while a prior writer may still write) and REQ-011
(declared write-scope and serial-only collision refused before dispatch). Concretely: an
isolation choice on writable dispatch, runtime-requested Paseo worktree workspaces, a writer
lease with an epoch, a canonical scope grammar with a conservative overlap check, scope
conformance evidence at handoff, workspace close and reclaim, and the Lead-contract amendment
that makes any of it legal.

**Out, unchanged from the PRD:** merge, rebase, cherry-pick, conflict resolution, fast-forward
landing, push, branch deletion, merge queues (Lead still integrates by hand in its own
workspace, Phase 1 design §7.3); cross-project or remote coordination; Phase 3 findings/incidents;
any sensor. Phase 2 adds no Peer tool: `PEER_REPORTING_TOOLS` stays `ask`/`handoff`.

**Invariants carried over without change:** two-step dispatch (create without prompt → fresh
snapshot proof → durable binding → `run()`); clean immutable commit handoff (Q-004); release only
on archive plus corroborating live `closed`; Paseo is the only lifecycle control plane; the
runtime never cleans, resets, stashes, deletes a branch or rewrites an operator home.

## 2. Decisions

### P2-D1 — Concurrency is a dispatch mode, not a relaxed limit

A writable dispatch carries `isolation: 'lead-workspace' | 'worktree'`, default
`'lead-workspace'`, which is exactly Phase 1. A `lead-workspace` writer stays exclusive: it
conflicts with every other writer of the project, isolated or not, because Lead integrates in
that workspace. Only `worktree` writers may coexist, and only with each other. A hard cap of
**three** concurrent worktree leases per project (`MAX_WORKTREE_LEASES`) bounds disk and Lead
attention to what the PRD qualifies; raising it is a design change, not configuration.

### P2-D2 — One assignment, one fresh worktree

Each worktree dispatch requests a new Paseo worktree workspace cut from the assignment's exact
`baseCommit`. A worktree is never handed to a second assignment. The only re-entry is
**reclaim** within the same assignment (rework after the Peer died), which bumps the lease
epoch and requires the prior writer's archive to be proven (P2-D6).

### P2-D3 — The runtime chooses identities before the call

Paseo lets the caller choose both ids and the idempotency key for a workspace creation:
`workspaceId` matches `^wks_[a-f0-9]{16}$` and `idempotencyKey` is 1–512 chars
(`P/messages.js:2180-2190`, `WorkspaceCreateRequestSchema`). The creation service persists a
receipt keyed by that key with a request fingerprint and refuses a reused key with a different
request (`*_request_key_conflict`) or a reused id (`*_id_conflict`)
(`S/server/creation/index.js:29-34, 211-216`; receipts are files under `$PASEO_HOME/creations`).
The runtime therefore writes the chosen `workspaceId` and key into the intent event **before**
calling, and recovery reissues the identical request instead of searching by path or title. The
fingerprint covers the whole request, so the intent also records the workspace title it sends —
the gist of the assignment's outcome, which Paseo's sidebar shows above the branch — and a request
recorded before titles were recorded is reissued with the `room <id>` title it was sent with.
Agent creation gains the same treatment (`agentId` uuid and `idempotencyKey`,
`P/messages.js:1385-1410`), which Phase 1 does not yet use.

### P2-D4 — Create through the worktree API, then prove it with Git

Request (`C/index.d.ts:86-89, 141`, `S/server/session.js:4996-5020`):

```ts
paseo.workspaces.create({
  workspaceId, idempotencyKey, title: `room ${assignmentId}`,
  source: { kind: 'worktree', cwd: canonicalRoot, action: 'branch-off',
            refName: baseCommit, branchName: `paseo-room/${assignmentId}`, worktreeSlug },
});
```

`branch-off` uses `refName` as the base (`S/server/resolve-worktree-creation-intent.js:23-29`), and
a full commit id resolves through the final, unqualified `rev-parse --verify` candidate
(`S/utils/worktree.js:1165-1185`). Two source facts make Git verification after creation mandatory,
not optional:

- if the requested branch name already exists, Paseo branches from **that branch**, not from
  `refName`, and may rename the new branch (`S/utils/worktree.js:920-931`);
- another trusted plugin may transform the request through `before('workspace.create')`
  (`S/server/session.js:4950-4960`).

After Paseo returns, the Git port must prove: the directory's `gitCommonDir` equals the project's;
`HEAD` equals `baseCommit` exactly; the tree is clean; the workspace kind is `worktree` and its
directory is not Lead's. The recorded branch is Paseo's resolved name. Any mismatch records
`workspace.create-refused` and closes the workspace without launching a Peer.

### P2-D5 — Repository setup must be observable or absent

Paseo runs `paseo.json` `worktree.setup` **in the background after** `workspaces.create` returns
(`S/server/worktree-session.js:326-394`; commands from `S/utils/paseo-config-file.js:90-95`), and the
plugin's `PaseoApi` exposes no setup-status call (`C/index.d.ts:101-148`). A Peer launched on
creation could therefore race an unfinished setup. Until a supported setup-completion signal is
qualified (Q-P2-02), the runtime reads `paseo.json` at `baseCommit` through Git and **refuses**
worktree dispatch with `worktree_setup_unobservable` when `worktree.setup` is non-empty. It never
runs, skips or rewrites setup itself.

### P2-D6 — Leases fence by epoch; expiry never transfers

A `WriterLeaseV1` (Phase 1 design §4.4) is ownership plus `workspaceId`, `worktreePath`, `branch`,
canonical `scopes`, `serialOnly` and `epoch`. Every reporting generation, gate run and candidate
derived under a lease carries its epoch in the server-derived capability hash, so an old Peer's
late call fails as `report_stale` after reclaim. Reclaim needs both (a) Paseo evidence the prior
agent cannot continue — the Phase 1 archive/`closed` rule — and (b) an explicit `lease_reclaim` by
Lead, or by Human through the panel when (a) is only partially evidenced. Time alone does nothing.

### P2-D7 — Closing a worktree destroys uncommitted work, so it is gated

Paseo's workspace archive archives the workspace's agents, runs `worktree.teardown`, then
`git worktree remove --force` and deletes the directory; it keeps the branch
(`S/server/workspace-archive-service.js:26-60, 176-210`; `S/utils/worktree.js:723-780`). A teardown
failure archives the record but leaves the directory (`workspace-archive-service.js:193-197`).
Therefore:

- a workspace close is requested only after writer release is proven;
- it proceeds automatically only when the worktree is clean and its `HEAD` is the recorded
  candidate or the unchanged base;
- anything else (dirty tree, unrecorded commits) retains the workspace and raises an `owner`
  notice naming `workspace_close` with `discardUncommitted: true` and a reason as the recovery
  action — Lead's decision, never the runtime's;
- `directoryRemoved: false` is recorded as evidence and surfaced as cleanup, not failure.

Branches are never deleted; the candidate commit stays reachable from its branch.

### P2-D8 — Cross-workspace parentage uses the workspace handle

The Phase 1 port calls `agents.create({ cwd, parent })`. With a parent and no explicit workspace,
Paseo places the child in the **caller's** workspace and ignores `cwd`
(`S/server/agent/create-agent/intent.js:18-28`). Phase 2 creates the Peer through
`paseo.workspaces.ref(workspaceId).agents.create({ parent: leadAgentId, … })`: the client sends the
explicit `workspaceId` and `callerAgentId` (`C/index.js:30-47`), placement takes the explicit
workspace, and the parent label is still set from the caller (`intent.js:2-17`). Binding proof
compares the snapshot's `workspaceId` with the lease's, not Lead's. Paseo cascades a parent's
archive to labelled children (`S/server/agent/agent-manager.js:1035-1060`); that cascade does not
archive the worktree, so an archived Lead leaves retained workspaces for P2-D7.

## 3. Canonical Contract Amendment — approved 2026-09-23

**Approved by the repository owner on 2026-09-23 and landed in the same change.** Until the Phase 2
runtime ships, no Peer can meet the exception, and the runtime must refuse `isolation: 'worktree'`
on any daemon that has not passed §9. The amendment
grants one thing: runtime-isolated concurrent writers. It changes no other role's authority, adds
no Peer tool, and leaves Lead-only acceptance and integration untouched.

### 3.1 `src/room/prompts/contract/lead.md` — section `Moving Write Ownership`

Replace the section body with:

> Lead owns decomposition and moving write-scope assignment: give each moving scope
> exactly one owner, with at most one active writable Peer across the project at a time,
> except as runtime-isolated dispatch below permits.
> Lead must not edit a scope concurrently with its writing Peer.
>
> Before transferring write ownership, stop the prior writer and establish a stable
> handoff. Read-only review does not create another writer.
>
> One writable Peer across the whole project is deliberately stricter than one writer per
> moving scope: separate scopes are not proof of separate working trees. No workspace
> protocol relaxes the limit.
>
> The one exception is runtime-isolated dispatch. When the room runtime dispatches a
> writable assignment into its own runtime-created worktree and accepts its declared write
> scope, that Peer may work beside other Peers dispatched the same way. Each has exactly one
> scope and one worktree. A runtime refusal — overlapping scope, serial-only path, shared
> workspace, unproven prior writer — is final for that dispatch: narrow or sequence the work
> rather than work around it. A Peer opened any other way, or a writable Peer in Lead's own
> workspace, still counts against the one-writer limit and excludes every other writer.
> Integrating isolated candidates remains Lead's own work, in Lead's workspace, one at a time.

The existing static assertions in `test/instructions.test.ts` (`at most one active writable Peer
across the project at a time`, `No workspace protocol relaxes the limit`) still hold. New
assertions: the exception names the runtime and worktree, names refusal as final, keeps a
non-runtime Peer inside the limit, and keeps integration with Lead.

### 3.2 `src/room/prompts/contract/shared-authority.md` — `Authority Floor`

`permit more than one writable Peer` → `relax the writable-Peer limit`. The floor must still say a
repository instruction cannot widen concurrency, but it can no longer say "one" once the contract
itself has an exception. The matching string in `test/instructions.test.ts:88` changes with it.

### 3.3 Documents that must move in the same change

- `AGENTS.md`, rule **Runtime coordination is a separate, opt-in plugin**: append "Concurrent
  writable Peers exist only as runtime-isolated worktree dispatch; every other path keeps the
  one-writer limit."
- `docs/design.md` §"No concurrent writable Peers" and `README.md` "One writable Peer per project":
  restate as "one writer per project, except runtime-isolated worktree dispatch (runtime Phase 2)".
- [Orchestration Quality Hardening](orchestration-quality-hardening.md) Q-003: status → "answered
  <approval date> — only runtime-isolated worktree dispatch; baseline rooms unchanged".
- PRD Q-011 → resolved by §5 of this delta; Phase 1 design §7 and §13 point here.

The commit that lands §3 states, per `AGENTS.md`, that it grants Lead concurrent writers under
runtime isolation and removes nothing.

## 4. Data Model and Events

All additions are new event types at `payloadVersion: 1`, or new optional action fields; no v1
payload is edited (`src/runtime-plugin/server/events/schema.ts` header rule) beyond an optional
field, which an older reader ignores and whose absence keeps the older meaning. A Phase 1 plugin that
meets these events refuses the unknown type and pauses the project, which is the intended
fail-closed downgrade (§8).

| Event | Payload | Notes |
|---|---|---|
| `lease.reserved` | `workspaceId`, `branch`, `baseCommit`, `scopes`, `serialOnly`, `epoch: 1` | follows `ownership.reserved`; `workspaceId` is the runtime-chosen `wks_…` |
| `workspace.create-requested` | `intentId`, `workspaceId`, `idempotencyKey`, `baseCommit`, `branchName`, `worktreeSlug`, `title?` | written before the call (P2-D3); `title` since 2026-09-28, absent meaning `room <id>` |
| `workspace.create-succeeded` | `intentId`, `workspaceId`, `worktreePath`, `branch`, `headCommit` | only after P2-D4 Git proof |
| `workspace.create-failed` / `-uncertain` | `intentId`, `reason` | |
| `workspace.create-refused` | `intentId`, `workspaceId`, `reason` | created but failed proof; close follows |
| `lease.reclaimed` | `fromEpoch`, `toEpoch`, `priorAgentId`, `decidedBy: 'lead' \| 'human'`, `reason` | P2-D6 |
| `scope.exceeded` | `candidateCommit`, `paths` | handoff evidence (§5.4) |
| `workspace.close-requested` | `intentId`, `workspaceId`, `discardUncommitted`, `reason?` | P2-D7 |
| `workspace.close-succeeded` | `intentId`, `workspaceId`, `archivedAt`, `directoryRemoved` | |
| `workspace.close-failed` / `-uncertain` | `intentId`, `workspaceId`, `reason` | |

Lead action changes: `assignment_dispatch` gains optional `isolation` and `serialOnly`;
`assignment_create` is unchanged, but for `worktree` dispatch every `writeScope` item must parse
under §5.1 or dispatch refuses `scope_not_canonical` naming the item (free text stays legal for
`lead-workspace`). Two new Lead operations join `LEAD_OPERATIONS`: `workspace_close` and
`lease_reclaim`. The panel gains the Human form of both. Supervisor and Peer surfaces are unchanged.

## 5. Scope Grammar and Collision — resolves Q-011

### 5.1 Grammar

A scope entry is a repository-relative POSIX path of `/`-separated segments. A segment is a
literal or uses only `*` (any run within a segment) and `?` (one character); a whole segment may be
`**` (zero or more segments). Refused: absolute paths, empty, `.` or `..` segments, backslash,
leading `!`, `{}`, `[]`, and anything over the existing string limits
(`src/runtime-plugin/shared/limits.ts`). Normalisation: Unicode NFC, collapse repeated `/`, strip a
trailing `/`. Every entry implicitly ends in `/**`, so `src/api` owns the directory and everything
under it; this over-approximates `src/*.ts` too, which only errs toward refusal. An empty scope list
is `**`, the whole repository.

### 5.2 Overlap

`overlaps(a, b)` returns true when some path could match both. It is decided segment by segment
with memoised recursion: `**` either consumes nothing or one segment of the other side; two
non-`**` segments intersect when:

- literal vs literal → equal after case folding;
- literal vs pattern → the pattern matches the literal (a small `*`/`?` matcher);
- pattern vs pattern → **true unless** their fixed literal prefixes or fixed literal suffixes
  provably differ (`a*` vs `b*`, `*.ts` vs `*.md`).

Comparison is case-folded so a case-insensitive checkout cannot hide an overlap. Every
approximation errs toward `true`: this checks scheduling, not access, and a false refusal costs
one narrower brief while a false pass costs a silent overlap.

### 5.3 Collision at dispatch

Inside the project queue, a `worktree` dispatch is refused when any holds:

- a `lead-workspace` writer's ownership is not `released` (`writer_exclusive`);
- `MAX_WORKTREE_LEASES` non-released leases exist (`lease_cap`);
- any new scope overlaps any scope of a non-released lease (`scope_overlap`, naming both entries);
- with `S` = the union of the new and all non-released leases' `serialOnly`, both the new scope
  and some existing lease reach the same `s ∈ S` (`serial_path`) — a serial-only path admits one
  writer at a time as a whole;
- a non-released lease is `uncertain` (`writer_uncertain`) — uncertainty blocks every new writer.

`serialOnly` comes from Lead, quoted from the repository's protocol where one exists; the runtime
never reads `WORKSPACE_PROTOCOL.md`. A `lead-workspace` dispatch keeps the Phase 1 rule and is also
refused while any worktree lease is not released.

### 5.4 Conformance at handoff

The derived candidate's `changedPaths` are matched against the lease's scopes. Any path outside
them records `scope.exceeded`. Such a candidate cannot be accepted without Phase 1's explicit
override (reason plus `residualRiskAcknowledged`). This is evidence, not containment; the panel and
the tool text say so (REQ-011).

### 5.5 Q-011 recommendation

**Write a small in-repo checker, `src/runtime-plugin/server/domain/scope.ts`, with no dependency.**
Runtime server code may import only `@getpaseo/plugin`, `@getpaseo/plugin/server`, `zod` and
`node:` modules: `test/runtime-plugin-boundary.test.ts:14-16, 59-64` fails any other specifier, and
the installed plugin has no `node_modules`. So `picomatch`, `micromatch` and `minimatch` (present
here only as transitive dev dependencies) cannot ship. They would not solve the problem anyway:
they *match* a path against a pattern, and Phase 2 needs *intersection* of two patterns. `node:path`
`matchesGlob` exists (it matched under Node `v24.18.0` here) but is also only a matcher, and the
package's engine floor is Node 22. Use it in tests as an **oracle**: enumerate every path up to
depth 4 over a small alphabet and assert that the checker never returns `false` where the oracle
finds a common match. That is a soundness property; returning `true` too often is allowed.

## 6. Lifecycle

```text
dispatch(worktree) ─ validate grammar, setup (P2-D5), collision (§5.3) ─ refuse?
  → assignment.dispatch-requested → ownership.reserved → lease.reserved
  → workspace.create-requested → workspaces.create (P2-D3/4) → Git proof
  → workspace.create-succeeded | -refused (→ close) | -failed | -uncertain
  → agent.create-requested (workspace handle, parent = Lead; P2-D8) → binding.published
  → ownership.held → reporting.generation-opened → run.requested
… ask / handoff (candidate derived from the worktree; §5.4) … accept | reject | abandon …
close → archive Peer → ownership.released → workspace close (P2-D7) → workspace.close-*
```

Gates run with `cwd` set to the lease's `worktreePath`, under Phase 1's candidate/clean checks
(`src/runtime-plugin/server/gate.ts:140-151`).

## 7. Recovery

These rows extend Phase 1 design §6; the Phase 1 rows stand.

| Unresolved intent | Recovery evidence | Forbidden |
|---|---|---|
| `workspace.create-requested` | reissue the identical request with the recorded `workspaceId`, key and title; the receipt replays or conflicts (P2-D3). A workspace it returns, or that Paseo lists, is refused and closed (recovery never adopts). It is `workspace.create-failed` only on a conflict, or when the reissue fails with exactly the failure recorded for the first attempt (a replayed receipt) and Paseo lists no such workspace; any other error — a timeout, a create still in flight — leaves it uncertain | adopting a worktree by path, slug or branch name; retrying with a new key; reading a new error as a definite failure |
| Peer create in a lease | Phase 1 rule, with the lease's `workspaceId` in the expected placement | placing the retry in Lead's workspace |
| `workspace.close-requested` | Paseo no longer listing the workspace, plus directory existence (a refused worktree's directory is learned before its close is requested; after a crash in that close it is unknown) | treating elapsed time as closed; deleting the directory or branch itself |
| lease with a dead Peer | Phase 1 archive/`closed` proof, then explicit `lease_reclaim` | reclaim on idle, turn end or timeout |

Restart replays events and reruns only these bounded queries; there is still no background patrol.

## 8. Rollout and Containment

- Gated twice: the §3 amendment landed, and an explicit `isolation: 'worktree'` per dispatch.
  Without both, runtime behaviour is Phase 1 byte for byte. No new setup flag.
- Worktree dispatch is **refused on any daemon below `0.9.1`**, the first release that passed §9
  live (§9.2), and on a prerelease or build-stamped version. There is no upper bound, for dispatch
  or for the plugin (§9.4): a later release is admitted without being read, and nothing refuses it
  automatically. The refusal is a runtime check, not a range change. A maintainer who finds that a
  release breaks a surface dispatch uses bounds it in a paseo-room release, and until the operator
  installs that release a daemon on it is still admitted. Amended 2026-09-29; until then each minor
  needed its own §9 run (§9.4).
- Deselection (Phase 1 design §14) adds one step: no lease is non-released **and** no workspace
  create or close is unresolved before the plugin is unregistered. A retained worktree does not
  block it; its warning counts retained worktrees and left-behind directories apart and names a
  remedy that works without the panel.
- One rule, `worktreeDisposition` (`unresolved`, `active`, `retained`, `leftover`, `gone`), decides
  what a worktree record means on disk for findings, the panel, CLI counts and deselection. A
  left-behind directory is re-checked on disk, so removing it by hand clears its finding.
- Downgrade to a Phase 1 plugin pauses every project holding Phase 2 events (unknown type) and
  preserves them. Restore by reinstalling the Phase 2 plugin; never rewrite events to make a
  downgrade green.
- Whole-room `remove --apply` keeps its destructive contract; its warning also counts retained
  runtime worktrees and left-behind directories, which it does not delete (they are Paseo's and the
  operator's).

## 9. Live Qualification — release blockers

On a real daemon at the worktree floor (§8), with the Claude carrier
installed:

1. **L-1 Authority:** the plugin's IPC client may call `workspace.create.request` and
   `archive_workspace_request`, which require `workspace.manage` (`S/server/authorization/operation-permissions.js:23, 190`).
   The plugin session connects as client type `cli` (`S/server/plugins/plugin-process.js:222-233`);
   its granted permissions were not established from source.
2. **L-2 Create and prove:** branch-off from a raw commit id; an existing-branch collision is
   caught by the Git proof; runtime-chosen `workspaceId` is honoured; the receipt replays after a
   simulated response loss and after daemon restart.
3. **L-3 Cross-workspace parentage:** exact `codex-peer`, `claude-peer` and `pi-peer` created through
   the workspace handle carry `paseo.parent-agent-id` = Lead, the lease's `workspaceId`, no prior
   user message; carrier prompt and reporter both arrive (the Phase 1 design Q-002 remainder).
4. **L-4 Three concurrent writers:** three disjoint scopes complete handoff and acceptance in three
   worktrees; overlap, serial-path, cap, `lead-workspace`-exclusive and uncertain-writer cases refuse
   before any Paseo call.
5. **L-5 Close:** clean close removes the directory and keeps the branch; a dirty worktree is
   retained with the notice; a failing `worktree.teardown` yields `directoryRemoved: false`.
6. **L-6 Restart:** daemon restart with three held leases and one unresolved workspace create
   reconstructs the same view; no duplicate workspace, no reused worktree.
7. **L-7 Setup:** a repository with `worktree.setup` is refused (P2-D5) until Q-P2-02 closes.

### 9.1 Feasibility probe — 2026-09-23

A disposable plugin (`room-phase2-probe`, never installed in a room) ran on an isolated Paseo `0.9.1`
daemon — its own `HOME`/`PASEO_HOME` and port, a three-commit throwaway repository — driving the
plugin-side `PaseoApi` from an `agent.created` handler. It answers the source-unconfirmed items that
could have sent this design back to Draft; it is feasibility evidence, not release qualification.

| Item | Observed | Result |
|---|---|---|
| L-1 authority | `workspaces.create` and `workspaces.archive` succeeded from the plugin's own client, so the plugin session holds `workspace.manage`. | Q-P2-05 resolved: yes |
| L-2 base | Branch-off with `refName` = the root commit id: worktree `HEAD` was that exact commit, branch `paseo-room/probe-asg-1`, common dir the source repository's, tree clean. | pass |
| L-2 identity | The runtime-chosen `wks_…` id was honoured. The identical request under the same key returned the same workspace; the same key with a different title failed `workspace_request_key_conflict`. | pass |
| L-2 restart | The same request and key after `paseo daemon restart` returned the same id and directory; `git worktree list` still showed one worktree for it. | pass |
| L-2 collision | Reusing an existing branch name with a *different* base returned a workspace whose branch was silently renamed to `probe-asg-2` and whose `HEAD` was the **existing branch's** commit, not the requested base. | confirms P2-D4: Git proof is mandatory |
| L-3 placement | `workspaces.ref(id).agents.create({ parent })` placed the child in the worktree workspace (not the parent's), with `cwd` inside the worktree, `paseo.parent-agent-id` = the parent and no user message. | pass (placement only) |
| L-5 close | Archive of a clean worktree removed its directory from `git worktree list` and kept the branch. | pass (clean case only) |

Still open for release: L-3 carrier prompt and reporter arrival on the three exact Peer providers,
L-4, the dirty/teardown-failure halves of L-5, L-6 with held leases, and L-7.

Deterministic tests cover everything else against the fake port, including the §5.5 oracle and a
crash at every new intent/result boundary.

### 9.2 Live qualification — 2026-09-23

Run against the implemented runtime (WP-001–WP-007) on a real Paseo `0.9.1` daemon started from an
isolated home — its own `HOME`/`PASEO_HOME` and port — set up with
`setup --agent codex --agent claude --agent pi --runtime` and a build that listed `0.9.1` as
qualified. Lead actions went through a runtime-created `codex-lead`'s own spool correlation. The
isolated role homes hold no credentials, so every Peer turn fails with a provider `401` (Codex after
about 17 s, Claude and Pi at once); where a handback was needed, the Peer's commit was made in its
worktree and `handoff` sent on the Peer's own correlation and capability inside that window, exactly
as the Phase 1 R3 rehearsal did. Evidence is from the event ledger, `git worktree list` and Paseo's
persisted agent records, never from agent prose. The operator's room and `~/.paseo/config.json`
hashed identically before and after.

| Item | Observed | Result |
|---|---|---|
| Version gate | The plugin read `0.9.1` from its host `@getpaseo/server` package; worktree dispatch ran. The deterministic suite proves an unknown version refuses `worktree_unqualified`. | pass |
| L-2 create and prove | Each dispatch recorded `lease.reserved` → `workspace.create-requested` (runtime `wks_` id, key `ws-<id>-e1`) → `workspace.create-succeeded` after the Git proof; `HEAD` was the exact base and the branch `paseo-room/<id>`. Paseo sanitised the slug (`asg_x` → `asg-x`), which the runtime never relies on. | pass |
| L-3 cross-workspace parentage | `codex-peer`, `claude-peer` and `pi-peer` were each created through the workspace handle: `paseo.parent-agent-id` = Lead, the lease's `workspaceId`, `cwd` inside the worktree, no prior prompt. The `paseo_room` reporter with its correlation arrived on all three; Claude's persisted `systemPrompt` began with the room contract marker (`paseo-room-contract:sha256:9ac233cb…`); Pi's append travels in its provider command. | pass |
| L-4 three writers | `src/api`, `src/web` and `docs` held at once in three worktrees, each handed back; `docs` ran its runtime gate inside the worktree and was accepted, `src/web` accepted. Refused before any event, worktree or agent: `lease_cap` (fourth), `writer_exclusive` (dispatch without isolation), `scope_overlap` (`src`, and `SRC/API/v2` by case folding), `serial_path` (declared by the requester and by the holder), `writer_uncertain` (another lease uncertain). A candidate touching `README.md` outside `tools` recorded `scope.exceeded`, and acceptance required the override. | pass |
| L-5 close | A clean worktree closed on release with `directoryRemoved: true`, branch kept. One with an uncommitted file, and one with a commit no handoff recorded, were retained with a `worktree-retained` notice to Lead; `workspace_close` refused without discard and closed with `discardUncommitted` and a reason. A `paseo.json` `worktree.teardown` of `exit 3` archived the workspace and left the directory: `directoryRemoved: false`. | pass |
| L-6 restart | `paseo daemon restart` with three held leases (and, in an earlier restart, two held plus one unconfirmed worktree create): the assignment/lease/worktree view was identical before and after, `git worktree list` unchanged, no duplicate workspace; the unconfirmed create settled as below. | pass after fixes |
| L-7 setup | A base whose `paseo.json` declares `worktree.setup` refused `worktree_setup_unobservable` with no event; a blank setup string dispatched. | pass |
| Reclaim | `lease_reclaim` refused while Paseo showed the Peer `closed` but not archived; after an archive it moved the lease to epoch 2 and placed a new Peer in the same worktree under Lead; the replaced Peer's late call failed `report_stale`. | pass |

Three defects were found and fixed in the same change (2d2841c), each with a regression test:
Paseo answers `agents.ref(id).refresh()` for a never-stored id with `Agent not found: <id>`, which
made exact-id create recovery abort start-up recovery; Paseo's creation receipt replays a definite
failure as an error, which left an unconfirmed worktree create uncertain for ever (now
`workspace.create-failed` when Paseo also lists no such workspace); and a lease released by a
recovered `agent.create-failed` did not close its clean worktree.

Operational findings: after a daemon restart Paseo does not load a stored Lead until it runs again,
so creating a parented Peer fails `Caller agent … not found` (recorded `agent.create-uncertain`, then
`agent.create-failed` by recovery) — a Lead that is actually working never meets this; and a plugin
reinstalled by setup receives Paseo's handle, and runs start-up recovery, only at the next lifecycle
event, as in Phase 1.

On this evidence `0.9.1` joins `QUALIFIED_WORKTREE_DAEMONS`. Q-P2-02 stays open: repositories that
declare `worktree.setup` are still refused.

### 9.3 Line qualification — 2026-09-28

§9.2 qualified one patch. Paseo published `0.9.0` and `0.9.1` on 2026-09-22, `0.9.2` on 2026-09-24
and `0.10.0-beta.1` on 2026-09-27. A list of exact patches therefore refused worktree dispatch on
the operator's `0.9.2` daemon two days after qualification, although nothing the runtime uses had
changed. Worktree management itself is long established in Paseo: documented since 2026-02-05, and
`worktree-core.js` is byte-identical from `0.8.0` to `0.9.2`. §8 now qualifies a minor line from
its qualified patch, and `QUALIFIED_WORKTREE_DAEMONS` became `QUALIFIED_WORKTREE_LINES`.

The published `0.9.1` and `0.9.2` packages were compared file by file. `#` numbers are entries of
Paseo's `0.9.2` changelog.

| Surface | `0.9.1` → `0.9.2` |
|---|---|
| `@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`: the plugin compiler, the SDK and the wire types | identical but for their version field |
| Worktree creation, archive and recovery: `S/server/worktree-core.js`, `paseo-worktree-service.js`, `worktree-session.js`, `worktree-bootstrap.js`, `resolve-worktree-creation-intent.js`, `workspace-archive-service.js`, `S/server/session/workspace-recovery/`, `S/utils/worktree.js`; creation receipts `S/server/creation/`; plugin lifecycle hooks `S/server/plugins/lifecycle/` | identical |
| `S/server/agent/agent-manager.js` | a history load settles residency before it prepares the config, so an archived agent whose worktree was removed stays readable (#5229); a history replay replaces the committed timeline instead of appending to it (#5286). Creation's working-directory check is unchanged, moved into a helper. |
| `S/server/session/workspace-provisioning/`, `workspace-registry-model.js`, `workspace-reconciliation-service.js`, and the line of `session.js` that wires them | a workspace directory that is gone is an absence, not evidence that a worktree stopped being one; workspaces are not archived while their project root is unreachable (#5227) |
| `S/server/bootstrap.js`, `S/server/plugins/plugin-process.js` | shutdown closes agents, each within 5 s, before it stops plugins (#5253); a provider connection's close runs once |
| `S/server/session/git-mutation/git-mutation-service.js` | a branch Paseo makes with `checkout -b` gets `--no-track` (#5249); runtime worktrees come from `git worktree add`, and the runtime never pushes |
| `S/server/agent/tools/paseo-tools.js` | an agent's own `create_agent` tool checks that a local directory exists (#5322); not a plugin path |
| `S/server/session/owned-subscriptions/` | per-session delivery state no longer outlives a closed session (a leak fix), for every client alike |
| Providers, the file observer, the Git watcher, schedules, hub permissions, web UI | not on a path worktree dispatch uses. Claude gains `providerOptions.extraArgs`, which a `before('agent.create')` hook may set (#5206); the room's hooks set none. |

No change weakens a guarantee the runtime relies on, and two strengthen it: an archived Peer's
history stays readable after its worktree is removed, and an unmounted volume no longer archives
workspaces the runtime holds leases in. This is reading source, not a live run.

The first worktree dispatch on the operator's `0.9.2` daemon followed the same day, from the
paseo-beads Lead with a `claude-peer`, in the operator's own room with real credentials. It ran
through without a defect. Evidence is from the event ledger and Git (times UTC):

| Step | Observed |
|---|---|
| Create and prove | `asg_QsUCN2NpoajT`, seven write scopes: `lease.reserved` at 05:00:36.473, `workspace.create-succeeded` 0.26 s later, after the Git proof — `HEAD` at the exact base `a032639`, branch `paseo-room/asg_QsUCN2NpoajT`, directory `~/.paseo/worktrees/3qildizi/asg-qsucn2npoajt`. |
| Parentage | The Peer was created with the runtime-chosen agent id through the lease's workspace, parented to the Lead, with its `cwd` in the worktree; Paseo accepted its first run 1.2 s after creation. |
| Handback and gate | The Peer handed back after 4.5 min. The runtime gate (`npm run -s typecheck && npm test`) ran in the worktree on candidate `037f0da` and exited 0 in 4.1 s. Every changed path lay inside the lease's scopes: no `scope.exceeded`. |
| Accept and close | The Lead accepted after its own review and a live read-only run. The release closed the clean worktree with `directoryRemoved: true`: `git worktree list` no longer shows it, and the branch is kept. `main` then stood at `037f0da`; the runtime merges nothing, so moving it was the Lead's step. |
| Next dispatch | A minute after the close, `asg_EvdrULDc2gqO` got its own worktree from `037f0da` and handed back 15 min later. |

A later patch is admitted as soon as a daemon runs it, before anyone has read it. What bounds that
risk is that dispatch never takes Paseo's word for a worktree: the Git proof after creation (P2-D4)
refuses and closes a workspace that is not the exact base in a clean checkout of this repository
outside Lead's directory, the Peer's placement is checked before its first prompt, recovery never
adopts a workspace, and close reports `directoryRemoved` from disk. A patch that broke creation or
close would show as refusals, retained worktrees or uncertain leases, not as a Peer writing in the
wrong place. When Paseo ships a release, compare the first two rows with the last one compared; if
either differs, or a change reaches a path dispatch uses, bound it in a paseo-room release. A bound
reaches an operator only with such a release. (Amended by §9.4: there are no lines any more, and the
comparison is a review, not a gate.)

### 9.4 Minor `0.10` — 2026-09-29

Paseo published `0.10.0` and `0.10.1` on 2026-09-28, its fourth and fifth releases in six days
counting from `0.9.0`. Under §8 as it then stood, worktree dispatch needed a §9 run on the new
minor, and the plugin would not load on it at all before its range was widened. The published
`0.9.2`, `0.10.0` and `0.10.1` packages were compared file by file:

| Surface | `0.9.2` → `0.10.1` |
|---|---|
| `@getpaseo/plugin`: the plugin compiler and SDK | identical but for its version field |
| Plugin host `S/server/plugins/`: compiler, lifecycle hooks, plugin process, manifest and its `requirements` check | identical |
| Worktree creation, archive and recovery (`S/server/worktree-core.js`, `paseo-worktree-service.js`, `worktree-session.js`, `workspace-archive-service.js`, `S/server/session/`, `S/server/creation/`) and `S/server/session.js` | identical |
| `@getpaseo/client`, `@getpaseo/protocol`, `S/server/websocket-server.js`, `S/server/auth.js` | the hello may carry a credential, and the daemon writes a local credential file its own CLI reads; a daemon with no password admits every local client as before, and a password sent as a bearer header is still accepted until 2027-03-24 |
| `S/server/agent/agent-manager.js` | an imported session's history is read before the agent is published |
| `S/server/agent/agent-prompt.js`, `S/server/agent/tools/paseo-tools.js` | a caller waiting on a child holds one finish notification, and arming it again replaces it; a background prompt returns once the child's turn has started; a foreground wait that times out notifies on finish instead |
| Claude and Codex providers | a seat's settings, transcripts, prompts and skills are read from the `CLAUDE_CONFIG_DIR`/`CODEX_HOME` of its own launch environment — the role home — instead of the daemon's |
| Pi provider | display adapters for known Pi extensions (subagents, ask-user, todo, `pi-mcp-adapter`) map the tool calls an installed extension makes; they install and load nothing, so the room's Pi closure is unchanged. A `pi-mcp-adapter` call is now titled `<server>.<tool>` |
| OpenCode, web UI, daemon supervisor | not on a room path |

`0.10.0` differs from `0.10.1` only in providers, `agent-manager.js` and `paseo-tools.js`; its plugin
SDK, plugin host and worktree surfaces are the same. No change weakens a guarantee the runtime relies
on.

This was the second time in a week that the worktree gate refused a daemon on which nothing it
depends on had changed (§9.3 was the first), and the plugin range would have refused the whole
runtime on the same reading. Paseo releases faster than each release can be read before the
operator runs it, so the repository owner removed both bounds: worktree dispatch keeps only the
`0.9.1` floor, and the plugins declare only `>=0.8.0` ([runtime design](runtime-coordination.md)
§14). `QUALIFIED_WORKTREE_LINES` became `WORKTREE_PASEO_FLOOR`. The Git proof and the checks listed
above in §9.3 still bound an unread release. This is reading source, not a live run; the first
dispatch on the operator's `0.10` daemon is to be recorded here.


## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-P2-01 | Approve the §3 amendment as worded? | Repository owner | resolved 2026-09-23 — approved as worded and landed |
| Q-P2-02 | Is there a supported way for a plugin to observe worktree setup completion (a status call, or the creation receipt's setup outcome), so P2-D5 can permit `worktree.setup` repositories? | Maintainer | open — non-blocking; the refusal ships first |
| Q-P2-03 | Is three the right `MAX_WORKTREE_LEASES`, and should it vary per project? | Repository owner | proposed: fixed at three for Phase 2 (the PRD's qualification count) |
| Q-P2-04 | Should Phase 1 same-workspace dispatch also adopt runtime-chosen `agentId`/`idempotencyKey` (P2-D3)? | Maintainer | proposed: yes, same change, since it only strengthens create recovery |
| Q-P2-05 | Does the plugin client hold `workspace.manage` (L-1)? | Maintainer | resolved 2026-09-23 — yes; the §9.1 probe created and archived worktree workspaces from the plugin's own client |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-29 | Repository owner / Bytes | §8 and §9.4: worktree dispatch is refused only below `0.9.1` and on a prerelease, with no upper bound, as the plugins now have none. A file-by-file comparison of `0.10.0` and `0.10.1` with `0.9.2` found every worktree surface identical. `QUALIFIED_WORKTREE_LINES` became `WORKTREE_PASEO_FLOOR`. No event, authority or tool change. |
| 2026-09-28 | Repository owner / Bytes | A worktree workspace is titled with the gist of its assignment's outcome instead of `room <id>`: Paseo's sidebar listed several `room asg_…` rows whose work could not be told apart. The branch keeps `paseo-room/<id>`. `workspace.create-requested` gains an optional `title`, which recovery reissues because Paseo's receipt fingerprints the whole request; a request recorded without one is reissued with `room <id>` (P2-D3, §4, §7). No authority or tool change. |
| 2026-09-28 | Bytes | §9.3 records the first live worktree dispatch on the operator's `0.9.2` daemon: create and Git proof, parentage, handback, a gate in the worktree, acceptance and a clean close, then a second dispatch from the new base. No defect; no event, authority or tool change. |
| 2026-09-28 | Repository owner / Bytes | §8 qualifies worktree dispatch per minor line from its live-qualified patch, instead of per exact patch; §9.3 records the `0.9.1` → `0.9.2` comparison that admits `0.9.2`, and how a later patch is bounded out. `QUALIFIED_WORKTREE_DAEMONS` became `QUALIFIED_WORKTREE_LINES`, whose lines carry a `from` patch and an optional `below` bound. No event, authority or tool change. |
| 2026-09-23 | Bytes | After code review (0c56cd8, 226b833, 2db759e): §7 now records a worktree create as failed only on a conflict or a replayed recorded failure, never on a new error; §8 names the single worktree-disposition rule, on-disk re-checks of left-behind directories, and the split retained/leftover counts. No event or contract change. |
| 2026-09-23 | Bytes | Recorded §9.2: L-2 to L-7 and reclaim pass live on an isolated `0.9.1` daemon with `codex-peer`, `claude-peer` and `pi-peer`, after fixing three recovery defects the run exposed; `0.9.1` added to the qualified list. |
| 2026-09-23 | Repository owner / Bytes | Approved the §3 amendment (Q-P2-01) and landed it: `lead.md` Moving Write Ownership, the `shared-authority.md` Authority Floor, their static tests, `AGENTS.md`, `docs/design.md`, `README.md`, orchestration-hardening Q-003 and PRD Q-011. Design Active; the implementation plan may now be drafted. |
| 2026-09-23 | Bytes | Ran the §9.1 feasibility probe on an isolated `0.9.1` daemon: resolved Q-P2-05 (the plugin holds `workspace.manage`), confirmed commit-id branch-off, runtime-chosen ids, key replay across restart and child placement through the workspace handle, and observed the silent existing-branch rename that makes P2-D4's Git proof mandatory. |
| 2026-09-23 | Bytes | Created Draft from Paseo `0.9.1` source: isolation as a dispatch mode, runtime-chosen workspace ids with durable creation receipts, Git proof after branch-off, setup refusal while setup is unobservable, epoch-fenced leases, gated worktree close, cross-workspace parentage through the workspace handle, an in-repo conservative scope checker (Q-011), and the proposed Lead/Authority-Floor amendment awaiting owner approval. |
