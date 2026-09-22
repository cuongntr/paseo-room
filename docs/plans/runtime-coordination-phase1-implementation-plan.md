# Paseo Room Runtime Coordination — Phase 1 MVP Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-22 — Bytes (self-evaluated under the repository owner's instruction to proceed) |
| Owner | Repository owner |
| Routing decision | [PRD routing decision](../product/runtime-coordination-prd.md#routing-decision): brownfield; trusted-plugin boundary, public tool/RPC contract, persistent local state, role authorization, multi-session handoff, phased rollout with weak rollback; PRD → Technical Design → Implementation Plan → Beads |
| Source PRD / requirements | [Paseo Room Runtime Coordination PRD](../product/runtime-coordination-prd.md) — Accepted 2026-09-22 |
| Source Technical Design | [Runtime Coordination Technical Design](../design/runtime-coordination.md) — Active |
| Related ADRs | N/A — no ADR directory exists; governing constraints are [design.md](../design.md), [AGENTS.md](../../AGENTS.md) and the Q-014 amendment (`ROLE_PEER_REPORTING`) |
| Phase | Phase 1 MVP — Runtime spine |

## 1. MVP-Lock

- **In this phase:** PRD REQ-001 through REQ-009, REQ-012, REQ-013 and REQ-015 through REQ-020 for
  **one writer ownership per project in Lead's current project workspace** (Technical Design §13
  "Phase 1 MVP"). Concretely: a separately identified `paseo-room-runtime` plugin; an explicit
  `setup --runtime` choice recorded in the marker; the generated exact-provider room manifest; the
  versioned immutable event store; assignment, reporting-generation, receipt and independent
  writer-ownership state machines; the Supervisor/Lead action bridge and the assignment-scoped Peer
  `ask`/`handoff` bridge; clean-base two-step dispatch; commit-bound candidates; Peer verification
  evidence; the optional/required independent runtime gate; acceptance/rejection/abandon/close;
  conservative restart recovery; `owner`/`operator`/`page` notices with stable IDs; the typed status
  RPC and minimal panel; runtime deselection, explicit export and whole-room removal warnings; and
  coexistence with the Claude carrier.
- **Out of this phase:** REQ-010/REQ-011 (worktree concurrency, write-scope collision, leases/epochs,
  `managed_workspace_close`), REQ-014/REQ-021 (findings catalogue, incidents, deduplication, budgets,
  feedback, Supervisor digests), REQ-022 (any attention sensor or external network call); compaction
  and retention; automatic merge/rebase/push; non-Git assignments; any Lead- or Supervisor-contract
  prose change; any runtime model selector, allowlist or substitution; answering a provider
  permission on a seat's behalf; writing `pluginsEnabled`; a background status patrol; multi-user or
  remote-daemon coordination. Phase 2 needs its own design delta, owner approval and Lead-contract
  amendment (PRD §10).
- **Exit criteria:**
  1. every work-package exit condition below holds;
  2. `npm run verify` passes the complete typecheck → lint → test → build → packed-package chain,
     and a room set up **without** `--runtime` is byte-identical to one produced by v0.5.0 (REQ-002);
  3. **Q-003b closes**: the refusal, idempotency, generation-fencing and receipt-replay matrix passes
     live on exact `codex-peer`, `claude-peer` and `pi-peer` (WP-010);
  4. the R3 rehearsal in Technical Design §14 passes on a real Paseo `0.8.x` daemon;
  5. no second writable dispatch starts in a project before archive plus refreshed `closed` status is
     proven for the prior writer;
  6. the Technical Design and PRD revision histories record Phase 1 completion, and `feature-done`
     passes.
- **Default checkpoint posture:** runtime ships as an opt-in **preview**. Rooms that do not select it
  gain no dependency, file or registration. A failed CLI apply is repaired by running setup again.
  Containment for a faulty runtime is deselection (setup without `--runtime`) once quiescent, which
  unregisters the plugin and **retains** `runtime/` state; rollback is reinstalling the prior package
  version. There is no destructive migration because all runtime state is new; unsupported state is
  preserved and refused, never converted or reset. The single weak-rollback point is persistent
  runtime history, owned by the R3 decision in Technical Design §14 (risk owner: repository owner;
  rehearsal selected).

After activation this scope is frozen. A new tool, event type outside §4 of the design, contract
prose change, or any Phase 2/3 behaviour requires a delta-change rather than an added bead.

## 2. Settled Implementation Decisions

