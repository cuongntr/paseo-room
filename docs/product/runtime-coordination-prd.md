# Paseo Room Runtime Coordination — PRD

| Field | Value |
|---|---|
| Status | Accepted |
| Owner | Repository owner |
| Created | 2026-09-21 |
| Related product PRDs | [Historical Paseo Room PRD](paseo-room-prd.md); [Role Contract Maintainability and Paseo Runtime Guard PRD](role-contract-and-plugin-prd.md) |
| Routing decision | Brownfield; materially new runtime product surface, trusted-plugin boundary, persisted state contract, multi-session handoff, and worktree concurrency; PRD → Technical Design → Implementation Plan → Beads; proposed 2026-09-21 by Bytes and accepted 2026-09-22 by the repository owner |

> **Scope relationship.** This is a supplemental product proposal, not a replacement for the
> accepted role-home and contract product. It broadens the earlier conditional
> companion-plugin track from health visibility into opt-in runtime coordination. It does not
> supersede the required Claude contract carrier, change the three roles, or authorize
> implementation by itself: the linked design must reach Active and the open blockers must close first.

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** materially new product outcomes and operator journeys; trusted unsandboxed
  plugin code; a public assignment/tool contract; persistent local state; agent authorization and
  role boundaries; multi-session handoff; worktree concurrency; phased rollout with weak rollback.
- **Required artifacts/gates:** supplemental PRD (`prd-ready`), Technical Design
  (`design-ready`), Implementation Plan (`plan-ready-for-beads`), and standard feature closure
  (`feature-done`).
- **Execution path:** plan → converter after the PRD is accepted and the design is Active.
- **Exceptions:** none.
- **Decided:** proposed 2026-09-21 by Bytes; accepted 2026-09-22 by the repository owner without amendment.
- **Supersedes:** on this acceptance it narrows and expands only the
  optional runtime-plugin portions of `role-contract-and-plugin-prd.md`; the Claude carrier delta
  remains intact.

## 1. Context

`paseo-room` reliably creates isolated Supervisor, Lead, and Peer role homes, closes known native
multi-agent paths, registers exact Paseo providers and profiles, and detects managed-state drift.
Once a room starts working, however, coordination is carried mostly by model instructions and the
Paseo timeline. The product cannot answer several ordinary operational questions from durable,
structured evidence:

- Which exact assignment does a Peer own, and what candidate did it hand back?
- Was the repository's named verification gate run against that same candidate?
- Is Lead accepting the candidate it inspected, or a workspace that moved afterward?
- Which writable workspace belongs to which active Peer?
- After a daemon or plugin restart, which handoff, question, notification, or cleanup still needs
  attention?
- Can two independent assignments run in parallel without sharing one checkout?

The current conservative answer is one writable Peer per project. That is safe relative to the
room's present evidence, but it limits throughput and still leaves handoff and acceptance as prose
rather than durable product state.

Paseo 0.8 now exposes plugin lifecycle hooks, typed RPC, client panels, agent timelines, and native
worktree-backed workspaces. A runtime layer can use those facilities without moving setup,
credentials, provider policy, or recovery out of the existing CLI. The opportunity is not to build
a second issue tracker or an autonomous manager. It is to make the room's existing authority model
observable and mechanically reliable at the points where evidence, ownership, and lifecycle cross
session boundaries.

## 2. Product Principles

1. **The CLI remains the durable floor.** Setup, verify, auth, remove, role homes, provider pins,
   prompt carriers, and credential isolation continue to work without runtime coordination.
2. **Runtime coordination is explicit opt-in.** Enabling trusted unsandboxed plugin code remains an
   operator decision; `paseo-room` never sets `pluginsEnabled`.
3. **Record evidence; do not decide the work.** The runtime may validate lifecycle, ownership,
   candidate identity, and gate provenance. Lead still owns technical acceptance and Human retains
   override authority.
4. **Assignments are not a backlog.** The product tracks only active delegated outcomes and their
   handoff. Priority, roadmap, issue hierarchy, and portfolio state stay in the operator's existing
   project system.
5. **No repository policy is invented.** The runtime neither creates a default workflow protocol nor
   writes `WORKSPACE_PROTOCOL.md`. Lead remains the standing reader and supplies assignment-specific
   constraints.
6. **No hidden second control plane.** Paseo remains the sole owner of agent, session, workspace,
   parentage, follow-up, and timeline lifecycle.
7. **No security theater.** Role policy, assignment-scoped reporting tools, write-set checks, and
   worktree placement are capability and collision controls, not an operating-system sandbox.
8. **Deterministic mechanisms precede model judgement.** Runtime health, authority routing and
   mechanical findings ship before any optional model-based sensor is considered. Code always owns
   audience, lifecycle and safety decisions; a sensor may rank only explicitly eligible attention
   signals and can never suppress a mandatory notification.

## 3. Goals and Success Evidence

### G-001 — Reproducible assignment lifecycle

Lead can create one bounded assignment, dispatch it to one fresh Peer, receive an attributable typed
handoff action tied to a stable candidate, record verification evidence, and explicitly accept,
reject, or request rework.

**Success evidence:** an end-to-end acceptance test demonstrates the lifecycle from assignment
creation through acceptance; every transition is attributable to the authorized role and replayable
from durable state after plugin reload.

### G-002 — Honest evidence and acceptance

The product distinguishes agent completion, candidate identity, gate result, review evidence, and
Lead acceptance rather than collapsing them into “done.”

**Success evidence:** acceptance is refused when no stable candidate can be derived or when the
runtime-derived candidate moves after handoff. A writable handoff whose named gate was not run is
recorded as blocked, not as a candidate. A red gate remains attributable evidence that Lead may accept
only with an explicit technical reason; neither a Peer report nor a green runtime rerun becomes acceptance.

### G-003 — Safe worktree-backed concurrency

Independent writable assignments may run concurrently only in separate Paseo worktree-backed
workspaces with non-overlapping declared write scopes and explicit ownership. This Phase 2 goal
requires a separately reviewed amendment to the canonical Lead contract, which currently forbids
concurrent writable Peers even in isolated worktrees.

**Success evidence:** three writable Peers can work concurrently from one source repository in three
distinct worktrees; the product refuses shared-workspace writers, overlapping declared scopes, and
reuse of a worktree whose prior writer is not confirmed stopped.

### G-004 — Restart-safe operations

