# Paseo Room Runtime Coordination — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [Paseo Room Runtime Coordination PRD](../product/runtime-coordination-prd.md) — Accepted 2026-09-22 |
| Related ADRs | N/A — no ADR directory or governing ADR exists; the active constraints are [design.md](../design.md), [Orchestration Quality Hardening](orchestration-quality-hardening.md), and [Claude Strong Contract Carrier](claude-strong-contract-carrier.md) |
| Routing decision | Linked from the PRD: brownfield; trusted-plugin, persistent-state, public-contract, concurrency, and multi-session handoff risks; plan → converter after `prd-ready` and `design-ready` |

## 1. Boundaries

### This design owns

- an explicitly enabled, separately identified Paseo runtime plugin;
- a generated, versioned manifest mapping exact room provider IDs to role capabilities;
- typed assignment, writer ownership, question, handoff, candidate, gate-evidence, acceptance, and
  recovery state;
- immutable local runtime events and rebuildable derived views under `~/.paseo-room`;
- an assignment-scoped Peer reporting bridge exposing exactly `ask` and `handoff`, with durable
  attribution, generation fencing, receipts, and fail-closed validation;
- a Paseo operations panel and typed RPC status surface;
- Phase 2 worktree-backed writer ownership and declared write-scope collision checks;
- Phase 3 deterministic recipient policy, incident deduplication and feedback;
- a separately approved Phase 5 optional attention-sensor port;
- coexistence, upgrade, disablement, export, and removal behavior for runtime state.

### This design does not own

- role-home generation, credentials, authentication, provider pins, native multi-agent closures, or
  canonical contract prose;
- the required Claude contract carrier, which remains a smaller independent plugin and failure
  domain;
- project planning, issue hierarchy, priorities, architecture decisions, technical acceptance,
  automatic merge, push, deployment, or Human-owned choices;
- repository protocol creation or mutation;
- an OS sandbox or proof that an arbitrary shell process stayed inside a write scope;
- multi-user, cross-machine, or hosted coordination;
- model-based incident judgement through Phase 4, or any model authority over recipients, lifecycle,
  acceptance, mandatory notifications, or Human-owned choices in any phase.

## 2. Decisions and Invariants

### D1 — Runtime is opt-in and separate from the Claude carrier

The runtime plugin uses ID `paseo-room-runtime` and a separate room-owned directory. The existing
`paseo-room-claude-carrier` remains required only for selected Claude seats and continues to own
only additive creation-time contract delivery.

The separation is load-bearing:

- a runtime state or UI failure cannot remove Claude's strong contract carrier;
- Codex-only and Pi-only operators may enable runtime without pretending it is a Claude concern;
- creation-hook composition preserves every prior field: the carrier owns its additive
  `config.systemPrompt`, while runtime owns only its role-scoped environment and MCP-server entries;
  an eligible runtime-dispatched Peer receives only the assignment-scoped reporting bridge, never
  built-in Paseo tools or the Lead/Supervisor action surface;
- the runtime hook is order-independent and never requires the carrier marker to have appeared first;
  Paseo `0.8.0` was observed to run before-hooks serially by plugin ID and preserve the carrier output,
  but correctness does not depend on that undocumented ordering;
- plugin lifecycle and compatibility diagnostics can name the failing product surface accurately.

The room marker gains an optional runtime selection. Missing means disabled, so existing markers
remain readable. Setup still never enables Paseo's global plugin switch.

### D2 — CLI provisioning and runtime state have different ownership

The CLI manages runtime plugin source, generated manifest, registration, and marker exactly like
other desired state. Runtime-created project records are **preserve-only**:

- setup and verify may inspect their metadata and schema;
- setup never replaces, deletes, or reconciles their events;
- deselecting runtime removes registration only after active/uncertain work is resolved and retains
  state for explicit export or later re-enable;
- whole-room `remove --apply` keeps its existing destructive meaning: it reports active/uncertain
  runtime state, strongly recommends export and requires the command's existing explicit confirmation,
  but then deletes the room home rather than imposing a quiescence precondition.

This is not a transactional installer. A partial CLI setup is still repaired by running setup
again. Runtime durability is a separate product concern because its state records work that cannot
be reconstructed from generated files alone.

### D3 — Paseo remains the only lifecycle control plane

The plugin calls Paseo SDK operations for agents, parentage, messages, workspaces, worktrees,
archive, and timelines. It never launches Codex, Claude, Pi, Git worktrees, or a second daemon
itself.

The runtime event log records **intent and observed result**, not an alternate process lifecycle.
When it disagrees with live Paseo state, the project is degraded and recovery queries Paseo rather
than declaring its own ledger authoritative about whether a process exists.

The CLI and plugin keep room-owned runtime metadata under `~/.paseo-room`. Paseo may create a
worktree checkout under its own home and update the source repository's ordinary Git administrative
metadata as part of its native workspace operation; that is observed Paseo/Git state, not a second
room ledger or repository protocol written by this plugin.

Phase 1 support also requires Paseo to guarantee one active server runtime for a plugin ID across
reload, or expose a host generation fence that stale instances cannot use. It also requires exact
meaning for successful agent archive plus subsequent live status: runtime uses that only as
control-plane evidence that the seat cannot receive another turn, never as proof that every arbitrary
same-user subprocess has stopped. The `0.8.0` qualification observed prior cleanup and final heartbeat
before each replacement instance, and direct archive returned the same timestamp exposed by
`agent.archived` and a refreshed `closed` snapshot. Daemon-restart fencing remains a release rehearsal.
If either property regresses, runtime mutation is unsupported; this design does not add an ad hoc lock
service or second process coordinator.

### D4 — Authority is capability-based and role-asymmetric

| Actor | Runtime capabilities | Explicitly absent |
|---|---|---|
| Human/operator | enable/disable, inspect/export, explicit recovery/override through operator UI | no automatic acceptance or silent trust enablement |
| Supervisor | project/runtime health, assignments and findings, message or question to Lead | no assignment dispatch, write ownership, gate override, Peer channel, integration, or acceptance |
| Lead | create/dispatch assignment to an eligible exact Peer provider, answer, request rework, run gate, accept/reject/abandon, close assignment/archive managed Peer; Phase 2 closes a managed worktree workspace | no model override, Human-owned external-effect decision, or ability to make Peer an orchestrator |
| Peer | call `ask` or `handoff` for its current assignment/reporting generation | no built-in Paseo tools, status/list, topology, other assignments, recipient selection, agent/workspace lifecycle, orchestration, gate override, or acceptance |

`ROLE_PASEO_TOOLS` remains the single source for built-in Paseo-tool delivery and remains disabled
for Peer. The reporting bridge is a deliberately narrow exception, not a second control plane or a
renaming of built-in Paseo access: it exposes exactly `ask` and `handoff`, and the server derives
project, assignment, generation, agent, parent, provider, model, workspace and candidate identity. A Peer
does not submit any of those identifiers. Valid tool action is the only authoritative Peer report;
final prose, fenced JSON and turn completion are diagnostic evidence only.

This exception conflicts with the current canonical no-room-tool Peer rule. Q-014 resolved that
conflict on 2026-09-22: the repository owner authorized and landed a narrow amendment in
`AGENTS.md`, `docs/design.md`, `src/roles.ts` and `src/room/prompts/contract/peer.md`. The typed
policy `ROLE_PEER_REPORTING` marks Peer eligible while `ROLE_PASEO_TOOLS.peer` stays `false`, so
reporting eligibility and room-tool access remain separate single sources. The amendment
authorizes nothing by itself: the CLI writes no reporting server, so a generated room is
unchanged until an opt-in runtime plugin exists. `src/agents/mcp.ts` and `src/agents/resources.ts`
were examined and left unchanged, because the first inspects operator MCP declarations for
Paseo-looking servers and the second projects shared resources; neither gates this surface. The
generated `peerReporting` manifest key remains the mechanical exposure gate for that future
plugin, with no hook, test or development-mode bypass.

The server validates strict input, durable lifetime attribution, current reporting generation, live
agent/provider/parent/workspace facts, assignment state and work kind before any mutation. An
accepted action is durably recorded before a success receipt is returned. Identical retries return
the same receipt; malformed, unauthorized, stale, duplicate-conflicting, wrong-kind and
failed-precondition calls cannot transition state. Supervisor may inspect all permitted status, but unsolicited delivery
follows D9 and never mirrors every assignment event.

### D5 — Phase 1 starts and ends on stable Git evidence

Every Phase 1 runtime assignment targets a Git repository. Before writable dispatch, the controller
requires all of the following in one observed precondition:

- the canonical Git common directory and worktree resolve to the assignment's bound project and
  expected workspace ID;
- `HEAD` equals the assignment's exact `baseCommit`;
- `git status --porcelain=v1 --untracked-files=all` is empty (ignored files remain outside the evidence
  contract), using the same canonical cwd and Git executable again at handoff;
- no project writer ownership is `reserved`, `held`, `releasing`, or `uncertain`.

It persists writer reservation before agent creation. A complete writable `handoff` reports
deliverables, verification and residual risk but does not name source-control identity. The plugin
derives `HEAD`, base ancestry, the same cleanliness predicate and a normalized path set from the
committed `baseCommit..candidate` diff before creating a candidate. A no-change outcome may resolve
to the base commit. Read-only completion is likewise bound to the commit the runtime observes.

Phase 1 does not support non-Git runtime assignments or copy diffs, untracked contents, or source
archives into runtime state. The general role contract may still use a deterministic snapshot outside
this optional product path.

### D6 — Peer verification and runtime gates are evidence, never acceptance

Lead supplies the exact gate in every writable assignment, normally quoting repository policy. The
runtime never discovers or invents a default. Peer must run that command after its last project write
and report the command and faithful result. `not-run` is valid only in a blocked/partial handback; it
cannot produce a candidate and cannot be waived into one by Lead.

`GateSpecV1.runtimeRerun` separately selects `none`, `optional`, or `required`. An explicit Lead
`gate_run` performs an independent rerun against an already validated candidate. It never substitutes
for Peer verification. If `required`, acceptance waits for a terminal rerun result; if `optional`,
absence is displayed without weakening the Peer gate requirement.

The runtime gate process contract is fixed. `timeoutSeconds` is an integer from 1 through 3,600,
the exact command is at most 16 KiB, the retained combined stdout/stderr tail is at most 64 KiB, and
the termination grace period is five seconds:

1. verify the canonical cwd is the assigned workspace at the candidate commit and is clean;
2. persist `gate.requested`, then launch `/bin/sh -c <exact command>` in its own process group with
   stdin closed and no additional shell interpolation by the controller;