These close choices the design delegated to the plan, so no bead has to invent them.

| Decision | Resolution | Basis |
|---|---|---|
| CLI spelling | `paseo-room setup --runtime`. Like `--agent`, it is a per-run setup choice: setup without it on a room whose marker records runtime is a **deselection** and refuses while runtime state is active/uncertain. `verify`/`remove` read the marker and reject the flag, mirroring `--no-claude-memory-contract`. The wizard gains one explicit opt-in question, default off. | Design §3.1, §10 |
| Marker field | Optional `runtime: { enabled: true, generation, schema: 1 }`; written only when selected, so an unselected room's marker is unchanged. | Design §3.1 |
| Repository source layout | Plugin source lives in `src/runtime-plugin/` with Paseo's layout (`paseo-plugin.json`, `package.json`, `tsconfig.json`, `index.server.ts`, `index.client.tsx`, `server/`, `client/`, `shared/`). The build copies it to `dist/runtime-plugin/`; the CLI writes it to `~/.paseo-room/runtime-plugin/` as managed entries with `generated/room-manifest.json` rendered per room. | Design §3.1; existing carrier pattern in `src/plugin.ts` |
| Plugin dependencies | Only host-supplied specifiers: `@getpaseo/plugin*`, `zod` (server and client) and `react`/`react-native`/`@tanstack/react-query` (client). Paseo `0.8.0`'s compiler keeps exactly these external, so the installed tree needs no `node_modules`. No other import is allowed; a static test enforces it. | Paseo `0.8.0` `plugins/compiler.js`, `plugin-sdk-specifiers.js` |
| Typechecking the plugin | Add exact-pinned devDependencies `@getpaseo/plugin@0.8.0` and the type packages its entries need (`@types/react`, `react-native` types). If the plugin's `@getpaseo/client@0.8.0` peer conflicts with the current `0.8.0-beta.1` dependency, bump `@getpaseo/client` to exact `0.8.0` in the same package and prove the CLI suite unchanged. `npm run typecheck` additionally runs `tsc -p src/runtime-plugin`; ESLint covers the same files. | paseo-plugin skill "Install dependencies locally for typechecking" |
| MCP bridge process | One dependency-free Node ESM script at `runtime-plugin/server/bridge/bridge.mjs`, launched by the provider through the injected MCP entry with the plugin subprocess's `process.execPath`. It speaks MCP JSON-RPC over stdio, advertises the role's fixed tool list, and only relays to the spool; **all** schema, authority and state validation is server-side. It is not imported by `index.server.ts`, so the Paseo compiler never bundles it. | Design §3.4 |
| Paseo handle | Paseo `0.8.0` creates one `PaseoApi` per plugin subprocess but exposes it only through hook, event and RPC contexts, not to `contribute()`. The Paseo port holds the most recently supplied handle for the current subprocess, and drops it on cleanup. Spool work that needs live corroboration waits for a handle and never proceeds, accepts or refuses on local evidence alone. A waiting reporting call returns retryable `report_uncertain` once the bridge's bounded wait ends (see risk R-1). | `plugins/plugin-process.js` in Paseo `0.8.0`; Design §3.3 |
| Export surface | `paseo-room export --out <dir> [--include-gate-output]`. It reads local state only and needs no daemon (PRD availability NFR). Output is schema-filtered, gate tails are omitted by default, and it prints the redaction-limit statement. | Design §10; REQ-015 |
| Supervisor tools in Phase 1 | `room_status` returns the role-filtered status view. `runtime_findings` returns only conditions Phase 1 already derives, each labelled with its evidence class and source event IDs: degraded or paused project, ownership conflict, uncertain effect, missing or uncertain report, awaiting-permission, and a failed notice. It adds no incident, deduplication or feedback (Phase 3). `message_lead` sends one notice to the corroborated Lead through the Paseo port with a stable notice ID. | Design D4, D9, §3.4; REQ-014 deferred |
| Notices in Phase 1 | Only the D9 `record`, `owner` (Lead), `operator` (panel/status) and `page` classes, delivered through the Paseo port with stable notice IDs and at-least-once retry. No incident aggregation, budget or Supervisor digest. | Design D9, §4.4; REQ-007 |

## 3. Work Packages

### WP-001: Runtime plugin skeleton, toolchain and shared versioned contracts