A daemon or plugin restart does not erase assignment ownership, handoff, gate evidence, pending
notification, or cleanup intent.

**Success evidence:** fault-injection tests restart after each external-side-effect boundary and
reconstruct the same authoritative view without duplicating assignments or silently marking an
uncertain action complete.

### G-005 — Useful operational visibility

Operator, Supervisor, and Lead can see room runtime health and active work at the level their
authority permits, with every condition labeled as enforced, detected, procedural, or unverifiable.

**Success evidence:** the Paseo panel shows projects, current Lead, assignments, active writers,
questions, candidate/gate state, pending delivery, plugin health, and recovery actions without
exposing Peer-visible room topology.

### G-006 — Baseline independence

Operators who do not enable runtime coordination retain the current supported product unchanged.

**Success evidence:** the existing `npm run verify` suite and packed-package tests pass with runtime
coordination omitted; Codex-only and Pi-only rooms do not acquire a plugin dependency unless the
operator opts in.

### G-007 — Selective, authority-correct attention

Normal assignment lifecycle remains visible without turning every event into a Supervisor message.
Deterministic policy routes assignment-local action to Lead, runtime/configuration faults to the
operator, and ownership, unavailable-Lead, systemic, or Human-owned issues to Supervisor/Human.
After deterministic findings and feedback exist, a separately approved optional sensor may rank only
semantic attention candidates for record, digest, or notification.

**Success evidence:** recipient-matrix tests cover every event class; mandatory pages bypass the
sensor; duplicate attention is folded into one incident; Supervisor feedback can mark an incident
`useful`, `noise`, or `unknown`; disabling or losing the sensor changes no lifecycle state and drops
no mandatory notification.

## 4. Out of Scope

- Replacing Paseo's daemon, workspace model, worktree implementation, providers, timeline, or app.
- Creating a fourth standing role or a dedicated Reviewer profile. Review remains a fresh read-only
  Peer assignment.
- Building an issue tracker, planning graph, priority queue, roadmap, sprint, or portfolio manager.
- Automatically choosing architecture, accepting a candidate, merging branches, pushing, deploying,
  or overriding a red gate.
- Writing a default repository workflow, modifying `WORKSPACE_PROTOCOL.md`, or storing room runtime
  state in the project repository.
- Sharing credentials or mutable agent state between seats.
- Claiming filesystem containment for Pi, shell commands, or any process running as the operator.
- Cross-machine or multi-user coordination, remote leases, hosted control planes, or server auth.
- Model-based quality scoring or paid sensor calls in Phase 1, Phase 2, or the deterministic Phase 3
  guardrails. Any later sensor is separately approved, explicit opt-in, advisory, and non-authoritative.
- Reintroducing installer journals, rollback, ownership manifests, inode locks, or recursive
  reconciliation outside the existing managed-entry rules.

## 5. Affected Actors

- **Personal room operator:** wants a room that is simple to install but can later show what is
  running, what is waiting, and how to recover without reading every timeline.
- **Human owner:** retains intent, risk, cost, external-effect, and override decisions and needs
  trustworthy evidence rather than autonomous product decisions.
- **Supervisor:** observes workflow health and routes Human intent while remaining outside technical
  decomposition and acceptance; receives unsolicited attention only for authority, ownership,
  unavailable-Lead, systemic, or Human-boundary conditions—not ordinary assignment events.
- **Lead:** owns one project, creates bounded assignments, controls write ownership, evaluates
  handoffs and gates, and makes technical acceptance decisions.
- **Peer:** receives one complete brief, exercises independent judgement, and may call only the
  assignment-scoped `ask` and `handoff` reporting tools proposed here. They expose no room topology,
  recipient, acceptance, or lifecycle operation; all built-in Paseo tools remain absent.
- **Maintainer:** must evolve a version-bounded plugin, state schema, and adapter behavior without
  weakening the CLI floor or creating a second prompt source.

## 6. Operational Journeys

### Enable runtime coordination

The operator runs setup with an explicit runtime option. Dry-run names the trusted plugin, its
unresolved-or-declared version range, exact room providers and adapter qualification evidence, files
under the room home, and daemon registration. It does not add a runtime model selector or override the
Human/operator-owned provider configuration. Lead may choose an eligible exact Peer provider under
its existing authority but cannot name, change, waive or substitute that provider's model. If Paseo
plugins are disabled, setup refuses and explains the trust boundary without changing the setting.
After apply, verify proves both the baseline room and runtime plugin registration; the marker records
the opt-in.

Runtime support is qualified at the exact room-adapter path. The model observed on each assignment is
recorded as provenance, not used as a runtime allowlist or substituted automatically. If Phase 0 finds
a model-specific tool-delivery failure that server validation cannot safely contain, Q-003 must return
the design to Review; the runtime must not infer an allowlist, selector, substitution or narrower model
policy.

### Delegate and accept one assignment

Lead creates a bounded assignment containing its outcome, work kind, mode, scope, exclusions,
invariants, evidence, exact gate command when required, and expected handoff. Before writable
dispatch, the runtime proves a clean workspace at the assignment's exact base and reserves writer
ownership independently of assignment state. It creates a fresh eligible Peer as Lead's child with an
assignment-scoped reporting bridge but no prompt, then refreshes and proves the exact provider,
observed model, workspace, reserved `paseo.parent-agent-id`, idle/no-active-turn state and absence of
any prior user message. Only after the binding and held ownership are durably recorded does the
controller open one reporting generation, persist the `run()` intent, project `active`, publish the
bridge capability and invoke the separate `run()` with the complete brief as the first turn.

Peer may call only `ask` or `handoff`. The bridge supplies attribution and the current generation; the
Peer supplies no project, assignment, agent, parent, recipient, candidate, or lifecycle identifier. A
valid call is durably recorded before its receipt is returned. Identical retries return that receipt;
a conflicting or stale call fails without a state transition. A provider may require an explicit tool
permission before the call reaches the bridge, so a seat awaiting that decision is reported as
awaiting permission rather than as a missing report. Final prose is diagnostic only and a
turn ending without a valid report becomes `report-missing`, never success. For writable work the Peer
must report the named gate after its last write; an unrun gate cannot produce a candidate. Runtime
derives the actual candidate and live facts from Git/Paseo, may run an explicitly requested independent
gate rerun that never substitutes for Peer verification, and leaves technical acceptance to Lead.
Handoff and acceptance do not release writer ownership; only confirmed agent archive/stop does.

### Run independent work in parallel