3. environment-policy v1 starts empty, copies only `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
   `LC_ALL`, `LC_CTYPE`, and `TZ` when present, then sets `CI=1` and `PASEO_ROOM_GATE=1`; it copies no
   other process variable and persists only the policy version, never values. A repository needing
   secret-bearing verification must use an operator-run path outside this runner;
4. stream a SHA-256 digest over all combined output and a 64 KiB bounded best-effort-masked tail to an
   owner-only attachment; no full output is retained and exports omit the attachment by default;
5. on timeout send `SIGTERM` to the process group, wait five seconds, then `SIGKILL`; publish an atomic
   result sidecar carrying exit/signal/timeout and termination evidence only after the owned process
   group is terminal, otherwise record `uncertain`;
6. recheck `HEAD` and the D5 cleanliness predicate, then emit `gate.finished` or `gate.uncertain`.

A restart reads only the assignment's result sidecar. It never kills a numeric PID recovered from
state because of PID reuse; a child without a trustworthy terminal result remains uncertain. Lead may
accept a red result only with an explicit reason. A green result is not acceptance, and Phase 1 never
merges, resets, cleans or stashes as part of a gate.

The controller enforces presence, command equality and `not-run` refusal in Peer verification, but it
cannot independently prove that Peer actually ran the command after its last write. That occurrence
and timing remain procedural self-report evidence, labeled as such under D8. The independent runtime
rerun is enforced evidence about its own bounded process only and still does not upgrade the Peer
claim or become acceptance.

### D7 — Parallelism follows worktree isolation, never pathname optimism

Phase 1 permits one writer ownership per project in Lead's current project workspace. Ownership is
orthogonal to assignment state: it remains held through question, handoff, blocked, rework,
acceptance, rejection and abandonment until archive/stop is proven. This preserves the existing
one-writer restraint and detects workspace movement; it does not claim worktree isolation or prevent
Lead/an arbitrary same-user shell from writing.

The canonical Lead contract currently forbids concurrent writable Peers even in isolated worktrees.
Phase 2 therefore requires a separately reviewed contract amendment and repository-owner approval;
this design does not itself grant that authority. Only after that change may Phase 2 dispatch several
writable Peers, and only when all of these hold:

- every writable assignment has a distinct Paseo worktree-backed workspace;
- each worktree has one active writer;
- each assignment declares a canonical write scope;
- active scopes do not overlap and do not collide with serial-only paths supplied by the assignment
  from repository policy;
- the source base is an exact commit;
- the prior writer of any reused workspace is confirmed stopped or archived.

A lease is an ownership record, not a clock-based mutex. Expiry alone never transfers ownership,
because an agent stuck in a long tool call may still write. Reclaim requires Paseo evidence that the
prior agent cannot continue, followed by an explicit Lead or Human recovery action. An epoch fences
runtime operations from the prior assignment, but the UI states truthfully that it cannot fence an
arbitrary shell running as the same OS user.

### D8 — Claims carry an evidence class

Every status and finding is one of:

- **enforced:** the plugin validated the operation before performing its own lifecycle action;
- **detected:** observed after the fact from Paseo, Git, or runtime events;
- **procedural:** required by the role contract but not enforceable by this surface;
- **unverifiable:** the runtime lacks sufficient evidence.

The UI and JSON contract include this class. “Healthy” means no known enforced or detected failure;
it never means the model obeyed its prompt or the operating system contained it.

### D9 — Notification audience is deterministic; model attention is optional

Every signal first enters one code-owned class:

| Class | Default behavior | Examples |
|---|---|---|
| `record` | event/status only | normal create, dispatch, rework, acceptance, green gate |
| `owner` | notify Lead | Peer question, invalid result, blocked handback, candidate movement, red/unrun gate |
| `operator` | notify/show operator | plugin, manifest, state, export or compatibility fault |
| `page` | notify the authority recipient immediately; never filtered or budgeted | duplicate/ambiguous Lead, writer ownership conflict, unavailable Lead with active work, explicit Human-boundary or irreversible-risk condition |
| `attention` | incident/panel first; deterministic Phase 3 policy may digest it | recurring rework, repeated weak evidence, possible goal drift or stalled progress |

Audience comes from the authority matrix and signal type, never from a model. Peer receives none of
these notices. Assignment-local technical evidence goes to Lead, not Supervisor. Supervisor receives
unsolicited messages only for project ownership/recovery, unavailable Lead, systemic recurrence, or
Human-boundary routing; ordinary events remain available through status.

Phase 3 adds incident deduplication by subject and kind, counts, evidence references, a non-page daily
attention budget, and `useful | noise | unknown` Supervisor feedback. Phase 5 may add a default-off
`AttentionSensor` behind a separate design delta. It sees only declared `attention` signals, starts in
shadow mode, and may recommend record/digest/notify urgency; code still chooses the recipient and
transition. Mandatory pages bypass it. Missing, slow, uncertain, or wrong sensor output falls back to
deterministic behavior and cannot degrade the runtime spine.

A Jev adapter, if approved, pins an exact model and question-set version, asks atomic English
questions over bounded masked event-derived state, records source event IDs, probabilities and model
version, and calibrates thresholds from feedback per model version. It sends no source file, raw
timeline, environment, credential, gate output, or room topology. Scores and model verdicts stay out
of incident letters so feedback measures usefulness rather than echoing the model.

## 3. Architecture

```text
                         operator
                            │
          paseo-room setup --runtime / verify / remove
                            │
           writes only ~/.paseo-room managed assets
                            │
          ┌─────────────────┴──────────────────┐
          │                                    │
Claude carrier plugin                 runtime plugin
(systemPrompt only)           (server hooks/events/RPC + client panel)
                                               │
                       generated exact-provider manifest
                                               │
                    ┌──────────────────────────┼──────────────────────┐
                    │                          │                      │
             assignment controller       event store          derived views
                    │                          │                      │
        ┌───────────┼───────────┐     immutable events      status / findings
        │           │           │
   Paseo agents  Paseo workspaces  gate runner
   + parentage   + worktrees        in assigned cwd
        ├── Lead/Supervisor action bridge ── atomic spool under ~/.paseo-room/runtime
        │
        └── Peer reporting bridge ── assignment-scoped `ask` / `handoff` only
```

### 3.1 CLI integration

A new explicit setup option selects runtime coordination. The exact spelling is settled in the
implementation plan, but its behavior is fixed here:

- dry-run shows managed plugin files, registration, compatibility checks, exact-provider reporting-
  bridge qualification provenance and generated policy version;
- apply writes a bundled plugin tree and generated room manifest under the room home;
- runtime adds no model-selection policy or authority. Human/operator-owned room/provider configuration
  determines the exact model; Lead may choose an eligible exact Peer provider but cannot name, change,
  waive or substitute its model. Runtime records observed identity and refuses assignment drift;
- the plugin requires Paseo `>=0.8.0 <0.9.0`. `0.8.0` is the only live-tested point: Q-003a proved
  reporter delivery and invocation on all three exact Peer providers there, and the upper bound is
  exclusive because `0.9.0` behavior is unqualified. This remains a preview range under Q-005;
- setup fails if plugins are globally disabled, the ID is registered from a foreign path, or the
  plugin cannot reach `running`;
- verify compares plugin source, generated manifest, registration path/status, manifest generation
  and approved reporting-policy generation;
- the existing room marker records `{ runtime: { enabled: true, generation, schema: 1 } }` as an
  optional field;
- runtime omission creates no dependency for rooms that do not select it.

Generated assets and runtime-owned state live in different subtrees:

```text
~/.paseo-room/
  plugin/                         # existing Claude carrier; unchanged
  runtime-plugin/                 # CLI-managed plugin bundle
    paseo-plugin.json
    index.server.ts
    index.client.tsx
    server/  client/  shared/
    generated/room-manifest.json  # CLI-managed, no secrets
  runtime/                        # plugin-owned, preserve-only
    v1/
      projects/
      spool/
      exports/