- **Outcome:** A `src/runtime-plugin/` tree that the Paseo compiler accepts. It has a no-op server
  entry and a no-op client entry, and it holds every versioned boundary contract Phase 1 needs, each
  as strict Zod schemas in `shared/` or `server/`: the room manifest V1; the bridge transport
  envelope; the `ask`/`handoff` inputs, including the per-work-kind handoff detail variants; the
  receipt and error outputs; the Lead/Supervisor action inputs; and the RPC request/response/error
  envelopes. The package is also wired into build, typecheck, lint and the packed-package inventory.
- **Requirement / AC coverage:** REQ-016 (explicit discriminators on manifest, bridge, Peer-report
  and RPC schemas); REQ-005 (strict schemas, unknown fields rejected, size/array bounds); REQ-001
  (separate plugin ID/directory).
- **Design refs:** §3.1 layout, §3.2 manifest interface, §3.4 tool schemas and limits, §8.2 RPC
  envelope, §9.2 strict-schema control, §12 "Plugin/package tests".
- **Prerequisites:** none.
- **Sequencing:** toolchain and empty entries first (so `verify` stays green from the start), then
  the contracts, then the package-inventory and import-boundary tests.
- **Risk boundaries / decomposition hints:** Contract schemas are the public surface every later WP
  consumes. Byte limits come straight from §3.4 (64 KiB aggregate, 64 items, 1 B–8 KiB strings,
  16 KiB `verification.command`). Put them in one place, and do not re-derive them in handlers.
- **Exit condition:**
  - `tsc -p src/runtime-plugin` and lint pass.
  - The packed tarball contains the whole `runtime-plugin` tree.
  - A static test proves no plugin module imports anything outside the host-supplied specifier set, and no client module reaches a `node:` import.
  - Schema tests cover acceptance of valid inputs, and rejection of unknown fields, oversize payloads, wrong discriminators and wrong work-kind variants.
  - The manifest schema refuses a `peerReporting` declaration that is broader than the closed tuple `['ask','handoff']`.

### WP-002: CLI provisioning, generated manifest and fail-closed verification

- **Outcome:** `setup --runtime`, `verify` and `remove` own the runtime plugin end to end:
  - they plan its files as managed entries and render `room-manifest.json` from one typed runtime role-policy projection (exact provider IDs, role capabilities, and `peerReporting` only on Peer entries where `ROLE_PEER_REPORTING` is true);
  - they apply the `>=0.8.0 <0.9.0` range and the `pluginsEnabled` precondition, and register or reload `paseo-room-runtime` from the room-owned path;
  - they record the marker field.
  Without `--runtime`, nothing about the room changes.
- **Requirement / AC coverage:** REQ-001, REQ-002, REQ-003 (exact provider identity source),
  REQ-016 (manifest generation), REQ-019 (distinct ID/directory; carrier untouched).
- **Design refs:** D1, §3.1, §3.2, §10 "Existing rooms", §11 rows "plugin unavailable/failed",
  "global plugins disabled", "foreign plugin registration"; existing `src/plugin.ts` and
  `pluginPlan`/`reconcilePlugin` in `src/commands.ts`.
- **Prerequisites:** WP-001, which provides the manifest schema and the final plugin file set.
- **Sequencing:** version floor and `pluginsEnabled` check first, so dry-run is honest; then managed
  entries and manifest rendering; then install/reload/status; then `verify` failure set; then
  `remove` deregistration before room-home deletion. Deselection **quiescence** and export belong to
  WP-009; here, deselection of a room with no runtime state simply unregisters.
- **Risk boundaries / decomposition hints:**
  - Reuse the carrier's plugin-reconciliation shape, but keep a separate ID, path, checks and marker field. A runtime fault must never alter carrier registration or `CLAUDE.md`.
  - `runtime/` is plugin-owned and **preserve-only**: it is never a managed entry, never compared, and never deleted by setup.
  - The manifest contains no path, credential, command, agent ID or assignment ID.
- **Exit condition:**
  - Dry-run writes nothing and lists the plugin files, registration, compatibility result, manifest and reporting-policy generation.
  - Apply installs, and a later apply reloads.
  - `verify` fails for each of: missing, disabled, failed, incompatible range, foreign path, file drift, manifest drift and generation drift.
  - A Codex-only, Claude-only and Pi-only `--runtime` selection each produce a correct manifest.
  - A room set up without `--runtime` matches v0.5.0 output byte for byte, including the marker.
  - `remove --apply` deregisters the runtime plugin before deleting the room home.
  - The carrier's tests pass unchanged with runtime present, absent and failed.

### WP-003: Immutable event store and replay