After the separately approved Phase 2 contract amendment, Lead declares non-overlapping write scopes
for independent assignments. The runtime creates a Paseo worktree-backed workspace from an exact
base for each writable assignment, then starts one writer in
each. If scopes overlap, a workspace is shared, setup fails, or ownership is uncertain, dispatch is
refused before another writer starts. Completed branches remain available for Lead to inspect and
integrate; the runtime does not merge them automatically.

### Recover after interruption

The plugin or daemon restarts while an agent is starting, a reporting receipt or notification is being
delivered, a gate is running, or a workspace is being archived. On startup the runtime replays durable
events, queries Paseo for unresolved external state, and marks each intent completed, failed, or
uncertain. It replays an accepted report receipt only from the durable event bound to its captured
generation and never turns “unknown” into success. Lead or Human sees the bounded recovery action.

### Degrade or remove safely

If the runtime plugin is failed or disabled, baseline role homes and provider restrictions continue
to work. New runtime dispatch is unavailable and active state is shown as degraded after recovery.
Runtime deselection refuses while assignments or writer ownership remain active/uncertain. Whole-room
`remove --apply` retains its existing destructive contract: it reports active/uncertain runtime state
and strongly recommends export, but after explicit confirmation deletes the room home, credentials,
and runtime history rather than creating an undeletable room.