```

### 3.2 Generated room manifest

`room-manifest.json` is the bridge from provisioning evidence to runtime recognition. It contains
only deterministic data:

```ts
interface RuntimeRoomManifestV1 {
  readonly schema: 1;
  readonly roomGeneration: string;
  readonly contractGeneration: string;
  readonly reportingPolicyGeneration: string;
  readonly providers: Readonly<Record<string, {
    readonly agent: 'codex' | 'claude' | 'pi';
    readonly role: 'supervisor' | 'lead' | 'peer';
    readonly capabilities: readonly RuntimeCapability[];
    readonly peerReporting?: {
      readonly protocol: 1;
      readonly tools: readonly ['ask', 'handoff'];
      readonly qualifiedVia: 'exact-room-provider';
    };
  }>>;
}
```

Provider IDs are exact; prefix matching is forbidden. Capabilities are generated from one typed
runtime role-policy projection, not inferred from labels. `peerReporting` is present exactly on Peer
entries, under the canonical authority amendment landed in Q-014, and its operations are a
closed tuple. Setup writes the approved reporting-policy generation and honest exact-provider
qualification tier. The plugin refuses missing, broader, stale or non-exact reporting declarations;
generic adapter evidence cannot become an exact-room claim. The file contains no executable command,
credential, model secret, repository path, assignment ID, agent ID or mutable project state.

The plugin rereads the manifest on reload. A generation mismatch pauses new runtime operations but
does not discard state or stop existing baseline seats. Setup is the only writer.

### 3.3 Server plugin components

- **Recognition:** accepts only exact room providers from the generated manifest and ignores internal
  Paseo agents. Cwd/title/labels are supporting context, never identity.
- **Creation hook:** composes only role-scoped runtime env and MCP entries. It preserves prior hook
  output, including any Claude carrier system prompt. For Supervisor/Lead it mints a one-use
  provisional action-bridge correlation. For an eligible runtime-dispatch Peer intent it injects only
  the `ask`/`handoff` reporting bridge and a one-use provisional lifetime-binding correlation only
  when that exact manifest entry carries `peerReporting`; it never injects built-in Paseo access or the
  Lead/Supervisor action surface. `peerReporting` is absent unless setup generated it for that exact
  Peer entry under the landed Q-014 policy.
- **Dispatch adapter:** after clean-base and writer-reservation checks, creates the assigned Peer
  through Paseo with Lead's eligible exact provider and the model fixed by Human/operator-owned provider
  configuration, plus parent and labels, but **without an initial prompt**. Phase 1 uses Lead's current
  project workspace; Phase 2 supplies a separately proven worktree workspace. A fresh refetch must show
  the returned ID on the intended exact provider/model in the expected workspace, with reserved
  `paseo.parent-agent-id` naming Lead, `idle` status, no active turn and no prior user message. Only after
  that identity, the durable lifetime binding, `held` ownership, reporting generation, `run()` intent
  and `active` state are published may the separate `run()` send the complete brief as the first prompt.
- **Lifecycle adapter:** consumes created, turn-started, turn-ended, permission, and archived events as
  notifications, never barriers; uses a fresh Paseo API handle supplied to each hook/event/RPC rather
  than retaining a stale handle.
- **Controller:** validates actor capability, project state, assignment state, reporting generation,
  idempotency and candidate/workspace evidence before emitting intent or result events.
- **Paseo port:** is the only module that calls agent/workspace SDK methods. Tests replace it with a
  fake.
- **Git evidence port:** resolves canonical root, base/head, ancestry, cleanliness and changed paths.
  It does not merge, reset, clean, stash, commit, push, or delete branches.
- **Gate runner:** implements D6's fixed shell/environment/process-group/result-sidecar contract for
  an explicitly requested independent rerun only.
- **Store:** owns immutable event writes and replay. Controller modules never mutate JSON snapshots
  directly.
- **Projection:** derives role-filtered status, writer ownership, findings and notification candidates.
  Cached projections are disposable.
- **Attention policy:** Phase 3 maps typed signals to deterministic recipients and incidents; a Phase 5
  `AttentionSensor` adapter is optional and cannot call controller mutations.
- **RPC:** exposes Zod-validated panel/status/actions; inputs and outputs contain explicit schema
  versions.

Paseo `0.8.0` emits lifecycle events fire-and-forget. No state transition relies on an
`agent.created`, `agent.turn_ended` or `agent.archived` handler completing before Paseo continues;
external effects are corroborated through the fresh SDK reads named above.

### 3.4 Runtime action bridges and Peer reporting contract

Paseo can set MCP servers only at agent creation, so the creation hook injects a role-scoped bridge
only for a runtime-recognized creation intent. The Supervisor/Lead action bridge and Peer reporting
bridge share the durable spool transport but expose disjoint tool registries. Neither exists when
runtime is not selected.

| Tool set | Operations |
|---|---|
| Supervisor | `room_status`, `runtime_findings`, `message_lead` |
| Lead | `assignment_create`, `assignment_dispatch`, `assignment_answer`, `assignment_rework`, `assignment_accept`, `assignment_reject`, `assignment_abandon`, `assignment_close`, `assignment_status`, `gate_run` |
| Peer | `ask`, `handoff` |

Phase 2 may add `managed_workspace_close` only for a workspace the runtime created through Paseo. It
never closes Lead's pre-existing project workspace. No phase adds another Peer reporting operation
without a new authority and protocol revision.

Each bridge is a small stdio MCP process. It does not call Paseo directly. It publishes a
schema-checked request with the same no-clobber atomic primitive as the event store into a room-owned
spool and waits for the matching atomic reply. The plugin watches the request directory and drains it
on startup, so a missed filesystem notification does not lose a request. No periodic status polling
is required.

A transport envelope carries protocol version, a bridge-generated request ID, operation, strict typed
payload and an opaque correlation. Peer tool input contains none of the envelope identity. The
controller resolves a Peer correlation through two server-owned records:

1. a durable lifetime binding to one room generation, project, assignment, Peer agent, exact
   provider/model, Lead parent and workspace;
2. the assignment's current reporting generation, opened immediately before one initial, answer, or
   rework `run()` and closed by one accepted `ask` or `handoff` action.

Immediately before each `run()`, the controller durably opens a generation, records its capability
hash, publishes the `run()` intent and projects the assignment `active`; it then atomically publishes
the opaque capability for the lifetime binding. The bridge reads and embeds that hidden capability
when it enqueues a call; it is never part of MCP tool input. A later
generation is not published until the prior turn has ended and all prior-generation spool entries are
accepted or refused. An uncertain entry holds the fence closed and retains its original generation across reload
instead of being reattributed to a later turn. The Peer never sees or submits project, assignment,
generation, agent, parent, provider, workspace, recipient, candidate or lifecycle IDs.

`before(agent.create)` injects only a provisional, one-use correlation. The awaited
`before(agent.session_open)` may associate it with one agent ID and workspace, but does not prove
creation succeeded: the `0.8.0` probe observed `session_open` for a create that later left no durable
agent. Before opening the first reporting generation, the controller requires a fresh live match for
the exact provider/model, parent, workspace, room generation and no-prior-prompt condition, then
durably publishes the lifetime binding and writer ownership. Unconsumed, ambiguous and non-live
correlations expire or become uncertain; hook execution alone never activates them.

The binding is intentionally not called a security sandbox. A process under the same OS user may be
able to read another process's files. Its purpose is to prevent accidental cross-project calls, make
every accepted report attributable, and ensure possession grants no operation broader than the bound
role. The controller freshly corroborates the bound live agent and assignment before transition.

Peer tools use strict schemas with unknown fields rejected:

```ts
type VerificationReportV1 = {
  readonly command: string;
  readonly outcome: 'passed' | 'failed' | 'not-run';
  readonly note?: string;
};

type AskInputV1 = {
  readonly question: string;
  readonly blockingContext: string;
  readonly evidence: readonly string[];
};

type HandoffBaseV1 = {
  readonly summary: string;
  readonly deliverables: readonly string[];
  readonly verification: readonly VerificationReportV1[];
  readonly residualRisks: readonly string[];
  readonly evidence: readonly string[];
};

type EngineerDetailsV1 = {
  readonly kind: 'engineer';
};

type ArchitectDetailsV1 = {
  readonly kind: 'architect';
  readonly alternatives: readonly string[];
  readonly strongestCounterargument: string;
  readonly reversalConditions: readonly string[];
  readonly evidence: readonly string[];
};

type ReviewerDetailsV1 = {
  readonly kind: 'reviewer';
  readonly findings: readonly { readonly claim: string; readonly evidence: readonly string[] }[];
};

type ScoutDetailsV1 = {
  readonly kind: 'scout';
  readonly evidence: readonly string[];
  readonly remainingUnknowns: readonly string[];
  readonly confidence: 'low' | 'medium' | 'high';
};

type HandoffInputV1 = HandoffBaseV1 & (
  | {
      readonly completion: 'blocked' | 'partial';
      readonly blocker: string;
    }
  | {
      readonly completion: 'complete';
      readonly details: EngineerDetailsV1 | ArchitectDetailsV1 | ReviewerDetailsV1 | ScoutDetailsV1;
    }
);

type PeerReportReceiptV1 = {
  readonly schema: 1;
  readonly receipt: string;
  readonly tool: 'ask' | 'handoff';
  readonly status: 'accepted';
  readonly assignmentState: 'questioned' | 'blocked' | 'handed-back';
};

type PeerReportErrorCodeV1 =
  | 'report_malformed'
  | 'report_unauthorized'
  | 'report_stale'
  | 'report_conflict'
  | 'report_state'
  | 'report_precondition'
  | 'report_uncertain';

type PeerReportErrorV1 = {
  readonly schema: 1;
  readonly error: {
    readonly code: PeerReportErrorCodeV1;
    readonly message: string;
    readonly retryable: boolean;
  };
};
```

The server selects and advertises the one `handoff` detail variant matching the bound assignment work
kind; a Peer cannot choose or change that kind. Blocked/partial reports require `blocker`; complete
reports reject it. `blockingContext` and `blocker` are report content, not priority, routing or
lifecycle instructions. The schemas contain no recipient, assignment creation, model selection, gate
override, acceptance or candidate field. Aggregate tool JSON is at most 64 KiB; arrays contain at
most 64 items; ordinary strings are 1 byte–8 KiB, while `verification.command` follows D6's 16 KiB
limit. Receipts and refusal errors use the versioned closed output contracts above.

Validation precedes mutation in this order: strict payload and size bounds; known durable lifetime
binding; exact authorized tool and room generation; then a durable-receipt lookup scoped to that
binding and the envelope's captured generation. A matching request ID and fingerprint, or matching
accepted fingerprint, returns the prior receipt; a reused request ID with another fingerprint returns
`report_conflict`. Only a request without an accepted receipt proceeds to current-reporting-generation,
fresh live agent/provider/model/parent/workspace, assignment-state, expected-work-kind and operation-
specific invariant checks. A failed invariant returns `report_precondition`. Every refusal returns
a bounded error and redacted `call.refused` evidence without consuming the generation or changing
assignment, candidate, ownership or lifecycle state.

For each reporting generation, the first accepted transport request ID, action fingerprint—generation,
tool and canonical validated payload—and receipt are stored in the same authoritative event publication
before MCP success is returned. A retry with that request ID returns the receipt only when its fingerprint
also matches; the same accepted fingerprint under a new request ID also returns that durable receipt,
including after plugin restart, without repeating a transition. The bounded receipt exposes only schema
version, opaque receipt ID, tool, accepted state and resulting assignment state—never caller or
assignment identity. A different
action for a consumed generation, a stale-generation call, or a duplicate with conflicting payload is
refused with a stable error code. If persistence succeeds but the response
is lost, recovery replays the receipt; if persistence is uncertain, the tool fails closed and the
assignment remains `uncertain` until replay resolves it.

An accepted `ask` moves the assignment to `questioned` and consumes the reporting generation. Lead's
answer opens a new generation before its separate `run()`. An accepted `handoff` with `partial` or
`blocked` moves to `blocked` and creates no candidate. An accepted `complete` handoff moves to
`handed-back` only after work-kind-specific checks. For writable work, the exact named Peer gate
must have an outcome other than `not-run`; the runtime independently derives actual `HEAD`, base
ancestry, cleanliness, changed paths, workspace and immutable candidate. Read-only inspected commit
and relevant workspace facts are likewise derived, never copied from Peer claims.

A turn that ends without an accepted reporting action after every spool entry is terminal produces
`peer.report-missing`, projects `blocked` and notifies Lead. Unresolved report persistence instead
produces `peer.report-uncertain`, projects `uncertain` and holds the generation fence closed. Final prose,
fenced JSON, canonical/projected message content and turn completion may aid diagnostics but never
create a question, handoff, candidate or acceptance. There is no parser, fence removal, embedded-JSON
extraction, repair loop, implicit retry, model substitution or automatic context transfer.

A pending provider tool permission is a distinct expected state, not a missing report. Paseo `0.8.0`
required an explicit permission approval before a Claude Peer could call the reporter, naming the
exact tool, while Codex and Pi Peers called it with no gate. A seat blocked on that approval has
produced no spool entry at all, so the controller must not treat the condition as `report-missing`:
while a permission request for a reporting tool is outstanding for the bound agent, the assignment
holds its generation open, projects a distinct awaiting-permission status to Lead and the operator,
and waits. Only after the request is resolved and the turn ends without an accepted action does
`report-missing` apply. The runtime never answers a permission request on a seat's behalf, because
that decision is Human/operator-owned; a denied request ends the turn with no report and is reported
as such.

## 4. Runtime Data Model

### 4.1 Project identity and layout

Every runtime project is Git-backed. On first binding, the plugin mints a room-local project UUID and
writes an immutable, atomically published `meta.json` containing that ID, creation time, initial
canonical root and canonical Git common-directory path. The directory path is
`<slug>-<project-uuid>`; identity is not a hash of a movable path. Main checkout and Paseo worktrees
map to one project through the common directory. A moved repository is never auto-adopted by remote,
name or cwd similarity: an explicit operator rebind emits `project.rebound` after proving the old
binding is inactive.

```text
runtime/v1/projects/<slug>-<project-uuid>/
  meta.json
  events/
    000000000001.json             # event ID remains inside the envelope
    000000000002.json
  cache/
    status.json
    idempotency.json
  gates/
    <gate-run-id>.log             # bounded, redacted evidence attachment
  quarantine/