- **Outcome:** a per-project, append-only event store under `runtime/v1/projects/<slug>-<uuid>/`. It
  has:
  - immutable `meta.json` binding a project through the canonical Git common directory;
  - the closed `RuntimeEventV1` union covering every Phase 1 event type at `payloadVersion: 1`;
  - no-clobber publication (temporary file, fsync, `link()`, retry on `EEXIST`, directory fsync);
  - strict replay that tolerates sequence gaps but refuses sequence reuse, conflicting IDs, unknown types and unsupported payload versions;
  - a degraded/paused project state that preserves evidence;
  - a disposable `cache/`;
  - mode `0600`/`0700` permissions.
- **Requirement / AC coverage:** REQ-006, REQ-016 (event envelope and payload discriminators),
  REQ-017 (writes only under the room home), REQ-012 (durable intents are replayable).
- **Design refs:** §4.1, §4.2, §9.2 file modes, §10 "Runtime schema evolution", §11 rows
  "malformed/unknown event", "crash during event write", "disk full".
- **Prerequisites:** WP-001 (toolchain).
- **Sequencing:** publication primitive and its crash tests first; then envelope/union validation;
  then project identity and layout; then replay and degraded state; then the cache rebuild.
- **Risk boundaries / decomposition hints:**
  - This is the persistent-state boundary. It stores and replays, and decides no assignment semantics.
  - Event payload types are defined here, as data, for every §4.3/§4.4 Phase 1 record, but their transition rules belong to WP-004.
  - If the filesystem lacks the hard-link primitive, the project fails closed. It never falls back to a rename that could clobber.
- **Exit condition:**
  - Simulated kills at every step of a write leave either the prior state or exactly one complete new event.
  - Concurrent writers never overwrite each other.
  - Malformed, unknown-type and unsupported-version files pause only their project and are never read as empty.
  - An unknown additive field inside a supported payload is ignored.
  - Deleting `cache/` and replaying yields byte-equivalent derived output.
  - Cold replay of 10,000 events runs within the PRD performance target on a development machine.

### WP-004: Assignment domain, authorization matrix and projections

- **Outcome:** pure reducers and validators over replayed events, covering:
  - assignment creation validation and the §5.1 transition table, including `awaiting-permission` and every `uncertain` exit;
  - reporting generations, and receipt fingerprinting with identical-replay/conflict rules;
  - writer ownership as an independent projection;
  - the writable acceptance rules (red-evidence override, required-rerun gating);
  - the D4 role/capability matrix, applied through one runtime role-policy projection;
  - the D8 evidence class on every status field;
  - role-filtered status views with stable content revisions.
- **Requirement / AC coverage:** REQ-004, REQ-005 (authorization and generation/receipt semantics),
  REQ-008 (acceptance binding rules), REQ-009 (red override, `not-run` refusal), REQ-018,
  REQ-013 (view model and revision).
- **Design refs:** D4, D6 acceptance rules, D7 ownership orthogonality, D8, §3.4 validation order and
  receipt rules, §4.3, §4.4, §5.1, §5.3, §8.2 revision behaviour.
- **Prerequisites:** WP-003, which provides the event union and replay.
- **Sequencing:** capability matrix and creation validation; then the assignment/ownership
  reducers; then reporting generation and receipt logic; then acceptance rules; then status views.
- **Risk boundaries / decomposition hints:**
  - These are pure functions with no I/O, and they are the security-relevant core, so each rule gets negative tests.
  - The capability matrix must derive from the same projection the CLI uses for the manifest (WP-002), not from a second hand-written table.
  - Peer's allowed set is exactly `{ask, handoff}`.
- **Exit condition:**
  - Every cross-role operation in D4 is refused.
  - Creation rejects each missing required field named in REQ-004.
  - Every §5.1 edge and every illegal edge has a test.
  - An identical fingerprint under the same or a new request ID returns the same receipt, and a reused request ID with a different fingerprint returns `report_conflict`.
  - A stale generation is refused without consuming anything.
  - Acceptance requires the candidate, a non-`not-run` Peer gate, a terminal required rerun and a reason, and red evidence also requires an override.
  - Ownership stays `held` through handoff, acceptance, rejection and abandonment.
  - Unchanged state keeps the same revision.

### WP-005: Git evidence port and independent gate runner