## 7. Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Runtime coordination is an explicit, remembered setup choice implemented by a separately identified room-owned plugin. | P1 | Default setup creates no runtime plugin; explicit dry-run is mutation-free; apply installs only from the expected room-owned path; verify fails on missing, disabled, failed, incompatible, or foreign-path registration. |
| REQ-002 | Preserve the existing CLI and generated room as the enforcement and recovery floor. | P1 | With runtime omitted or disabled, setup/verify/auth/remove, role-home isolation, prompt delivery, provider pins, native multi-agent closures, and Peer `paseoTools.enabled: false` retain their documented behavior. |
| REQ-003 | Recognize runtime seats only from exact generated provider identity and live Paseo evidence. | P1 | Display names, titles, cwd, or user-supplied labels alone never establish role membership; an unrecognized provider cannot call runtime operations; ambiguous or duplicate Lead ownership pauses new dispatch and escalates instead of guessing. |
| REQ-004 | Represent each delegated outcome as a typed assignment with one owner and explicit authority fields. | P1 | Creation rejects an empty outcome, unspecified mode/work kind, missing scope or exclusions, absent expected handoff, or missing required verification command; unknown fields and invalid transitions are refused with actionable errors. |
| REQ-005 | Give Peer one assignment-scoped reporting capability and no control-plane authority. | P1 | An exact runtime-managed Peer receives one MCP server exposing only strict `ask` and `handoff` schemas with unknown fields rejected server-side. Neither schema accepts room, project, assignment, agent, parent, recipient, candidate, or lifecycle identifiers. The bridge derives caller, assignment and reporting generation from its runtime binding; valid reports are claims and Git, gate, workspace and Paseo facts are derived independently. Only a server-validated action durably persisted before success is authoritative. Duplicate-identical calls return one durable receipt; conflicting, stale, malformed, unauthorized, wrong-kind and failed-precondition calls cause no transition or generation consumption. Final prose, fenced JSON and turn completion never become a report. Peer cannot list or address seats, manage agents/workspaces, message another Peer, accept/reject work, release ownership, or invoke any other runtime or built-in Paseo operation. |
| REQ-006 | Persist authoritative runtime changes as immutable, atomic, replayable events under the room home. | P1 | Every event carries an envelope version, event type, and payload-version discriminator from the first release. Killing the plugin during any write yields either the complete prior state or one complete new event; malformed/unknown types or payload versions stop that project's runtime with diagnostics and are never treated as empty state. |
| REQ-007 | Use event-driven Paseo lifecycle and durable delivery intent instead of status polling loops. | P1 | Agent creation, turn completion, reporting calls, errors, permission requests, archive, and plugin reload trigger updates; handlers treat lifecycle events as notifications and corroborate external state through fresh reads, never as pre-turn barriers. Every delivered notice has a stable ID and at-least-once semantics. Uncertain prompt delivery or report capture remains visible and blocks a later reporting generation; only an identical durably accepted report action replays its receipt. |
| REQ-008 | Bind writer transfer, handoff and acceptance to stable Git evidence. | P1 | Every runtime-managed assignment targets a Git repository. Writable dispatch requires a clean workspace at the exact base commit and reserves writer ownership; complete writable handoff requires the named Peer gate after the last write plus an immutable commit in that workspace. Runtime derives the candidate and changed paths; read-only completion is bound to the exact commit runtime observes. Acceptance records that candidate and is refused after movement. Handoff, idle, acceptance or rejection does not release writer ownership; confirmed Paseo archive/stop does. |
| REQ-009 | Capture gate provenance without making the gate the acceptance authority. | P1 | Peer verification records the exact named command and faithful pass/fail result; `not-run` produces no writable candidate. An explicitly configured runtime rerun records assignment, candidate, exact command, shell contract, sanitized environment class, cwd/workspace, start/end, exit or signal/timeout, output digest and bounded owner-only tail. Lead may accept red evidence only with an explicit reason; a pass is never acceptance and the runtime rerun never substitutes for Peer verification. |
| REQ-010 | Provision concurrent writable assignments only through distinct Paseo worktree-backed workspaces. | P1 | No two active writable assignments share a workspace or worktree; one assignment has one writer; native Paseo setup/teardown remains authoritative; a worktree is not reused while its previous agent may still write. |
| REQ-011 | Detect declared write-scope collisions before dispatch. | P1 | Canonical path-prefix/glob comparison rejects overlapping active writable scopes and repository-declared serial-only paths; empty/unknown scope is treated as the whole repository; the UI states that this is collision prevention, not shell containment. |
| REQ-012 | Recover unresolved actions conservatively after restart. | P1 | For create/send/gate/archive intents lacking a terminal event, recovery queries live Paseo or process evidence. Reporting-call recovery replays only a durable accepted-action receipt bound to its captured generation. It records success only when identity matches, otherwise records failure or uncertainty and blocks unsafe continuation. Agent archive must be proven at the Paseo control-plane level before writer ownership is released; arbitrary same-user subprocess containment is never claimed. |
| REQ-013 | Provide a Paseo operations panel and machine-readable runtime status. | P1 | The panel and status contract expose the same derived view with role-filtered data; unchanged views have stable revisions; all degraded and pending states name a recovery action; no secret or credential value is returned. |
| REQ-014 | Surface deterministic operational findings and route attention with provenance. | P2 | Duplicate Lead, missing/changed candidate, stale writer, overlapping scope, unrun gate, failed delivery, malformed call, and drifted runtime manifest each link to source events. Findings and attention cover every observed room seat — Supervisor, Lead and Peer agents Paseo reports, not only runtime assignment events. A typed recipient matrix classifies each as record, panel, Lead-now, Supervisor-digest/now, operator-now, or Human-required; the Supervisor recipient is the project's own Supervisor; assignment-local events do not notify Supervisor by default; findings never reach the Peer they concern or become automatic technical instructions. |
| REQ-015 | Make disablement, upgrade, export, and removal explicit and safe. | P1 | Plugin failure is visible; runtime state is preserve-only across setup/update; runtime deselection refuses active or uncertain work; export excludes gate-output attachments by default and reports its redaction limits; explicit whole-room `remove --apply` warns on active/uncertain runtime state but retains the existing destructive deletion contract; ordinary setup never silently resets history. |
| REQ-016 | Version runtime contracts and fail closed on unsupported state. | P1 | Plugin manifest, generated room manifest, RPC/bridge/Peer-report schemas, event envelope, every event payload, and derived-view schema each have explicit discriminators; additive versions remain readable; unsupported breaking versions stop affected runtime state and provide export/recovery guidance. |
| REQ-017 | Keep repository policy and runtime state separate. | P1 | The CLI and plugin write runtime metadata only under the room home; neither creates a repository protocol or hidden default; worktree source changes come only from the assigned agent or an explicit gate command. |
| REQ-018 | Preserve the three-role authority model in every operation. | P1 | Human controls enablement and overrides; Supervisor observes/routes but cannot dispatch or accept; Lead dispatches/reworks/accepts; Peer cannot self-accept; tests reject every cross-role operation. |
| REQ-019 | Coexist safely with the required Claude contract carrier. | P1 | Runtime and carrier use distinct plugin IDs and directories; either installation order preserves both hook mutations; runtime failure cannot remove or rewrite Claude contract assets; Claude baseline verification remains independently actionable. |
| REQ-020 | Use Paseo-native workspaces and lifecycle rather than a parallel agent runner. | P1 | Every managed agent and worktree is visible in Paseo with native parentage and workspace identity; the runtime never launches a vendor agent process directly or maintains a second process-lifecycle ledger. |
| REQ-021 | Prevent notification volume from becoming a second workflow. | P2 | Mandatory authority/safety notifications bypass filtering; attention incidents deduplicate by subject and kind, keep counts and evidence, respect a budget only for non-urgent attention, and accept `useful`, `noise`, or `unknown` feedback without exposing model scores in the notification. No runtime delivery interrupts a turn or clears a pending permission; non-mandatory letters wait until the recipient is idle. |
| REQ-022 | Offer model-assisted attention ranking only as a later optional sensor. | P3 | Once the deterministic observer ships, a separately approved sensor may assess only declared semantic-attention questions in shadow mode before assisting. Operator consent is given in the plugin's Settings, and the endpoint is configurable, including a self-hosted one. It is default-off, version-pinned, externally networked only after explicit operator consent, never chooses authority/audience/lifecycle, never suppresses mandatory pages, fails back to deterministic behavior, and stores attributable question/model versions and probabilities for calibration. |
| REQ-023 | Let one Supervisor supervise several projects. | P2 | Each observed project has at most one Supervisor: the Human's explicit assignment, otherwise the Supervisor that parents the project Lead; Supervisor letters and `message_lead` reach only projects in that Supervisor's portfolio; a project without a Supervisor surfaces its signals to the operator. |
| REQ-024 | Start room seats deliberately from the panel. | P2 | Human can start a Supervisor in an existing non-Git directory and a project Lead under a chosen Supervisor; project start runs a preflight (Git identity with a commit, workspace protocol present or not, no live Lead already owning the project) and sends a fixed kickoff naming project, Supervisor and the Human's directive verbatim. Human can also start a Lead for an observed project that has none from that project's own screen ([seat context delta](../design/runtime-coordination-seat-context.md) §12). |
| REQ-025 | Keep Supervisor informed of momentum without Human prompting. | P2 | A Lead turn in the portfolio that Paseo did not already report to the Supervisor, a Peer result its Lead left unread, a waiting permission, repeated turn failure and a Lead archived with running work each reach the Supervisor as a deterministic letter or digest line; the measure is Human nudges after an unreported Lead turn, near zero. |
| REQ-026 | Show each seat's context use. | P2 | Each live room seat's used and maximum context and its last compaction are visible to Human; a Lead past its rotate mark is reported once per crossing to the panel and, as a fact line, to its Supervisor ([seat context delta](../design/runtime-coordination-seat-context.md) K-D1, K-D6). |
| REQ-027 | Let Human set a context budget per role. | P2 | Human sets rotate and compact marks per role in percent of the seat's model window; the room enforces the compact mark where the agent supports it (Claude, at session open) and says where it does not ([seat context delta](../design/runtime-coordination-seat-context.md) K-D2, K-D3). |
| REQ-028 | Let Human replace a project Lead with a briefed successor. | P2 | Only at a quiet point (Lead idle, no open assignment, no running descendant, no pending notice), Human asks the Lead for a handoff, reviews it, and the room archives the Lead and starts a successor under the same Supervisor with the handoff; a failure never leaves two Leads or a project without a way to finish ([seat context delta](../design/runtime-coordination-seat-context.md) K-D5). |

## 8. Non-Functional Requirements

- **Security:** Treat the runtime plugin as trusted unsandboxed code. Never read credential contents,
  store tokens in events, expose secrets through RPC, or claim shell containment. Capability tokens
  are scoped routing evidence, not protection from another process running as the same OS user.
  Security-boundary changes require focused negative tests and repository-owner review.
- **Reliability:** Authoritative local state is append-only and atomic per event; derived views are
  disposable and rebuildable. Unknown, malformed, conflicting, or partially observed external state
  fails closed for the affected project, not as an empty project. A gate runs with closed stdin, an
  explicit POSIX-shell contract, a sanitized environment that contains no plugin/Paseo secret, and
  bounded process-group termination; unresolved children or results remain uncertain.