```

Immutable `meta.json` and event files are authoritative for state. Current path binding is derived
from events, not by mutating metadata. Gate tails are bounded owner-only attachments referenced by
events; a missing attachment degrades that evidence but does not change replay. `cache/` may be
deleted and rebuilt. A project event directory is normally written by one runtime plugin process,
but sequence allocation still uses no-clobber publication and retries so an overlapping reload
cannot overwrite an event.

### 4.2 Event envelope

```ts
interface RuntimeEventV1<TType extends string, TPayloadVersion extends number, TData> {
  readonly schema: 'paseo-room.runtime-event';
  readonly version: 1;
  readonly type: TType;
  readonly payloadVersion: TPayloadVersion;
  readonly id: string;
  readonly sequence: number;
  readonly projectId: string;
  readonly assignmentId?: string;
  readonly actor: {
    readonly source: 'human' | 'plugin' | 'seat' | 'paseo';
    readonly role?: 'supervisor' | 'lead' | 'peer';
    readonly agentId?: string;
    readonly providerId?: string;
  };
  readonly causationId?: string;
  readonly idempotencyKey?: string;
  readonly occurredAt: string;
  readonly data: TData;
}
```

The writable type is a closed discriminated union such as
`RuntimeEventV1<'assignment.created', 1, AssignmentCreatedV1> | ...`; production writers cannot emit
an arbitrary type/version/data tuple. `sequence`, not wall-clock time, orders a project.
`occurredAt` is diagnostic. Every event is fully validated before persistence, written to a unique
sibling temporary file with mode `0600`, and file-
fsynced. Publication uses an atomic same-filesystem hard link from the temporary file to a previously
absent final name; `EEXIST` causes sequence reallocation and retry, never replacement. The temporary
name is then unlinked and the containing directory is fsynced where the platform supports it. If the
filesystem cannot provide that no-clobber primitive, the project fails closed instead of weakening
append-only semantics.

On replay:

- a sequence gap is allowed and reported; sequence reuse or duplicate conflicting id is not;
- an unknown additive field inside a supported event payload is ignored for forward reading; request,
  manifest, RPC and Peer reporting-tool inputs remain strict;
- an unknown event type or unsupported payload version pauses that project;
- an invalid file moves nothing automatically. The project is marked degraded and the operator may
  inspect or explicitly quarantine it; it is never read as an empty ledger.

### 4.3 Assignment record

The projection of assignment events has this shape:

```ts
type AssignmentMode = 'writable' | 'read-only';
type AssignmentKind = 'engineer' | 'architect' | 'reviewer' | 'scout';
type AssignmentState =
  | 'draft'
  | 'dispatching'
  | 'active'
  | 'questioned'
  | 'blocked'
  | 'handed-back'
  | 'rework'
  | 'awaiting-permission'
  | 'accepted'
  | 'rejected'
  | 'abandoned'
  | 'uncertain';

interface GateSpecV1 {
  readonly command: string;
  readonly timeoutSeconds: number;
  readonly runtimeRerun: 'none' | 'optional' | 'required';
  readonly processContractVersion: 1;
}

interface AssignmentV1 {
  readonly id: string;
  readonly projectId: string;
  readonly leadAgentId: string;
  readonly mode: AssignmentMode;
  readonly kind: AssignmentKind;
  readonly observedPeerProviderId?: string;
  readonly observedPeerModel?: string;
  readonly reportingGeneration: number;
  readonly reportingState: 'closed' | 'open' | 'consumed' | 'uncertain';
  readonly outcome: string;
  readonly prerequisites: readonly string[];
  readonly writeScope: readonly string[];
  readonly exclusions: readonly string[];
  readonly invariants: readonly string[];
  readonly acceptanceEvidence: readonly string[];
  readonly gate?: GateSpecV1; // required for writable; optional evidence specification for read-only
  readonly expectedHandoff: readonly string[];
  readonly reopenConditions: readonly string[];
  readonly baseCommit: string;
  readonly state: AssignmentState;
  readonly peerAgentId?: string;
  readonly workspaceId?: string;
  readonly closure: 'open' | 'closing' | 'closed' | 'uncertain';
  readonly candidate?: CandidateRefV1;
}
```

An accepted `ask` or `handoff` from §3.4 is stored as an attributable report event with its durable
receipt. Tool payload claims are retained as report evidence but never copied into authoritative
identity or candidate fields; only `CandidateRefV1` computed from live Paseo/Git evidence may
populate the projection. Provider/model fields record the exact live dispatch identity selected
under existing room authority; runtime does not add a model allowlist or selection surface. Drift
from those observed values blocks every later prompt. Mode/work-kind mismatches are rejected at
assignment creation. `closure` is independent of acceptance and writer ownership, so a terminal
technical decision cannot pretend a still-resumable Peer has stopped.

The runtime stores fields needed to validate lifecycle; it does not add a plan, priority, estimate,
dependency graph, or issue hierarchy. An external issue reference may be included as opaque context
but is not fetched or synchronized by Phase 1.

### 4.4 Candidate, gate, lease and notice

```ts
interface CandidateRefV1 {
  readonly kind: 'git-commit';
  readonly commit: string;
  readonly baseCommit: string;
  readonly changedPaths: readonly string[];
  readonly workspaceId: string;
  readonly branch?: string;
}

interface WriterOwnershipV1 {
  readonly projectId: string;
  readonly assignmentId: string;
  readonly agentId?: string;
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly state: 'reserved' | 'held' | 'releasing' | 'released' | 'uncertain';
}

// Phase 2 only; augments common ownership with a runtime-managed worktree lease.
interface WriterLeaseV1 extends WriterOwnershipV1 {
  readonly agentId: string;
  readonly worktreePath: string;
  readonly scopes: readonly string[];
  readonly epoch: number;
}

interface GateResultV1 {
  readonly id: string;
  readonly assignmentId: string;
  readonly candidate: CandidateRefV1;
  readonly command: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly timedOut: boolean;
  readonly termination: 'exited' | 'signaled' | 'killed' | 'uncertain';
  readonly processContractVersion: 1;
  readonly environmentPolicyVersion: 1;
  readonly outputDigest: string;
  readonly outputTailAttachment?: string;
  readonly workspaceMoved: boolean;
}

type NotificationDisposition = 'record' | 'panel' | 'lead-now' | 'supervisor-digest' |
  'supervisor-now' | 'operator-now' | 'human-required';

interface NoticeV1 {
  readonly id: string;
  readonly recipientAgentId?: string;
  readonly assignmentId?: string;
  readonly kind: string;
  readonly disposition: NotificationDisposition;
  readonly state: 'pending' | 'sent' | 'failed' | 'uncertain';
}

// Phase 3 projection; source events remain authoritative.
interface IncidentV1 {
  readonly id: string;
  readonly subjectId: string;
  readonly kind: string;
  readonly level: 'page' | 'attention' | 'note';
  readonly count: number;
  readonly sourceEventIds: readonly string[];
  readonly feedback?: 'useful' | 'noise' | 'unknown';
  readonly state: 'open' | 'closed';
}
```

A stable notice ID appears in delivered text. Delivery is at least once. If a crash occurs after
Paseo accepts a message but before `notice.sent` persists, retry may produce a duplicate carrying the
same ID; role instructions and runtime actions treat it as one notice. The product does not claim
exactly-once messaging from an API that does not provide it. Incident aggregation never rewrites the
source notices/events, and a page is delivered through this deterministic path without consulting an
attention sensor.

## 5. State Machines and Authorization

### 5.1 Assignment transitions

```text
create
  │
  ▼
draft ──dispatch──> dispatching ──binding+held+generation+run intent published──> active
  │                       │
  └──abandon──> abandoned └──unresolved create───────────────────────────────> uncertain

active ──accepted ask──────────────> questioned ──Lead answer/new generation+run intent──> active
  │
  ├──accepted handoff(blocked|partial)──> blocked ──Lead follow-up/new generation+run intent──> active
  │
  ├──accepted complete handoff──────────> handed-back ──Lead rework──> rework
  │                                           │                         │
  │                                           └──accept/reject           └──new generation+run intent──> active
  │
  ├──turn ends with no accepted action and all spool entries terminal──────────────> blocked
  │
  ├──reporting-tool permission pending──> awaiting-permission ──allowed──> active
  │                                              │
  │                                              └──denied/resolved, turn ends unreported──> blocked
  │
  └──unresolved run/report persistence──────────────────────────────────────────────> uncertain

writer ownership (separate projection):
reserved ──bound agent proven──> held ──close/archive requested──> releasing
                                                                    │
                                     control-plane stop proven ─────┴──> released
                                     failure/ambiguous evidence ───────> uncertain