- **Outcome:** a Git evidence port that resolves:
  - the canonical root and common directory;
  - `HEAD`;
  - base ancestry;
  - the D5 cleanliness predicate (`status --porcelain=v1 --untracked-files=all`);
  - the normalized `base..candidate` changed-path set.

  It never mutates the repository. Alongside it, a gate runner implements D6 exactly: it records `gate.requested`, runs `/bin/sh -c` in its own process group with stdin closed, applies environment-policy v1, keeps a SHA-256 digest and a bounded 64 KiB masked owner-only tail, escalates timeouts from `SIGTERM` to `SIGKILL` after 5 s, publishes an atomic result sidecar, rechecks the workspace, and records a finished or uncertain result.
- **Requirement / AC coverage:** REQ-008 (clean base, immutable candidate, derived changed paths),
  REQ-009 (gate provenance fields), REQ-017 (source changes only from the agent or the gate command).
- **Design refs:** D5, D6, §4.4 `CandidateRefV1`/`GateResultV1`, §6 "gate run" row, §11 rows
  "dirty/moved dispatch base", "candidate/workspace moves", "gate timeout/plugin restart".
- **Prerequisites:** WP-001 (toolchain). This package is independent of WP-003 and WP-004 except for
  the event payload shapes, which it emits through an injected publisher.
- **Sequencing:** Git port and its temporary-repository tests; then the gate runner's process
  contract; then sidecar recovery.
- **Risk boundaries / decomposition hints:**
  - The gate runner is a privileged local action and a distinct evidence domain. Its environment allowlist and termination behaviour are security tests, not convenience tests.
  - Restart recovery reads only the sidecar and never signals a PID recovered from state.
  - No merge, reset, clean, stash, commit, push or branch deletion appears anywhere.
- **Exit condition:**
  - Temporary-repository tests cover dirty and untracked refusal, moved `HEAD`, non-ancestor candidates, a no-change handoff resolving to the base, and exact changed paths.
  - Gate tests cover pass, fail, signal, timeout with process-group kill, a descendant surviving `SIGTERM`, the sanitized environment (a planted secret variable is absent), a 64 KiB tail bound with a digest over the full output, and restart without a sidecar yielding `uncertain`.

### WP-006: Server controller, Paseo port, recognition, dispatch and recovery

- **Outcome:** the running server plugin. It includes:
  - manifest load and generation check;
  - exact-provider recognition;
  - the `before(agent.create)` hook, which composes only role-scoped env and MCP entries, preserves prior output including the carrier `systemPrompt`, and injects a one-use provisional correlation;
  - `before(agent.session_open)` provisional association;
  - the lifecycle adapter, which treats events as notifications and never as barriers;
  - the Paseo port, the only module calling agent SDK methods, holding the subprocess handle per §2;
  - the controller, which validates and then writes an intent, performs the effect, and writes the result;
  - clean-base **two-step dispatch**: reserve, create without a prompt, refresh and prove identity/parent/workspace/idle/no prior prompt, publish the binding and `held`, open a reporting generation and publish `active`, then `run()`;
  - answer and rework turns;
  - close/archive with writer release only after archive plus refreshed `closed`;
  - duplicate-Lead detection and pause;
  - notice delivery with stable IDs;
  - startup and event-driven recovery of every unresolved intent in §6.
- **Requirement / AC coverage:** REQ-003, REQ-007, REQ-008 (dispatch/release), REQ-012, REQ-018,
  REQ-019 (hook composition in both orders), REQ-020.
- **Design refs:** D1, D3, D5, D7, D9, §3.3, §3.4 binding paragraphs, §5.2, §5.3, §6 table, §11.
- **Prerequisites:** WP-002 (the generated manifest and the capability projection it reads);
  WP-003 and WP-004 (store and domain); WP-005 (Git port and gate runner for `gate_run`).
- **Sequencing:** Paseo port and fake; then recognition and the creation/session-open hooks; then
  dispatch; then answer/rework/close/archive; then recovery per unresolved-intent kind; then
  duplicate-Lead handling and notices.
- **Risk boundaries / decomposition hints:**
  - Each external effect is its own intent/result pair with its own recovery row. Slice along those rows, not along files.
  - A create is never followed by a prompt in the same call.
  - Recovery never adopts an agent by title or cwd, and never resends a prompt blindly.
  - The hook must be order-independent with the carrier. Test both install orders against a fake that composes the two plugins.