- **Availability:** Baseline CLI operations remain available when the runtime plugin is stopped.
  Runtime inspection works from local state while Paseo is temporarily unreachable and labels live
  facts stale. New dispatch and recovery actions requiring Paseo fail clearly rather than hang.
- **Performance:** For 10,000 project events, cold replay and panel status should complete within five
  seconds on a supported development machine; an unchanged status RPC should normally complete
  within 250 ms; event persistence must not wait on model or network calls.
- **Privacy:** No telemetry or external sensor is enabled by default. Runtime records stay local.
  Export is explicit, excludes gate-output attachments by default, and states that arbitrary command
  output cannot be proven secret-free. A later sensor sends only the bounded, masked, event-derived
  state its declared questions need; source files, raw timelines, environment, credentials, and gate
  output are excluded. No sensor key is written to the room marker or event log.
- **Compatibility:** Runtime targets the preview Paseo range `>=0.8.0 <0.10.0` resolved under Q-005
  and widened for Paseo `0.9.1` on 2026-09-23; `0.8.0` and `0.9.1` are the live-tested points. Q-003a qualified reporting-tool delivery and invocation on
  every exact Codex, Claude and Pi room-provider path, and Q-003b carries the server's refusal,
  idempotency and recovery semantics into Phase 1 exit criteria; generic adapters and final-message
  behavior are not substitutes. A reporting call may require an explicit provider tool permission, as
  Claude did and Codex and Pi did not. Node 22+ on macOS/Linux remains the target. The daemon and
  connected app must each
  satisfy client/server plugin requirements for the panel; server operation remains legible when the
  client contribution is unavailable.
- **Maintainability:** Role authority remains canonical in Markdown contract assets. Runtime schemas
  and capability maps are typed data; no role authority prose is duplicated in plugin code.
- **Observability:** Logs and UI distinguish enforcement, post-hoc detection, procedural obligation,
  and unverifiable conditions. Every error identifies project, assignment or event ID and a bounded
  recovery step without printing sensitive content.
- **Testability:** `npm run verify` remains the repository gate. Runtime phases add deterministic
  fake-port tests, real temporary Git/worktree tests, packed-plugin tests, crash-boundary recovery
  tests, and a declared live Paseo compatibility smoke matrix.

## 9. Boundaries and Dependencies

- **Depends on:** the existing role/provider generation and marker; the authority model in
  `demonthorn-agent-orchestration-deep-dive.md`; current `docs/design.md` invariants; Paseo plugin
  hooks/events/RPC/client panels; Paseo SDK agent and worktree workspace APIs; Git repositories for
  writable assignment candidates.
- **Does not own:** vendor authentication; operator homes; Paseo installation or upgrades; project
  issue tracking; repository workflow policy; source-control hosting; merge/push/deploy; OS sandbox;
  remote/multi-user consistency; correctness of repository gate commands.
- **Trust boundary:** the operator explicitly enables Paseo plugins. The runtime plugin may access
  local files and processes but is designed to read/write only its room-owned state plus the exact
  assigned workspace—and, in Phase 2, managed worktree—needed to inspect candidate/gate evidence.
- **Control-plane boundary:** Paseo owns lifecycle. The runtime supplies typed intent, validates
  room-specific authority, records evidence, and calls Paseo APIs; it never starts an agent CLI
  directly.
- **Compatibility boundary:** runtime is opt-in and may require a higher Paseo minimum than baseline
  Codex-only rooms. Choosing runtime accepts that additional minimum; omitting it does not raise the
  baseline.

## 10. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 0 — Design qualification | Bounded live compatibility spike for hook composition, same-workspace parentage, assignment-scoped `ask`/`handoff` delivery, archive/stop evidence, singleton/generation fencing, panel/RPC, and exact client/server version floors. The Q-014 amendment landed first, so no process in any environment exposes the reporting bridge before the generated `peerReporting` gate is written for an exact Peer entry, with no test or development bypass. | Q-001, Q-002, Q-003a, Q-004, Q-005, Q-006 and Q-014 close with reproducible fixtures and a declared Paseo range; unsupported behavior returns the design to Review before an implementation plan is activated. |
| Phase 1 MVP — Runtime spine | Opt-in separate plugin; generated exact-provider manifest; versioned immutable event store and durable report receipts; independent writer ownership; assignment-scoped Peer reporting bridge; clean-base dispatch; candidate, Peer verification, optional independent runtime gate, acceptance and restart recovery; status and minimal panel; carrier coexistence. Peer receives only `ask` and `handoff`, no built-in Paseo or other runtime tool. No parallel writers. | REQ-001 through REQ-009, REQ-012, REQ-013, and REQ-015 through REQ-020 pass for one writable owner; Q-003b closes with the full refusal, idempotency, generation-fencing and receipt-replay matrix on every exact provider path; the canonical authority amendment is applied and tested; no second writer starts before archive/stop proof; crash-boundary and plugin disable/reload tests pass; baseline `npm run verify` remains green without runtime; live smoke passes on the declared Paseo range. |
| Phase 2 MVP — Worktree concurrency | Separately approved Lead-contract amendment; Paseo-native worktree dispatch; one writer per worktree; declared scope collision checks; serial-only paths supplied by assignment/repository policy; stable candidate handoff; conservative archive/reclaim. No automatic merge. | The contract amendment explicitly grants only the bounded runtime-managed concurrency and passes static contract tests; REQ-010 and REQ-011 pass; three parallel writable assignments complete in isolated worktrees; overlap and uncertain-writer cases fail before dispatch; daemon restart preserves ownership and candidates; disk/worktree cleanup has explicit evidence. |
| Phase 3 — Deterministic operational guardrails | Re-scoped 2026-09-24 by the [attention delta](../design/runtime-coordination-attention.md) phase O1: a Room Observer over every room seat, deterministic momentum and safety signals, typed recipient policy with a Supervisor portfolio, incident deduplication, budgets and feedback, idle-held delivery that never interrupts, Human-started Supervisor and project seats, and the Room view. Role-filtered history, retention/compaction and richer recovery UI are deferred. | REQ-014, REQ-021, REQ-023, REQ-024 and REQ-025 pass; mandatory pages always deliver independently of attention budgets; assignment-local events do not notify Supervisor by default; injected duplicate, stale, malformed, delivery, gate and candidate failures remain visible; no model sensor or external telemetry is introduced. |
| Phase 4 — Compatibility hardening | Supported-version matrix, upgrade from prior runtime schema, client compatibility behavior, multiple-plugin ordering, remote-daemon documentation where applicable, and maintenance/runbook ownership. | Two consecutive supported Paseo patch releases pass the live matrix; upgrade/export/recovery rehearsal passes; no unresolved high-risk lifecycle or data-loss finding remains; repository owner explicitly decides whether runtime leaves preview status. |
| Phase 5 — Optional attention sensor | Brought forward 2026-09-24 as the [attention delta](../design/runtime-coordination-attention.md) phases O2–O3: default-off System One HTTP adapter (Jev first, self-hostable) behind an `AttentionSensor` port, configured from Settings; bounded event-derived state; shadow assessment, calibration, then assist mode for declared `attention` signals only. | REQ-022 passes; positive/negative fixtures cover every question; thresholds are calibrated per pinned model version from `useful`/`noise`/`unknown` feedback; no mandatory notification, recipient, lifecycle transition, acceptance, or baseline operation changes when the sensor is absent, wrong, slow, or unavailable. |