```

Only Lead may dispatch, answer, request rework, accept, reject, abandon, or close. Peer may invoke
only `ask` or `handoff`; neither accepts a target or lifecycle instruction. The plugin records
`questioned`, `blocked`, or `handed-back` only from a durably accepted action by the exact lifetime
binding and current reporting generation after fresh agent/provider/parent/workspace validation—and,
in Phase 2, the current lease epoch. Supervisor receives status and findings but cannot transition an
assignment. Publishing `active` and the matching `run()` intent before the external call prevents a
first tool call from racing an internal `dispatching`, `questioned`, `blocked`, or `rework` state. An
unresolved `run()` immediately projects `uncertain` until §6 recovery settles it. An outstanding
reporting-tool permission projects `awaiting-permission` and is never read as a refusal to report.

Replay exits `uncertain` only from bounded evidence. For report-related uncertainty, a durable accepted
report projects its normal `questioned`, `blocked`, or `handed-back` target, while proof that no action
was accepted and every captured-generation spool entry is terminal projects `blocked`. A create or
`run()` proven not to have taken effect also projects `blocked`; ambiguous evidence stays `uncertain`.
Lead/Human may explicitly abandon only after the captured generation is terminal and archive is
requested. No path directly from `uncertain` opens a new generation.
Technical terminal state and Peer closure are distinct; acceptance, rejection or abandonment can
coexist with `held`, `releasing`, or `uncertain` ownership until stop is proven.

Writable acceptance requires:

- `handed-back` state and a validated immutable candidate;
- exact candidate still projected for the assignment, with no unresolved workspace movement;
- the exact named Peer verification command reported after the final write with `passed` or `failed`,
  never `not-run`;
- a terminal runtime rerun bound to that candidate when `GateSpecV1.runtimeRerun` is `required`;
- an explicit technical acceptance reason;
- for a failed Peer gate or failed required runtime rerun, an explicit override reason and residual-risk
  acknowledgement.

A failed Peer gate or failed required runtime rerun does not prohibit acceptance, but the acceptance
event must carry those additional override fields. A missing Peer gate creates no candidate. A missing
required runtime rerun keeps acceptance disabled; Lead must run it or change the assignment before dispatch,
not waive it after handoff.

### 5.2 Duplicate Lead handling

The public pre-create hook cannot be assumed to prove project parentage or uniqueness. Duplicate
Lead handling is therefore detection and containment, not claimed pre-creation enforcement:

1. lifecycle evidence identifies two eligible Lead providers for the same canonical project;
2. runtime records `project.ownership-conflict` and pauses new dispatch;
3. no existing timeline, assignment, candidate or workspace is deleted;
4. Supervisor/Human sees both identities and prior ownership evidence;
5. recovery keeps the previously corroborated owner only when evidence is unambiguous; otherwise
   Human decides.

The runtime never resolves the conflict by creation time, display title, or “latest wins.”

### 5.3 Writer ownership and reclaim

In Phase 1, clean-base dispatch first publishes `reserved`, then creates the agent without a prompt.
Ownership becomes `held` only after a fresh snapshot proves the Peer is idle, has received no user
message, is Lead's child through the reserved `paseo.parent-agent-id` label and occupies Lead's exact
current project workspace, and after that binding is durably published. The complete brief is then
sent with a separate `run()` call. One-step create with an initial prompt is forbidden because
`agent.created` is a fire-and-forget notification, not a pre-turn barrier. Any ownership other than
`released` blocks another writable dispatch for that project. Closing the assignment requests agent
archive and may move ownership to `releasing`, but never closes Lead's workspace. Only successful
Paseo archive plus a corroborating live status that the seat cannot receive another turn releases ownership. Turn
completion, idle state, handoff, acceptance, rejection, abandonment and elapsed time are insufficient.

Phase 2 adds `WriterLeaseV1`: `reserved → held` only after Paseo returns a distinct worktree-backed
workspace and proves the created Peer is Lead's child there. Release uses the same archive/status
rule; worktree teardown remains a subsequent Paseo operation. Failure leaves `releasing` or
`uncertain`, and another writer is not placed there. This is control-plane exclusion, not proof that
an arbitrary same-user child process is dead.

In either phase, if creation succeeds but binding persistence fails, recovery searches only from the
unresolved create intent and exact expected provider, parent, workspace and reserved assignment
label. A matching child with no prior user message is archived through Paseo rather than adopted or
prompted; missing or ambiguous evidence leaves ownership `uncertain`. The runtime never adopts a
convenient agent by title or cwd.

## 6. External Effects and Recovery

Every external action uses an intent/result pair with one idempotency key:

```text
validate current projection
       │
       ▼
write <operation>.requested event
       │
       ▼
call Paseo / run gate
       │
       ├── proven success ──> write <operation>.succeeded
       ├── proven failure ──> write <operation>.failed
       └── process crash ───> replay sees unresolved intent
                                  │
                                  ▼
                           query bounded live evidence
                                  │
                     success / failure / uncertain
```

This is not rollback machinery. A created agent or workspace is not deleted merely because a later
record write failed. Recovery converges the record to observed reality or asks for explicit action.

| Unresolved intent | Recovery evidence | Unsafe assumption forbidden |
|---|---|---|
| agent/workspace create | unresolved create intent plus exact provider, reserved `paseo.parent-agent-id`, workspace, canonical project and no prior user message | adopting or prompting by title/cwd alone |
| agent `run()`/prompt | fresh agent turn/timeline evidence tied to the captured reporting generation and exact dispatched prompt; absent or ambiguous evidence remains uncertain | blind resend, opening a later generation, or inferring delivery from a lifecycle notification |
| reporting-tool permission | live provider permission state for the bound agent and exact tool name | treating a pending or denied permission as a missing report, or answering it on the seat's behalf |
| Peer reporting action | durable accepted-action/receipt event bound to the lifetime identity and captured reporting generation; an unresolved spool request retains that generation and is revalidated against fresh live facts | reparsing direct/canonical/projected messages, assigning an old request to a newer generation, or treating turn completion as a report |
| gate run | atomically published terminal result sidecar plus candidate/workspace identity | treating plugin restart, missing result, or a reused numeric PID as pass/fail/stopped |
| agent archive/writer release | successful archive result plus corroborating live Paseo status | treating assignment close, idle, turn completion, acceptance, rejection, abandonment or time as stopped |
| Phase 2 workspace close | live workspace status from Paseo after writer release | reusing path because a timeout elapsed |
| notice delivery | stable notice ID and observed Paseo result where available | claiming exactly-once delivery or regenerating a new ID on retry |
| sensor assessment (Phase 5) | attributable bounded input, pinned model/question version and valid typed output | changing a transition/recipient, suppressing a page, or treating timeout/error as semantic evidence |
| acceptance record | immutable local event only; no external effect | inferring acceptance from merge, gate, idle state or sensor output |

The runtime does not run a background polling patrol. Recovery runs on plugin start and relevant
lifecycle/RPC activity. A low-frequency operator-visible maintenance scan may be added only if real
evidence shows lifecycle events leave state stranded; that would require a design delta.

## 7. Worktree Concurrency — Phase 2

### 7.1 Native Paseo workspaces

The plugin requests Paseo's worktree workspace with:

- canonical source checkout;
- exact base commit or qualified base reference resolved to a commit;
- deterministic room assignment label/metadata;
- unique branch/worktree slug;
- repository-native `paseo.json` setup/teardown behavior, if the repository already supplies it.

The plugin does not create `paseo.json`, copy `.env`, install dependencies, or replace Paseo's
setup/teardown. Paseo's native Git operation may create a checkout under its workspace root and
update standard `.git/worktrees` administrative metadata in the source repository; the plugin does
not treat either as its own state or mutate them directly. A setup failure leaves the assignment
failed/uncertain with Paseo's evidence and no Peer launch.

### 7.2 Scope grammar and collision

Phase 2 defines one small grammar: repository-relative POSIX paths with `*`, `?`, and `**`; no
negation, brace expansion, absolute path, parent traversal, or executable expression. Paths are
normalized before comparison. Empty scope means whole repository.

Two scopes conflict when either may match a path matched by the other, or either reaches a declared
serial-only path. The algorithm must prefer false-positive refusal over false-negative concurrency;
a pattern whose overlap cannot be decided is treated as overlapping. This is scheduling evidence,
not a file access control list.

### 7.3 Integration boundary

The runtime stops at a stable candidate and optional review/gate evidence. Lead integrates with the
normal project tools in the lane/project workspace. Automatic merge queues, rebases, conflict
resolution, fast-forward landing, push and branch deletion remain out of scope until a separate PRD
shows they improve the product more than they enlarge the failure surface.

## 8. Panel and Consumed Contracts

### 8.1 Client panel

The runtime contributes one Paseo sidebar surface and one workspace panel. It uses React Native
primitives, theme tokens and compact layouts per Paseo's plugin contract.

Views:

- **Overview:** plugin/manifest health, projects with active or degraded runtime state and mandatory
  pages.
- **Project:** corroborated Lead, assignments, questions, candidates, gates, independent writer
  ownership, uncertain effects, findings and deduplicated incidents.
- **Assignment:** complete brief, actor/workspace identity, event-derived transition history, Peer and
  optional runtime gate evidence, closure/ownership state and allowed recovery actions.
- **Attention (Phase 3):** incident counts/evidence, deterministic disposition, daily non-page budget
  and `useful | noise | unknown` feedback.
- **Settings/Trust:** runtime is room-managed, plugin code is trusted/unsandboxed, external sensors
  are off by default, sensor/network consent is separate, and retention/export boundaries are clear.

Data is role-filtered server-side before it reaches client RPC. The panel is an operator surface; it
is not used as authority evidence by a seat.

### 8.2 Versioned RPC

Shared Zod contracts use a common envelope:

```ts
interface RuntimeRpcResponseV1<T> {
  readonly schema: 1;
  readonly revision: string;
  readonly data: T;
  readonly warnings: readonly RuntimeWarningV1[];
}