- **Exit condition:**
  - Against the fake Paseo port, a crash injected at every intent/result boundary converges to a success, failure or uncertain state that §6 permits.
  - A second writable dispatch is refused until release is proven.
  - Foreign, internal and label-lookalike providers are ignored.
  - Both hook orders preserve the carrier prompt and the runtime entries, and a non-runtime Peer is unchanged.
  - Duplicate Leads pause dispatch and raise a `page` notice.
  - A notice retried after a simulated crash reuses its ID.

### WP-007: Action and Peer reporting bridges over the spool

- **Outcome:**
  - The spool transport: atomic request and reply files under `runtime/v1/spool/`, drained on plugin startup and on filesystem notification, with no periodic polling.
  - The `bridge.mjs` stdio MCP process, which has disjoint tool registries: Supervisor gets `room_status`, `runtime_findings` and `message_lead`; Lead gets the ten `assignment_*`/`gate_run` operations; Peer gets exactly `ask` and `handoff`, with the handoff detail variant advertised to match the bound work kind.
  - Controller handlers that apply the §3.4 validation order, persist the accepted action with its receipt before answering, return versioned receipts and errors, and record `call.refused` evidence.
  - Handling of a turn ending with no report: `peer.report-missing` projects `blocked`, and unresolved persistence produces `peer.report-uncertain`.
  - The `awaiting-permission` hold while a reporting-tool permission is outstanding.
- **Requirement / AC coverage:** REQ-005, REQ-007 (report capture), REQ-012 (receipt replay),
  REQ-018.
- **Design refs:** D4, §3.4 in full (transport, lifetime binding, reporting generation, schemas,
  validation order, receipts, missing/uncertain report, pending permission), §6 rows "Peer reporting
  action" and "reporting-tool permission", §9.2.
- **Prerequisites:** WP-006, which provides the controller, binding records and generation opening.
- **Sequencing:** spool primitive and drain; then `bridge.mjs` with the tool lists; then Peer
  `ask`/`handoff` handlers and receipts; then Lead/Supervisor handlers; then turn-end
  missing/uncertain and permission handling.
- **Risk boundaries / decomposition hints:**
  - The Peer bridge and the Lead/Supervisor bridge share transport but must never share a registry. A test proves a Peer correlation cannot reach any non-Peer operation, even with a forged operation name in the envelope.
  - The bridge embeds its hidden capability; Peer tool input never carries identity.
  - Final prose, fenced JSON and turn completion are never parsed into a report, and there is no repair loop.
  - Handling is driven by the risk R-1 constraint: never accept without live corroboration.
- **Exit condition:**
  - The complete deterministic Q-003b matrix passes against the fake Paseo port: malformed/unknown-field, wrong-kind, failed-precondition, stale-generation, duplicate-identical, reused-ID conflict, misattributed, no-call, a pending then allowed or denied permission, and receipt replay after simulated response loss and plugin restart.
  - Every refusal leaves assignment, ownership and generation unchanged.
  - A Peer's `tools/list` contains exactly `ask` and `handoff`.

### WP-008: Status RPC and minimal operations panel

- **Outcome:** Zod-validated read RPCs: catalog/health, project list, project status and assignment
  detail. Each is role-filtered server-side and carries stable revisions, evidence classes and a
  named recovery action on every degraded or pending state. Operator mutation RPCs (explicit
  recovery/abandon) go through the same controller authorization and require idempotency keys. The
  client contributes one sidebar surface and one workspace panel with the Overview, Project,
  Assignment and Settings/Trust views (§8.1; Attention is Phase 3). The UI uses React Native
  primitives and theme tokens only, and has a compact layout. The panel polls at a bounded interval
  only while visible.
- **Requirement / AC coverage:** REQ-013, REQ-016 (RPC and derived-view schemas), REQ-018
  (role-filtered data), PRD availability NFR (local state readable while Paseo is unreachable, live
  facts labelled stale).
- **Design refs:** D8, §8.1, §8.2, §9.2; Q-006/Q-013 decisions; the paseo-plugin mobile rules.
- **Prerequisites:** WP-004 (status views); WP-006 (controller for mutation RPCs and plugin
  registration).
- **Sequencing:** server read RPCs; then the client surface and panel; then mutation RPCs; then
  the UI smoke.
- **Risk boundaries / decomposition hints:**
  - This is a provider/consumer boundary. The RPC contract in `shared/` is the provider checkpoint, and the client consumes only it.
  - No secret, credential or environment value ever appears in an RPC output.
  - The client imports nothing from `server/`.