### Phase 0 qualification record — Paseo 0.8.0

A disposable `paseo-room-runtime-phase0` plugin and SDK client were exercised against a live local
Paseo CLI, daemon, plugin SDK, client SDK and connected app, all at `0.8.0`. The probe was removed
from Paseo after the run; it changed no repository source or room role contract.

| Surface | Observed result | Product consequence |
|---|---|---|
| Hook composition and binding | `before(agent.create)` preserved the caller prompt and observed the Claude carrier addition for the exact room Lead provider. Eleven unique probe nonces each reached exactly one awaited `before(agent.session_open)` with one agent ID. One deliberately invalid create reached `session_open` but never became a durable agent. | Q-001 closes only with provisional session-open binding, subsequent live-agent validation and bounded expiry; a hook nonce alone never grants an active bridge. |
| Reload fencing | Three reloads stopped the prior instance and its heartbeat before the next instance started; no overlapping runtime instance was observed. | Paseo `0.8.0` supplies the required single-active-plugin behavior for hot reload; the later restart row separately records daemon-restart evidence. |
| Same-workspace parentage | A no-prompt child refresh showed the exact workspace and reserved `paseo.parent-agent-id` label, with `idle` status, no active turn and no prior user message. Binding was recorded before a separate `run()` started the first turn. | Q-002 closes with mandatory two-step dispatch. `agent.created` is fire-and-forget and may not be used as the barrier. |
| Initial final-message matrix | Codex `gpt-5.6-sol` and Pi `openai-codex/gpt-5.6-sol` returned raw schema-valid JSON for initial, follow-up and adversarial turns. Claude `claude-haiku-4-5` returned fenced JSON on all three turns. | Comparative evidence only: model final formatting is not an authoritative reporting channel. Fence/prose extraction, repair and parser retry remain forbidden. |
| Projected final-message reads | After plugin reload, `projection: 'projected'` returned each complete final message; canonical projection returned stream fragments. Codex and Pi remained strictly valid, while the initial recovered Haiku result remained fenced and invalid. | Useful timeline evidence, but the reporting pivot recovers durable validated tool events and receipts rather than reparsing a final message. |
| Expanded final-message matrix | Eleven paths ran initial, follow-up, adversarial and rework turns plus projected recovery and archive cleanup. Ten paths passed the abandoned strict-final contract: Codex Sol/Terra/Luna/Astra; exact-room Claude Sonnet 5/Sonnet 4.6; and Pi OpenAI-Codex Sol/Terra/Luna/Astra. Codex/Pi used generic adapter paths. | Preserved comparative evidence only. It does not qualify `ask`/`handoff`, exact Codex/Pi room providers, or a model allowlist. |
| Claude repetition and exclusions | Exact-room Sonnet 5 passed three independent sessions with 12/12 strict turns and 12/12 projected messages. Opus 5 qualified in 0/3 focused sessions because of `reasoning_extraction`; Haiku 4.5 qualified in only 2/3 because one adversarial result was bare `No`; all agents archived `closed`. | Demonstrates why model-authored final formatting was a fragile trust boundary. It neither excludes nor qualifies a model for the new tool contract. |
| Archive evidence | Direct `archive()` returned the same `archivedAt` observed by immediate refresh and the lifecycle event; live status became `closed`. Archiving a parent also closed its child. | Successful archive plus corroborating refreshed status is sufficient control-plane release evidence, never proof about arbitrary same-user subprocesses. |
| Panel and RPC | The connected `0.8.0` app loaded a client entry registering `addWorkspacePanel` and invoked a schema-validated RPC after install and reload. | Q-006 closes: the tested Phase 1 panel requires no client floor higher than the tested `0.8.0` server floor. |
| Exact-provider boundary | Temporary exact `codex-peer` and `pi-peer` aliases plus the existing Claude role providers produced five exact creation records. Disposable runtime MCP was delivered to and called by Lead and Supervisor, while all three Peer creates had neither that custom entry nor its binding. Disposable Codex/Pi homes intentionally had no copied or linked credential, so their auth failures were retained rather than called passes. | Confirms exact provider recognition, the current no-custom-Peer-tool baseline and role-selective injection. It does not qualify the proposed reporter or prove built-in Paseo absence from hook-visible config alone. |
| App-absent and daemon restart | With no connected app socket, server heartbeat, RPC and exact-provider probes continued. A bound Peer was `running` with held ownership before daemon PID/generation changed; after restart the plugin recovered the same agent/provider/model/workspace, found no completed final message, classified it `uncertain`, and corroborated archive as `closed`. | Confirms conservative app-independent recovery on `0.8.0`; it does not prove durable reporting-call receipt/generation replay. |

Paseo's internal built-in MCP is materialized outside hook-visible `config.mcpServers`, so future
qualification must inspect effective provider policy and runtime tool exposure. This evidence verifies
hook/lifecycle composition, two-step parentage, archive, RPC/panel, exact-provider recognition,
app-absent operation and conservative restart behavior at `0.8.0`. The former
final-message matrices are comparative evidence only.

A later disposable probe closed the carrier question directly. An injected `ask`/`handoff` MCP server
reached exact `claude-peer`, `codex-peer` and `pi-peer`; each started it, listed its tools and called
`ask` with exactly the declared fields. Pi's exclusive MCP config mode did not block delivery, and
Claude held the turn until an explicit tool permission was allowed while Codex and Pi called with no
gate. One Pi run first failed because its default model was unsupported for the account, which is a
model-availability fault rather than an MCP fault. That resolves Q-003a and supports the Q-005 preview
range. Because the probe always accepted, Q-003b keeps the server's validation, fencing and receipt
semantics as Phase 1 exit criteria.