interface RuntimeRpcErrorV1 {
  readonly schema: 1;
  readonly revision: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly recoveryAction: string;
    readonly retryable: boolean;
  };
  readonly warnings: readonly RuntimeWarningV1[];
}
```

Read RPCs include catalog/health, project list, project status, and assignment detail. Mutation RPCs
use explicit idempotency keys and the same controller authorization as runtime bridge calls. Unknown
fields are rejected. Errors use `RuntimeRpcErrorV1` with stable codes and bounded human remediation;
raw stack traces remain in redacted plugin logs.

Unchanged derived views keep the same content revision so client polling does not transfer a full
view. Paseo plugin APIs do not currently provide push for arbitrary panel state; the panel may poll
the local RPC at a bounded interval while visible. This UI refresh is not agent-status polling and
does not drive runtime behavior.

## 9. Security and Privacy

### 9.1 Threat model

Protected against:

- accidental use by foreign provider IDs;
- cross-role runtime calls;
- a Peer receiving any runtime operation beyond `ask`/`handoff`, or using either tool to enumerate or control the room;
- silent state reset after malformed data;
- credential or environment values entering events/status through designed fields;
- plugin path hijack and manifest/provider drift detectable by setup/verify;
- two runtime-dispatched writers sharing one managed workspace;
- a missing, stale, misattributed or conflicting reporting action—or an optional attention sensor—
  silently becoming acceptance or lifecycle evidence.

Not protected against:

- malicious code running as the same OS user reading local files, connecting to a local daemon, or
  writing outside a worktree;
- a compromised trusted plugin;
- an operator manually starting contradictory providers or agents;
- prompt injection causing a seat to misuse shell authority;
- a repository gate command that itself is destructive, spawns durable descendants, reads repository
  credentials, or exfiltrates data;
- a later external attention provider retaining or correlating masked assessments beyond its approved
  privacy contract.

### 9.2 Controls

- runtime state files use mode `0600` and directories `0700`; managed plugin source keeps the
  repository's existing managed-file mode contract;
- exact provider IDs and generated capability maps, never labels/prefixes;
- strict schemas at bridge, Peer reporting-tool, RPC and manifest boundaries; event readers strictly
  validate known semantics while allowing additive fields only inside supported payload versions;
- durable server-owned lifetime bindings and per-run reporting generations; no Peer-supplied identity,
  target, recipient or candidate field;
- no credential reads and no environment values in persisted events;
- runtime gates use closed stdin, canonical assigned cwd, `/bin/sh -c`, a versioned minimal environment
  without Paseo/plugin/sensor secrets, bounded process-group termination, a digest and bounded
  best-effort-masked owner-only tail; full output is not retained and exported attachments are opt-in;
- plugin registration path and running status verified by CLI;
- client and server plugin versions bounded to the tested Paseo range;
- exact observed provider/model provenance and pre-turn drift checks without a runtime model allowlist,
  selector, substitution or context transfer;
- Peer receives one reporting MCP server exposing exactly `ask` and `handoff`, but no built-in Paseo
  server, Lead/Supervisor action, room topology, target/recipient field or caller identity argument;
- runtime state is never symlinked into operator homes or repositories;
- Phase 5 sensors are default-off and receive only the bounded masked fields approved by their
  question contract; source, raw timeline, environment, credentials, gate output and room topology
  are excluded;
- security review must explicitly test every denied cross-role operation, malformed/unknown-field,
  wrong-kind, failed-precondition, stale-generation, duplicate-conflicting and misattributed report,
  gate environment/termination, sensor field projection and both plugin hook orders.

Gate execution is a privileged local action. It is allowed only for Lead/Human-authorized assignment
state and displays the exact command before execution. Phase 1 does not offer arbitrary shell as a
generic RPC.

## 10. Compatibility, Migration and Removal

### Existing rooms

Existing `room.json` files have no runtime field and remain runtime-disabled. No state migration or
new plugin call occurs during ordinary setup. Enabling runtime adds managed assets and optional
marker data; it does not rewrite role credentials or import prior timelines as assignments.

### Runtime schema evolution

The event envelope remains version 1 for additive event types/fields. Every concrete event starts
with `payloadVersion: 1`; a breaking payload keeps its old reader and adds a new payload version.
Writers emit only a closed event-type/payload-version union, while readers retain every version the
current runtime major has emitted. Unsupported future data fails closed and remains exportable.
Automatic “read as empty,” destructive reset, and hidden in-place migration are forbidden.

A future compaction may write a verified snapshot plus retain raw events according to explicit
retention. Phase 1 has no compaction; its event count is bounded operationally and measured before a
retention design is accepted.

### Plugin upgrade and rollback

Setup updates managed plugin files atomically and reloads the exact runtime ID. The plugin replays
existing events before accepting mutations. If reload fails, baseline room behavior remains but
runtime is visibly unavailable. Running assigned Peers may finish code work; structured handoff waits
for recovery.

Rolling back to a version that cannot read existing runtime state is not reported as successful.
The old plugin remains disabled for that project until a compatible version is restored or data is
exported and explicitly reset. The CLI never downgrades state silently.

### Disable and remove

- Runtime deselection refuses while assignments, writer ownership, managed-agent archives, gates or
  deliveries are active/uncertain; Phase 2 also refuses active/uncertain workspace closures.
- Once quiescent, setup may unregister the runtime plugin and retain `runtime/` state.
- Explicit export creates a schema-filtered archive under the selected destination, excludes gate-tail
  attachments by default and states that arbitrary retained brief/command strings cannot be proven
  secret-free.
- Whole-room `remove --apply` reports active/uncertain runtime state, strongly recommends export and
  retains the existing destructive warning/explicit confirmation. It then deletes the room home,
  credentials and runtime history without a runtime quiescence precondition. It does not remove
  operator-owned branches or source repositories.

## 11. Reliability and Failure Modes

| Failure | Detection | Behavior |
|---|---|---|
| plugin unavailable/failed | daemon plugin status and logs | baseline room remains; no new runtime operation; verify fails for runtime-selected room |
| global plugins disabled | config capability check | setup dry-run/apply refuses and asks operator to enable explicitly |
| foreign plugin registration | exact ID + canonical path comparison | setup/verify refuses; never reloads or removes foreign source |
| malformed/unknown event | strict replay | affected project pauses; evidence preserved; no empty fallback |
| crash during event write | temp + file fsync + no-clobber hard-link publish + directory fsync | old or complete new event; temporary file ignored/reported |
| crash around external effect | unresolved intent on replay | bounded live reconciliation; success/failure/uncertain, never guessed |
| overlapping plugin runtime | host singleton/generation evidence | stale instance cannot mutate; unsupported host fails compatibility rather than adding a second coordinator |
| duplicate reporting request | durable generation/fingerprint receipt projection | identical retry returns the prior receipt; conflicting or consumed-generation call is refused without transition |
| reporting tool awaiting permission | live provider permission state for the bound agent and tool | hold the generation open and surface awaiting-permission; never record report-missing or auto-approve |
| duplicate/ambiguous Lead | live role/parent/project evidence | pause dispatch; mandatory Supervisor/Human page; preserve both |
| dirty/moved dispatch base | canonical Git/workspace check before reservation | refuse dispatch without cleaning, resetting or stashing |
| agent disappears or archive is unproven | lifecycle/archive result plus live query | assignment closure and writer ownership become uncertain; no next writer/workspace reuse |
| notification uncertain | unresolved notice intent | retry with same notice ID; duplicate possible and explicit |
| candidate/workspace moves | Git identity check | invalidate gate/accept path until new handoff |
| gate timeout/plugin restart | process-group termination while owned; atomic result sidecar and unresolved intent after restart | record terminal evidence or uncertain; never signal a recovered numeric PID or infer pass/fail |
| attention sensor unavailable/wrong/slow (Phase 5) | timeout/error/schema validation | ignore assessment; deterministic incident disposition remains; pages were never routed through it |
| worktree setup/teardown fails | Paseo result/live workspace | block Peer launch or reuse; leave evidence and manual/native recovery |
| carrier/runtime hook conflict | permutation integration tests | release blocker; runtime never owns system prompt |
| disk full | write/publish/fsync failure | no transition; surface project degraded and preserve prior state |

No failure causes automated branch deletion, force reset, `git clean`, credential mutation, or
operator-home rewrite.

## 12. Testing Strategy

### Deterministic unit and contract tests

- strict manifest, RPC, action-bridge and work-kind-specific `ask`/`handoff` schemas; unknown-field,
  size, malformed, wrong-kind, failed-precondition, stale-generation and observed-provider/model-drift
  refusal before initial/answer/rework turns; closed event writer unions, payload-version validation,
  supported-payload additive fields, and unknown type/version refusal;
- full role/capability matrix with negative cross-role calls, one role-policy projection and proof that
  Peer receives only the reporting bridge and no built-in Paseo or Lead/Supervisor operation;
- assignment, reporting-generation, durable receipt, closure and independent writer-ownership
  transitions; identical fingerprint under same/new request IDs, reused-ID conflict, persistence before
  response and replay tests;
- clean-base dispatch, candidate derivation, required Peer gate, optional/required runtime-rerun binding,
  `not-run` refusal, and explicit red-evidence override;
- event sequence collision, no-clobber publish, stale temporary file, atomic replay, cache rebuild and
  malformed-state refusal;
- notice at-least-once behavior, duplicate IDs, recipient matrix, page bypass, incident deduplication,
  non-page budget and feedback;
- generated manifest/provider exactness and marker backward compatibility;
- client projection wording, evidence-class labeling and destructive-remove versus deselection behavior;
- Phase 5 only: sensor input-field allowlist, fallback, pinned-model attribution, threshold-version reset,
  and proof that assessment cannot mutate lifecycle, recipient or acceptance.

### Integration tests with fakes and temporary Git repositories

- fake Paseo port for create/send/archive/live-status ordering, writer release and crash at every
  intent/result boundary;
- temporary repositories for canonical common-directory binding/rebind, dirty dispatch refusal,
  ancestry, clean handoff, changed paths, moved candidate, gate pass/fail/signal/timeout,
  process-group termination, restart uncertainty, sanitized environment and output masking;
- Phase 2 static contract tests plus native or faithful worktree tests for distinct paths, overlap
  refusal, agent-disappearance, teardown failure and no-reuse-until-stopped;
- real filesystem permission, unexpected shape, symlink and disk/write-failure cases;
- plugin reload with cache deletion and byte-equivalent projected status.

### Plugin/package tests

- packed npm artifact contains the complete server/client/shared runtime bundle and generated-asset
  templates without source-checkout dependencies;
- both install orders of runtime and Claude carrier preserve `systemPrompt` and role-scoped MCP entries;
  exact runtime Peers receive only the reporting bridge, while baseline/non-runtime Peers remain unchanged;
- disabled, failed, incompatible and foreign-path plugin states fail with exact diagnostics;
- wide/compact and light/dark panel smoke tests using the existing web-app testing approach;
- no HTML/DOM APIs outside an explicitly web-gated module.

### Phase 0 live compatibility qualification

With the Q-014 reporting exception authorized and landed, a bounded live probe qualified the carrier
itself: the generated role policy must enable `peerReporting` only for exact runtime-managed Peers, and
Q-003a proved delivery and invocation on all three exact Peer paths at `0.8.0`. The remaining items
below are Phase 1 release evidence under Q-003b rather than preconditions for planning, because they
exercise the validating server that Phase 1 builds. A real daemon/app pair on the supported range must
produce reproducible fixtures proving:

- install/reload/disable/remove and server log visibility;
- creation-hook composition, disjoint Supervisor/Lead action and Peer reporting registries, and no
  built-in Paseo delivery to Peer at the effective provider/runtime boundary;
- exact Codex, Claude and Pi room-provider delivery and invocation of `ask`/`handoff` on initial,
  answer/follow-up and rework turns, plus malformed/unknown-field, wrong-kind, failed-precondition,
  stale-generation, duplicate-identical, conflicting, misattributed and prose-only/no-call cases;
- durable accepted-action receipt recovery after response loss, plugin reload and daemon restart;
- lifecycle events, single-active-runtime or host-generation fencing, fresh API handles after reload,
  and the exact archive/live-status evidence safe for writer release;
- same-workspace two-step child creation with no initial prompt, refreshed parent/workspace proof,
  durable binding and only then first-turn dispatch; Phase 2 separately proves cross-workspace
  parentage and worktree lifecycle before concurrency;
- RPC schema validation, client-panel compatibility and exact independent server/client version floors;
- runtime behavior with no app connected;
- Codex, Claude and Pi room providers recognized exactly, with Peer retaining no built-in Paseo or
  runtime operation beyond `ask`/`handoff`;
- daemon restart during active assignment and unresolved report/notification/gate recovery.

#### Qualification record — 2026-09-22

Disposable probes used Paseo CLI, daemon, plugin SDK, client SDK and connected app `0.8.0`, Codex CLI
`0.155.0`, and Pi `0.86.0` initially (`0.87.0` in the later exact-provider diagnostic). They were
removed after the run and changed no product source or canonical role contract.

| Surface | Evidence | Qualification |
|---|---|---|
| Hook/binding | Prior prompt and Claude carrier marker survived composition; eleven unique correlations each reached one awaited `session_open` agent ID; one later-failed create proved session-open state must remain provisional. | Q-001 resolved for `0.8.0` hot reload with live validation and expiry. |
| Runtime generation | Three reloads recorded prior cleanup and final heartbeat before the replacement start, with distinct instances and no overlap. A later permitted daemon restart changed PID/start generation and reloaded the plugin to `running`. | Single-active hot reload and conservative restart recovery passed at `0.8.0`; reporting-generation receipt replay remains unqualified. |
| Child binding | A child created without a prompt refreshed as `idle` in the exact workspace, with the reserved `paseo.parent-agent-id` label, no active turn and no prior user message; the first `run()` occurred only after binding evidence was written. | Q-002 resolved only for the mandatory two-step algorithm. |
| Initial final-message matrix | Codex `gpt-5.6-sol` and Pi `openai-codex/gpt-5.6-sol` returned raw schema-valid JSON for initial, follow-up and adversarial turns. Claude `claude-haiku-4-5` returned fenced JSON in all three cases. | Comparative evidence only; final formatting is not the reporting authority. Fence/prose extraction and repair remain forbidden. |
| Projected final-message reads | After plugin reload, projected timeline reads recovered complete messages while canonical reads returned stream fragments. | Diagnostic timeline evidence only; recovery must replay accepted reporting events/receipts, not parse messages. |
| Expanded final-message matrix | Eleven paths ran initial, follow-up, adversarial and rework turns plus projected recovery and archive cleanup. Ten paths passed the abandoned strict-final contract; Codex/Pi used generic adapter paths. | Preserved comparative evidence only. It qualifies neither `ask`/`handoff`, exact Codex/Pi providers nor a model allowlist. |
| Claude repetition/exclusion | Exact-room Sonnet 5 passed 12/12 strict turns and recoveries. Opus 5 passed 0/3 sessions because of `reasoning_extraction`; Haiku 4.5 passed only 2/3 because one result was bare `No`; all probes archived `closed`. | Evidence that model-authored formatting was a fragile authority boundary; it neither excludes nor qualifies a model for the tool contract. |
| Archive | Direct archive result, lifecycle event and refreshed `archivedAt` matched; refreshed status was `closed`. | Writer release may use archive plus refreshed live status as control-plane evidence. |
| Client | A `0.8.0` app loaded `addWorkspacePanel` and called typed RPC after install/reload. | Q-006 resolved: no higher client floor was observed. |
| Exact-provider boundary | Temporary exact Codex/Pi aliases and existing Claude role providers were recognized. Lead/Supervisor received and called the disposable runtime MCP; three Peer creates received neither that custom server nor its binding. Codex/Pi exact turns stopped at missing credentials and were not promoted to passes. | Confirms exact recognition and the current no-custom-Peer-tool baseline. It does not qualify the proposed reporter or prove built-in Paseo absence from hook-visible config alone. |
| App-absent/restart | With no app socket, server heartbeat, RPC and probes continued. An exact authenticated Claude Peer was running with held ownership before daemon restart; afterward the same agent/provider/model/workspace was recovered, no report/final message existed, state remained `uncertain`, and archive refreshed to `closed`. | Conservative app-independent restart behavior passed at `0.8.0`; durable action/receipt generation replay remains Q-003b. |
| Exact-Peer reporter carrier | A disposable probe injected an `ask`/`handoff` MCP server for exact `claude-peer`, `codex-peer` and `pi-peer`. All three started the server, completed `initialize`, requested `tools/list` and called `ask` with exactly `question`, `blockingContext` and `evidence`. Pi's `PI_MCP_CONFIG_MODE=exclusive` did not block delivery. Claude held the turn at `permission` until `mcp__<server>__ask` was explicitly allowed; Codex and Pi called with no gate. One Pi run first failed on its default `openai-codex/gpt-5.3-codex-spark` being unsupported for the account, which is a model-availability fault rather than an MCP fault, and succeeded on `openai-codex/gpt-5.6-sol`. All four probe agents archived `closed`. | Q-003a resolved: the carrier is feasible on every exact Peer path at `0.8.0`, and Q-005's preview range rests on it. The probe always answered `accepted`, so it qualifies neither validation, generation fencing nor receipt replay; those remain Q-003b. |

Paseo's internal built-in MCP is materialized outside hook-visible `config.mcpServers`; therefore the
release probe must inspect effective provider policy and runtime tool exposure, not infer absence from
creation-hook output. This evidence verifies lifecycle composition, two-step dispatch, archive,
RPC/panel, exact recognition, app-absent operation and conservative restart behavior at `0.8.0`. It
does not declare a product range beyond the Q-005 preview bound. Q-003a is resolved for the reporting
carrier and Q-003b remains open as a Phase 1 exit criterion;
Q-004 and Q-014 are independently resolved by the clean immutable Git-commit decision and the landed
reporting amendment respectively.

A direct comparative audit pinned Seatworks at commit
`c2ff48cf6b11b43fe864d4d40dd4bcb4f670c089`. It demonstrates the useful shape: Peer exposes only
`done`/`ask`; the server validates arguments before handler mutation; assignment is looked up from the
caller; Git/gate facts are derived; and a no-tool turn is detected rather than accepted as handoff.
This design deliberately does not copy its weaker boundaries: the bridge recovers agent identity from
environment/parent-process state, request files are removed before handling and expire after ten
minutes, duplicate suppression is in-memory only while a call runs, and no per-dispatch generation
fence or durable accepted receipt survives restart. Seatworks is comparative evidence, never authority.

No test claims model obedience. At least one live smoke assignment per exact provider path is required
because a fake SDK cannot prove vendor tool delivery and invocation.

The repository completion gate remains `npm run verify` in project order.

#### Phase 1 release qualification — 2026-09-22

The Phase 1 build (branch `feat/runtime-coordination-phase1`) was installed into the operator's own room
with `setup --runtime` on Paseo CLI/daemon/app `0.8.0`, alongside the running Claude carrier. Three disposable
Git repositories under `/tmp/live` each received a runtime-created Lead (opened without a prompt) and one
writable engineer assignment. Lead tool calls were issued through the Lead's own associated spool
correlation; Peers were real `claude-peer` (Claude Sonnet 5 via the room profile), `codex-peer` (`gpt-5.6-sol`,
provider default) and `pi-peer` (`openai-codex/gpt-5.6-sol`, set on the room profile for the run and
restored afterwards). Every probe agent was archived.

| Surface | Evidence | Result |
|---|---|---|
| Install | First install failed: Paseo copies CommonJS exports eagerly, so a `const` default export reached the host as undefined. Fixed with hoisted entry functions and a test that compiles and evaluates both entries the way Paseo does. | pass after fix |
| Peer create | Paseo's SDK requires `provider/model`; the bare provider id would have failed every dispatch. The model now comes only from the room profile or the provider's declared default; `pi-peer`, which declares none, was refused with `peer_model_unresolved` before anything was recorded. | pass after fix |
| Hooks and binding | Each created Lead received the action bridge and a durably associated correlation at `session_open`; each dispatched Peer received the reporting bridge, the carrier system prompt (Claude), the assignment label and Lead parentage. | pass |
| Two-step dispatch | `reserved → create (no prompt) → binding.published → held → generation 1 → run` on all three paths. | pass |
| Reporting tools | All three Peers called `handoff` and were accepted with a runtime-derived candidate (`hello.txt` only). Claude requested permission for `mcp__paseo_room__handoff`: the runtime recorded `permission.awaiting`, notified Lead and operator, and recorded `permission.resolved` once the operator allowed it. Codex and Pi asked nothing. Pi's first call omitted `details` and was refused `report_malformed` without consuming the turn; its retry was accepted. | pass |
| Q-003b matrix | On each path: identical report under a new request id replays the original receipt; a different report for the consumed turn → `report_stale`; unknown field and wrong-kind details → `report_malformed`; missing capability → `report_stale`; forged `assignment_accept` on the Peer correlation → `report_unauthorized`; unbound correlation → `report_unauthorized`. Re-run on the Claude path after `paseo plugin reload`: identical results, receipt replayed from the durable ledger. | pass |
| Real Lead | The notified Codex Leads verified candidates themselves, called `assignment_accept`, `gate_run` and `assignment_close` through their bridges. | pass |
| Independent gate | A `runtimeRerun: required` assignment: acceptance waited for the gate; `gate_run` finished `exit=0`, `termination=exited`, workspace unmoved; acceptance recorded its `gateResultId`. | pass |
| Archive and release | Every close produced `archive.requested → ownership.releasing → archive.succeeded → ownership.released` with a refreshed `closed` status. | pass |
| Deselect, re-enable, export | Setup without `--runtime` on quiet state unregistered the plugin and kept 3 projects; `--runtime` restored it; `export --apply` wrote 3 projects, no omissions, no gate output. | pass |
| Daemon restart | At the operator's request a detached script ran `paseo daemon restart` (PID 219117 → 1040391) and then the checks: carrier and runtime reloaded to `running`, `verify` ok, and the full matrix on all three paths returned identical codes with each original receipt replayed from the durable ledger. A second, independent daemon start (PID 1046382) also reloaded the runtime to `running`. | pass |
| Not rehearsed live | Whole-room `remove --apply` (would delete the operator's real room; covered by CLI tests); visual panel check on wide/compact and light/dark (needs the operator's eyes). | pending |

Operational findings: room Claude Peers start in Paseo's "Always Ask" mode, so an unattended Claude Peer waits
on every tool, not only the reporter; and the advertised flat `handoff` schema marks `details`/`blocker` as
conditionally required only in their descriptions, which one Pi turn missed once.

## 13. Phase Scope Summary

### Phase 0 — Design qualification

With Q-014, Q-003a and Q-005 closed, canonical authority permits the Peer reporter, the carrier is
proven on all three exact Peer paths, and the preview range is declared; the resolved evidence for
Q-001, Q-002, Q-004 and Q-006 stands.
Phase 1 implementation may now be planned. Q-003b carries the unproven server semantics—validation,
generation fencing, receipt recovery and effective built-in-tool exclusion—into Phase 1 exit criteria,
and a failed premise there returns this design to Review rather than creating
a second coordinator or a prose/final-message fallback.

### Phase 1 MVP — Runtime spine

Implements PRD REQ-001 through REQ-009, REQ-012, REQ-013 and REQ-015 through REQ-020 for one
writer ownership at a time in Lead's current Git project workspace. It includes the separate plugin,
generated manifest, versioned event store, Supervisor/Lead action bridge, assignment-scoped Peer
`ask`/`handoff` bridge with durable receipts, clean-base dispatch, stable commit handoff, Peer
verification, optional independent runtime gate, conservative writer release/recovery, status RPC and
minimal panel.

It does **not** relax one writable Peer per project, allocate/close a worktree, call an external sensor,
or route ordinary assignment events to Supervisor. Q-003b closes here: the refusal, idempotency,
generation-fencing and receipt-replay matrix must pass on every exact provider path before release.

### Deferred to Phase 2 MVP

Phase 2 remains descriptive, not authorized. It requires a separate design delta and an approved
canonical Lead-contract change that grants only runtime-managed, worktree-isolated concurrency.

- PRD REQ-010 and REQ-011;
- multiple writable Peers;
- native worktree allocation and reclaim;
- writer leases/epochs;
- scope grammar and serial-only collision checks.

### Phase 3 — Deterministic operational guardrails

Implements PRD REQ-014 and REQ-021: typed recipient policy, findings, incidents, deduplication,
feedback, non-page budgets, richer history/export and recovery UI. Mandatory pages bypass budgets;
assignment-local work stays with Lead. There is no model sensor or external telemetry.

### Phase 4 — Compatibility hardening

Qualifies subsequent supported Paseo patches, plugin ordering, schema upgrade/export/recovery and
runbook ownership. Preview exit remains an explicit repository-owner decision.

### Phase 5 — Optional attention sensor

Requires a separate approved design delta for PRD REQ-022. A default-off `AttentionSensor` begins in
shadow mode on declared `attention` signals only. Jev is one possible adapter, not a dependency of
the deterministic spine. No assist rollout occurs before privacy/ZDR approval, pinned model/question
versions, fixtures, per-version calibration and measured feedback.

Automatic merge/integration, remote coordination, multi-user auth and hosted state remain out of
scope.

## 14. Backward Compatibility and Rollout

- Current setup flags and defaults remain unchanged; runtime requires one new explicit choice and adds
  no model selector or allowlist.
- Existing markers remain valid because runtime metadata is optional.
- Existing provider/profile IDs and role homes remain unchanged.
- Peer built-in Paseo tools remain disabled. Under Q-014's landed canonical amendment, an exact runtime-managed
  Peer receives only the separate assignment-scoped `ask`/`handoff` reporter; baseline and non-runtime
  Peers receive no new server. Final messages remain non-authoritative.
- The Claude carrier remains independently installed, verified and removable according to its
  existing design.
- No prior conversation is imported; only assignments created through the runtime have structured
  state.
- Phase 1 rollout starts as preview on a bounded Paseo range and one local daemon. Runtime-selected
  verify is fail-closed; baseline verify is unchanged when not selected.

**Containment for runtime deselection:** disable new dispatch first, close or abandon assignments,
prove no writer ownership, managed Peer or gate remains active—and, in Phase 2, no workspace
closure—export if desired, then unregister runtime. This operational sequence does not alter the
separate destructive whole-room `remove --apply` contract.
Restore by installing the prior compatible plugin and replaying unchanged events; do not reset data
to make rollback green.

**R3 decision:** rehearsal is selected because this introduces persistent state and coordinated
plugin/agent effects with weak rollback. The repository owner is risk owner. Before release, fault
injection must exercise every intent/result boundary and a real daemon must rehearse plugin reload,
disable, daemon restart, unresolved agent creation, unresolved delivery, gate termination, runtime
deselection, export and explicit destructive whole-room removal. There is no destructive migration
rehearsal in Phase 1 because all runtime state
is new and opt-in; unsupported state is preserved and refused rather than converted in place.

## 15. Open Questions

A **decided** row was carried as a proposed answer and became a design decision when the repository
owner accepted the PRD without amendment on 2026-09-22. Open blockers remain unresolved regardless of
draft wording.

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Does the lowest supported Paseo hook/lifecycle context preserve prior hook mutations, bind each Supervisor/Lead bridge nonce to exactly one originating agent, and prove a single active runtime or host generation fence across reload? | Maintainer | resolved 2026-09-22 for Paseo `0.8.0` hot reload — prior mutations composed, each probe correlation mapped to one session-open agent ID, and prior instances stopped before replacements; binding remains provisional until live validation |
| Q-002 | Can a plugin-created same-workspace child reliably preserve Lead parentage and expose it immediately enough to bind the assignment before the first prompt? | Maintainer | resolved 2026-09-22 — require create without prompt, fresh workspace/idle/`paseo.parent-agent-id` proof, durable binding and then `run()`; lifecycle events are not barriers; cross-workspace creation remains Phase 2 |
| Q-003a | On each exact Codex, Claude and Pi room-provider path, can a runtime-managed Peer receive an injected reporting MCP server and invoke `ask` with schema-valid arguments? | Maintainer + Repository owner | resolved 2026-09-22 — a disposable probe on Paseo `0.8.0` delivered the reporter to exact `claude-peer`, `codex-peer` and `pi-peer`; each listed the tools and called `ask` with exactly the declared fields. Pi's `PI_MCP_CONFIG_MODE=exclusive` did not block delivery. Claude required an explicit permission approval naming `mcp__<server>__ask`; Codex and Pi did not |
| Q-003b | Do the server's refusal, idempotency and recovery semantics hold on every exact provider path? | Maintainer | resolved 2026-09-22 on `claude-peer`, `codex-peer` and `pi-peer` across plugin reload and daemon restart (see Phase 1 release qualification). Original scope: open — Phase 1 exit criterion, not a Phase 0 blocker; `handoff`, wrong-kind, failed-precondition, malformed/unknown-field, stale-generation, duplicate-identical, reused-request-ID conflict, misattributed, no-call and durable receipt replay across reload/daemon restart require the real validating server and cannot be proven by a probe that always accepts |
| Q-004 | Is an immutable clean commit an acceptable required handoff for runtime-managed writable work? | Repository owner | resolved 2026-09-22 — yes; every runtime-managed writable handoff requires a clean immutable Git commit, avoiding shadow source storage and candidate ambiguity |
| Q-005 | What exact Paseo patch becomes the runtime minimum after reporting-call recovery and the remaining lifecycle/client surfaces are proven? | Maintainer | resolved 2026-09-22 — preview range `>=0.8.0 <0.9.0`. `0.8.0` is the only live-tested point and now carries exact-Peer carrier evidence from Q-003a; the exclusive upper bound reflects that `0.9.0` is unqualified. Phase 4 decides whether runtime leaves preview |
| Q-006 | Does the Phase 1 panel require a client version floor higher than the server floor? | Maintainer | resolved 2026-09-22 — no; a `0.8.0` app loaded the panel contribution and completed typed RPC against a `0.8.0` daemon |
| Q-007 | Should runtime ship in the same npm package under a distinct plugin ID or as a separately versioned package? | Repository owner | decided 2026-09-22 on PRD acceptance — same npm package and release, separate plugin ID/directory |
| Q-008 | Where does the exact gate command come from when a repository has no `WORKSPACE_PROTOCOL.md`? | Repository owner | decided 2026-09-22 on PRD acceptance — Lead must place it in the complete assignment brief; the runtime never invents one |
| Q-009 | Which Jev endpoint/SDK, secret-setting surface, retention/ZDR contract and pinned model version are acceptable? | Repository owner + Maintainer | deferred — separate Phase 5 design delta; no key or external call in Phases 1–4 |
| Q-010 | What atomic question set, retained evidence and measured thresholds justify moving a sensor from shadow to assist? | Repository owner + Maintainer | deferred — require positive/negative fixtures and real `useful`/`noise`/`unknown` calibration for each pinned model/question version |
| Q-011 | Which small glob library or existing implementation can prove conservative overlap for Phase 2 without introducing a policy language? | Maintainer | deferred — resolve in the Phase 2 design delta, not the Phase 1 plan |
| Q-012 | Should runtime state survive whole-room `remove --apply` through an automatic backup? | Repository owner | decided 2026-09-22 on PRD acceptance — no automatic backup; warn, offer export, then preserve the existing destructive contract |
| Q-013 | Is the minimal Paseo panel required in Phase 1, or may machine-readable status ship first if client API compatibility delays it? | Repository owner | decided 2026-09-22 on PRD acceptance — keep the panel in Phase 1 and treat client incompatibility as a release blocker |
| Q-014 | What exact canonical authority amendment permits Peer to use only the assignment-reporting exception without gaining orchestration or control-plane authority? | Repository owner | resolved 2026-09-22 — the owner authorized and landed the narrow amendment: `AGENTS.md`, `docs/design.md`, `src/roles.ts` (new `ROLE_PEER_REPORTING`, with `ROLE_PASEO_TOOLS.peer` still `false`) and `src/room/prompts/contract/peer.md`. `src/agents/mcp.ts` and `src/agents/resources.ts` were found not to gate this surface and were left unchanged. Exposure remains inert until a runtime plugin exists |

Phase 0 evidence and repository-owner decisions closed Q-001, Q-002, Q-004, Q-006, Q-014, Q-003a and
Q-005, and PRD acceptance settled Q-007, Q-008, Q-012 and Q-013. Q-003b is an open Phase 1 exit
criterion rather than a Phase 0 blocker, because the server semantics it names cannot exist before the
implementation does. With the PRD `Accepted` and this design `Active`, a Phase 1 implementation plan
may be activated. Deferred Q-009 through
Q-011 do not block Phases 0–1 because those phases contain no sensor and no worktree concurrency.

## 16. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-22 | Bytes | Recorded the Phase 1 release qualification on Paseo `0.8.0` across all three exact Peer paths, including two defects it found and the fixes (hoisted plugin entries; operator-owned `provider/model` Peer creation). Q-003b resolved across plugin reload and, after the operator-requested daemon restart, across daemon restart. |
| 2026-09-22 | Repository owner / Bytes | Activated the design after exact-Peer carrier qualification: split Q-003 into resolved Q-003a (carrier feasibility) and open Q-003b (server semantics, now a Phase 1 exit criterion), resolved Q-005 as preview range `>=0.8.0 <0.9.0`, and added the pending-tool-permission state after observing that Claude gates a reporting call while Codex and Pi do not. |
| 2026-09-22 | Repository owner | Recorded PRD acceptance: the requirements source is now Accepted, and carried answers Q-007, Q-008, Q-012 and Q-013 became design decisions. This design stays Draft until Q-003 and Q-005 close. |
| 2026-09-22 | Repository owner / Bytes | Resolved Q-014 by authorizing and landing the narrow reporting amendment in `AGENTS.md`, `docs/design.md`, `src/roles.ts` and the Peer contract; added `ROLE_PEER_REPORTING` separate from `ROLE_PASEO_TOOLS`, left `src/agents/mcp.ts` and `src/agents/resources.ts` unchanged as unrelated to this surface, and recorded the contract digest change. |
| 2026-09-22 | Repository owner / Bytes | Approved a PRD/design-only pivot to a narrow assignment-scoped `ask`/`handoff` reporter; reopened Q-003, removed strict-final/model-policy v1 from the normative architecture, retained those probes as comparative evidence, and added blocking authority gate Q-014. |
| 2026-09-22 | Repository owner / Bytes | Previously resolved Q-003 with model-policy v1; superseded by the later reporting-tool pivot. |
| 2026-09-22 | Repository owner / Bytes | Resolved Q-004 by requiring every runtime-managed writable handoff to be a clean immutable Git commit; no source-snapshot alternative was added. |
| 2026-09-22 | Bytes | Recorded the first live Paseo `0.8.0` qualification, provisional binding, two-step dispatch, projected-message and archive/panel evidence; its strict-output blocker analysis was superseded by the reporting-tool pivot. |
| 2026-09-21 | Bytes | Revised after adversarial review: made writer ownership and closure independent from assignment decisions, required clean-base dispatch and work-kind-specific handoffs, restored the Peer gate and destructive-remove contracts, versioned every event payload, specified gate process/recovery boundaries, and placed selective Jev attention behind deterministic Phase 3 routing and a separate Phase 5 approval. |
| 2026-09-21 | Bytes | Created Draft with an opt-in plugin boundary, immutable event model, Lead/Supervisor action bridge, schema-bound tool-free Peer result, stable-commit handoff, gate provenance, conservative recovery, and worktree concurrency deferred behind a Phase 2 approval gate; the tool-free result carrier was superseded on 2026-09-22. |