- **Exit condition:**
  - RPC schema tests cover unknown-field refusal, error envelopes and revision stability.
  - The unchanged-status RPC meets the PRD's normal 250 ms target on the development machine.
  - The DOM/HTML audit over `client/` is clean.
  - The live smoke in WP-010 shows the panel on wide and compact windows in light and dark themes.

### WP-009: Deselection, export, removal warnings and documentation

- **Outcome:**
  - Setup without `--runtime` on a runtime-enabled room refuses while any assignment, ownership, managed archive, gate or delivery is active or uncertain. Once quiescent, it unregisters the plugin and keeps `runtime/`.
  - `paseo-room export` writes the schema-filtered archive: gate tails are omitted by default, and the redaction-limit statement is printed.
  - Whole-room `remove --apply` reports active or uncertain runtime state and recommends export, then keeps its existing destructive contract unchanged.
  - `README.md`, `docs/design.md` and `AGENTS.md` describe the runtime opt-in, the trust boundary, the preview range, the carrier coexistence, the Claude reporter-permission prompt, and the deselect/export/remove procedure.
- **Requirement / AC coverage:** REQ-015, REQ-017, REQ-002 (documentation of unchanged baseline).
- **Design refs:** D2, §10 "Disable and remove", §14 containment, Q-012 decision; `AGENTS.md` design
  rules for the room-home write boundary and "no transaction machinery".
- **Prerequisites:** WP-002 (CLI plumbing); WP-003/WP-004 (read-only replay and projection to decide
  quiescence and filter the export). Documentation also needs WP-006 through WP-008, so that it
  describes the implemented behaviour.
- **Sequencing:** the quiescence check shared by deselection and the remove warning; then export;
  then documentation last.
- **Risk boundaries / decomposition hints:**
  - The CLI reads runtime state **read-only**, through the same replay code the plugin uses. It never writes, repairs or quarantines runtime events.
  - Documentation keeps the single-source rules: no contract prose is copied into docs.
- **Exit condition:**
  - Deselection is refused for each active/uncertain kind and succeeds once quiescent, with state retained.
  - Export omits gate tails unless `--include-gate-output` is given, and prints the limitation.
  - `remove --apply` warns and then deletes as before.
  - Docs are updated and every link resolves.

### WP-010: Live qualification (Q-003b), R3 rehearsal and release evidence

- **Outcome:** a reproducible live run on Paseo `0.8.x` recording:
  - Q-003b on exact `codex-peer`, `claude-peer` and `pi-peer`, with one real assignment each through dispatch → `ask` → answer → `handoff` → accept → close, plus the refusal/idempotency/generation/receipt-replay cases across plugin reload and daemon restart;
  - the effective-tool check that no Peer receives built-in Paseo tools;
  - the carrier coexistence check in both install orders;
  - the panel check;
  - the full Technical Design §14 R3 rehearsal: reload, disable, daemon restart, unresolved create/delivery, gate termination, deselection, export and whole-room removal.

  The results are recorded as a qualification record in the Technical Design, and Q-003b is closed.
- **Requirement / AC coverage:** PRD §10 Phase 1 exit criteria; REQ-005 and REQ-012 live evidence;
  PRD compatibility NFR.
- **Design refs:** §12 "Phase 0 live compatibility qualification" list (now release evidence), §13
  Phase 1, §14 R3 decision.
- **Prerequisites:** WP-001 through WP-009.
- **Risk boundaries / decomposition hints:**
  - This is manual/operational evidence on the operator's own daemon.
  - It uses disposable repositories and agents, and archives every probe agent.
  - A failed premise returns the design to Review (§13). It never adds a fallback coordinator or a prose parser.
  - It requires the operator's explicit go-ahead before touching the live daemon.
- **Exit condition:**
  - Every matrix row passes, or a failure is recorded and the design is returned to Review.
  - The Technical Design Q-003b row is set to resolved with dated evidence.
  - The PRD and design revision histories are updated.
  - `feature-done` passes.

## 4. Dependencies

| Edge | Producer outcome needed |
|---|---|
| WP-002 → WP-001 | Manifest schema and final plugin file set |
| WP-003 → WP-001 | Plugin toolchain and module boundary |
| WP-004 → WP-003 | Closed event union and replay |
| WP-005 → WP-001 | Toolchain and gate/candidate payload shapes |
| WP-006 → WP-002 | Generated manifest and shared capability projection |
| WP-006 → WP-004 | Assignment/ownership/generation reducers and authorization |
| WP-006 → WP-005 | Git evidence port and gate runner |
| WP-007 → WP-006 | Controller, lifetime binding and generation opening |
| WP-008 → WP-004 | Role-filtered status views and revisions |
| WP-008 → WP-006 | Controller for mutation RPCs; server plugin entry |
| WP-009 → WP-002 | CLI setup/remove plumbing and marker field |
| WP-009 → WP-004 | Read-only projection for quiescence and export filtering |
| WP-009 → WP-008 | Final operator-visible behaviour to document (docs slice only) |
| WP-010 → WP-007, WP-008, WP-009 | Complete Phase 1 product |