On 2026-09-22, the repository owner accepted clean immutable Git commits as the required writable
handoff representation. This resolves Q-004 independently of which reporting carrier is used.

This PRD's acceptance authorizes refinement and activation of the linked Technical Design for **Phase 1
MVP only**. The reporting-tool authority amendment was separately approved and applied on 2026-09-22. It does
not authorize Phase 2 parallel writers until Phase 1 passes `feature-done`, the repository owner
separately approves the concurrency phase, and the canonical Lead contract is explicitly amended and
verified.

## 11. Open Questions

Questions marked **decided** were carried as proposed answers and became decisions when the
repository owner accepted this PRD without amendment on 2026-09-22. Questions marked
**open** remains unresolved; where it names a Phase, it gates that Phase's exit rather than planning.

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Does the lowest supported Paseo hook/lifecycle context preserve prior hook mutations, bind each Supervisor/Lead bridge nonce to exactly one originating agent, and prove a single active runtime or host generation fence across reload? | Maintainer | resolved 2026-09-22 for Paseo `0.8.0` hot reload — prior mutations composed, each probe nonce mapped to one session-open agent ID, and old instances stopped before replacements; binding remains provisional until live validation |
| Q-002 | Can a plugin-created same-workspace child reliably preserve Lead parentage and expose it immediately enough to bind the assignment before the first prompt? | Maintainer | resolved 2026-09-22 — only via create-without-prompt, refresh/verify workspace and reserved `paseo.parent-agent-id`, persist binding, then `run()`; one-step create with an initial prompt is forbidden; cross-workspace creation remains a Phase 2 proof — proven on `0.9.1` 2026-09-23 through the workspace handle ([delta §9.2](../design/runtime-coordination-phase2.md)) |
| Q-003a | On each exact Codex, Claude and Pi room-provider path, can a runtime-managed Peer receive an injected reporting MCP server and invoke `ask` with schema-valid arguments? | Maintainer + Repository owner | resolved 2026-09-22 — a disposable probe on Paseo `0.8.0` delivered the reporter to exact `claude-peer`, `codex-peer` and `pi-peer`; all three listed the tools and called `ask` with exactly the declared fields. Pi's exclusive MCP config mode did not block delivery. Claude required an explicit permission approval naming the exact tool; Codex and Pi did not |
| Q-003b | Do the server's refusal, idempotency and recovery semantics hold on every exact provider path? | Maintainer | open — Phase 1 exit criterion, not a planning blocker; `handoff`, wrong-kind, failed-precondition, malformed/unknown-field, stale-generation, duplicate-identical, reused-request-ID conflict, misattributed, no-call and durable receipt replay across reload/daemon restart need the real validating server, which Phase 1 builds |
| Q-004 | May Phase 1 require a clean immutable commit for every writable handoff rather than storing source snapshots under the room home? | Repository owner | resolved 2026-09-22 — yes; every runtime-managed writable handoff requires a clean immutable Git commit, avoiding source snapshots and making gate/review evidence reproducible |
| Q-005 | What exact Paseo patch becomes the runtime server minimum after hook, lifecycle, parentage, reporting-call recovery, archive-status, singleton and RPC behavior are proven? | Maintainer | resolved 2026-09-22, widened 2026-09-23 — preview range `>=0.8.0 <0.10.0`. `0.8.0` carries the full exact-Peer evidence; `0.9.1` carries a full live cycle recorded in the design's §14. The exclusive upper bound reflects that `0.10.0` is unqualified. Phase 4 decides whether runtime leaves preview |
| Q-006 | Does the required Phase 1 panel impose a connected-app/client floor higher than the server floor? | Maintainer | resolved 2026-09-22 — no; a `0.8.0` connected app loaded the panel contribution and completed typed RPC against a `0.8.0` daemon |
| Q-007 | Should runtime ship in the same npm package under a distinct plugin ID or as a separately versioned package? | Repository owner | decided 2026-09-22 on PRD acceptance — same npm package and release, separate plugin ID/directory; revisit only if client/server release coupling becomes operationally costly |
| Q-008 | Where does the exact gate command come from when a repository has no `WORKSPACE_PROTOCOL.md`? | Repository owner | decided 2026-09-22 on PRD acceptance — Lead must place it in the complete assignment brief; the runtime never invents one |
| Q-009 | Which Jev endpoint/SDK, secret-setting surface, retention/ZDR contract, and pinned model version are acceptable? | Repository owner + Maintainer | resolved 2026-09-24 by the [attention delta](../design/runtime-coordination-attention.md) — plain HTTP to a configurable System One endpoint, write-only key RPC, pinned `jev-1.13.0`, masked bounded state; the owner accepts egress without ZDR and plans a self-hosted endpoint |
| Q-010 | What question set, evidence retention and measured thresholds justify moving a Jev sensor from shadow to assist? | Repository owner + Maintainer | partly resolved 2026-09-24 — question sets `lead-turn-v1`/`peer-report-v1` and the offline-then-shadow evaluation are defined in the attention delta §6, §12.3; the assist thresholds themselves wait for that data |
| Q-011 | What canonical glob grammar is sufficient for write scopes and serial-only paths without becoming a policy language? | Maintainer | resolved 2026-09-23 by the [Phase 2 design delta](../design/runtime-coordination-phase2.md) §5 — literal segments with `*`, `?`, `**`, an in-repo conservative overlap checker, no dependency |
| Q-012 | Should runtime state survive whole-room `remove --apply` through an automatic backup? | Repository owner | decided 2026-09-22 on PRD acceptance — no automatic backup; runtime deselection refuses active state, but explicit whole-room removal warns, offers export, then deletes under the repository's existing contract |
| Q-013 | Is the minimal Paseo panel required in Phase 1, or may machine-readable status ship first if client API compatibility delays it? | Repository owner | decided 2026-09-22 on PRD acceptance — keep the panel in Phase 1 because operational visibility is a product goal; treat client incompatibility as a release blocker, not a silent omission |
| Q-014 | What exact canonical authority amendment permits Peer to use only the assignment-reporting exception without gaining orchestration or control-plane authority? | Repository owner | resolved 2026-09-22 — the owner authorized and landed a narrow amendment in `AGENTS.md`, `docs/design.md`, `src/roles.ts` and `src/room/prompts/contract/peer.md`. The new `ROLE_PEER_REPORTING` policy is separate from `ROLE_PASEO_TOOLS`, which stays `false` for Peer; `src/agents/mcp.ts` and `src/agents/resources.ts` were examined and found unrelated to this surface. No generated room changes until a runtime plugin exists |

Phase 0 evidence qualification is complete. Live evidence and repository-owner
decisions closed Q-001, Q-002, Q-004, Q-006, Q-014, Q-003a and Q-005, and acceptance settled Q-007,
Q-008, Q-012 and Q-013. Q-003b remains open as a Phase 1 exit criterion, because the server semantics
it names cannot be proven before the server exists. This PRD is `Accepted` and the linked design is
`Active`, so a Phase 1 implementation plan may be activated.
Deferred Q-009 through Q-011 do not block
Phases 0–1 because those phases contain no sensor and no worktree concurrency.

## 12. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | Repository owner / Bytes | Amended by the approved [seat context delta](../design/runtime-coordination-seat-context.md) §12: new REQ-026 (context visibility), REQ-027 (per-role context budget) and REQ-028 (Lead succession with a reviewed handoff); REQ-024 adds starting a Lead from a project's own screen. |
| 2026-09-24 | Bytes | Attention O1–O2 implemented under the [attention delta](../design/runtime-coordination-attention.md) and [plan](../plans/runtime-coordination-attention-implementation-plan.md), and qualified live on Paseo `0.9.1` (delta §13.1). REQ-014, REQ-021, REQ-023, REQ-024 and REQ-025 are met by the deterministic observer. REQ-022 is met for shadow and operator-gated assist; enabling assist waits on the evaluation (delta §12.3). |
| 2026-09-24 | Repository owner / Bytes | Amended by the approved [attention delta](../design/runtime-coordination-attention.md) §10: REQ-014 covers every observed room seat with a project-scoped Supervisor recipient; REQ-021 forbids interrupting deliveries; REQ-022 may start in shadow after the deterministic observer, with Settings consent and a configurable endpoint; new REQ-023 (Supervisor portfolio), REQ-024 (Human-started seats) and REQ-025 (momentum feed); Phase 3 re-scoped and Phase 5 brought forward; Q-009 resolved, Q-010 partly. |
| 2026-09-23 | Bytes | Phase 2 MVP (worktree concurrency) implemented under the [Phase 2 delta](../design/runtime-coordination-phase2.md) and [plan](../plans/runtime-coordination-phase2-implementation-plan.md), and qualified live on Paseo `0.9.1` (delta §9.2): three parallel writers completed in isolated worktrees, overlap, serial-path, cap, exclusive and uncertain-writer cases refused before dispatch, restart preserved ownership and candidates, and cleanup carries `directoryRemoved` evidence. REQ-010 and REQ-011 pass. |
| 2026-09-23 | Bytes | Widened the preview Paseo range to `>=0.8.0 <0.10.0` and live-qualified Paseo `0.9.1` with a full dispatch/handoff/gate/accept/archive cycle; the upgrade also exposed and fixed a broken read of the changed `daemon status --json` shape. No requirement, authority or tool surface changed. |
| 2026-09-22 | Bytes | Phase 1 MVP delivered on branch `feat/runtime-coordination-phase1` and qualified live on Paseo `0.8.0` across all three exact Peer paths; Q-003b resolved. Implementation deltas are recorded in [runtime-coordination-change-001](../plans/runtime-coordination-change-001-implementation-deltas.md). Phase 2 remains unauthorized. |
| 2026-09-22 | Repository owner / Bytes | Qualified the reporting carrier on all three exact Peer providers, split Q-003 into resolved Q-003a and open Q-003b (a Phase 1 exit criterion), resolved Q-005 as preview range `>=0.8.0 <0.9.0`, and recorded that Claude gates a reporting call behind an explicit tool permission while Codex and Pi do not. Phase 1 planning is now unblocked. |
| 2026-09-22 | Repository owner | Accepted the PRD without amendment. Status moved Review → Accepted; the four carried proposed answers (Q-007, Q-008, Q-012, Q-013) became decisions. Acceptance authorized Phase 1 design activation and planning subject to the then-open carrier and version questions, and did not itself authorize implementation or Phase 2. |
| 2026-09-22 | Repository owner / Bytes | Resolved Q-014: the owner authorized and landed the narrow reporting amendment, adding `ROLE_PEER_REPORTING` alongside an unchanged `ROLE_PASEO_TOOLS.peer: false`, amending `AGENTS.md`, `docs/design.md` and the Peer contract, and leaving `src/agents/mcp.ts` and `src/agents/resources.ts` unchanged as unrelated. |
| 2026-09-22 | Repository owner / Bytes | Approved a PRD/design-only pivot to an assignment-scoped `ask`/`handoff` reporting bridge. Reopened Q-003, withdrew strict final JSON and model-policy v1 from the normative path, retained their fixtures as comparative evidence, and added the canonical authority-amendment gate Q-014. |
| 2026-09-22 | Repository owner / Bytes | Resolved Q-003 with model-policy v1: ten qualified model paths, explicit qualification provenance, operator-only selection, pinned assignment model, pre-turn drift rejection, and no parser fallback; this decision is superseded by the later reporting-tool pivot. |
| 2026-09-22 | Repository owner / Bytes | Resolved Q-004: runtime-managed writable handoffs require a clean immutable Git commit; source snapshots remain out of scope. |
| 2026-09-22 | Bytes | Recorded the first live Paseo `0.8.0` qualification: hot-reload binding, two-step same-workspace parentage, projected-message, archive and panel evidence; its strict-output blocker analysis was superseded by the reporting-tool pivot. |
| 2026-09-21 | Bytes | Revised after adversarial review: separated writer ownership from assignment state, restored the unrun-gate and whole-room removal contracts, added payload versioning and a bounded gate process, narrowed Phase 1 to Git, and placed selective Jev attention behind deterministic routing in a separately approved Phase 5. |
| 2026-09-21 | Bytes | Created Review draft for opt-in durable runtime coordination, schema-bound tool-free Peer results, stable-candidate handoff, gate provenance, restart recovery, and phased worktree concurrency while retaining the CLI safety floor; the tool-free result carrier was superseded on 2026-09-22. |