The graph is acyclic. WP-002, WP-003 and WP-005 may proceed in parallel after WP-001. WP-004 is
the critical path into WP-006.

## 5. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Paseo `0.8.0` exposes the subprocess `PaseoApi` only through contexts, so after a reload a spool request may arrive before any hook, event or RPC has supplied a handle. | Keep the handle per subprocess (§2). A waiting request is neither accepted nor refused. The bridge returns retryable `report_uncertain` after its bounded wait, and the generation stays open. WP-010 measures how long it takes to obtain a handle after a reload. If that stalls in practice, stop and return to the design, and do not invent a second client connection. |
| R-2 | Claude Peers need an explicit permission approval for the reporter, so an unattended Claude Peer can stall. | This is the designed `awaiting-permission` state. It is surfaced to Lead and the operator, and runtime never auto-approves it. Docs name the exact tool to allow. |
| R-3 | Lead can still create a Peer through native Paseo tools, which bypasses the runtime. | Such a Peer is simply not runtime-managed: it receives no reporter and appears in no assignment. The behaviour is honest and documented, and changing Lead's contract to prefer runtime dispatch is out of scope (it would need a delta-change). |
| R-4 | Adding `@getpaseo/plugin` type dependencies conflicts with the pinned `@getpaseo/client@0.8.0-beta.1`. | Resolve inside WP-001 by pinning the client to exact `0.8.0`. The existing CLI and packed tests are the proof. The baseline daemon floor is unchanged, because it is enforced at run time, not by the library version. |
| R-5 | Scope size: 10 WPs in one phase is above the 8-WP guidance. | The PRD fixes Phase 1 as one releasable spine, and a split would ship an unusable half. Instead, WP-001/002/003/005 are independently verifiable checkpoints, and `verify` stays green after each bead. |
| R-6 | Paseo `0.9.0` is already published, while the range is `<0.9.0`. | This is intended. The preview is bounded and Phase 4 qualifies newer patches. `verify` reports the refusal clearly. |

## 6. Test Strategy

Use Vitest with the repository's existing patterns: real temporary `$HOME` fixtures, fake
executables, a fake daemon client, and real temporary Git repositories. There is no new test
framework. The detailed inventory is Technical Design §12, and each WP's exit condition names the
cases it owns.

- **Unit:** schemas and limits (WP-001); reducers, authorization matrix, receipts and acceptance rules (WP-004).
- **Integration:**
  - store crash boundaries on the real filesystem (WP-003);
  - Git and gate process behaviour in temporary repositories (WP-005);
  - controller, hooks, dispatch and recovery against a fake Paseo port with crash injection at every intent/result boundary (WP-006);
  - the spool/bridge Q-003b matrix, running `bridge.mjs` as a real child process (WP-007);
  - CLI setup/verify/remove/export with the fake daemon (WP-002, WP-009).
- **Package:** the packed tarball contains `runtime-plugin/`, and the plugin imports only host-supplied specifiers (WP-001).
- **Live:** WP-010 only. No test claims model obedience.
- **Coverage:** no numeric target exists in this repository. The bar is that every §12 item and every §11 failure row applicable to Phase 1 has a named test.
- **Gate:** `npm run verify` after every bead. A bead is not closed on a subset of the chain.

## 7. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-003b | Server refusal, idempotency and recovery semantics on every exact provider path | Maintainer | open — Phase 1 exit criterion, closed by WP-010; the deterministic half is WP-007's exit |

No other open question affects Phase 1 scope. Q-009 through Q-011 are deferred to Phases 2 and 5.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-22 | Bytes | Passed `plan-ready-for-beads` and activated; Phase 1 scope frozen (WP-001–WP-010). Accepted the >8-WP warning under R-5. |
| 2026-09-22 | Bytes | Created Draft from the Accepted PRD and Active design: ten work packages for Phase 1 MVP, settled CLI spelling, source layout, host-supplied plugin dependencies, bridge process, Paseo-handle handling and export surface. |
