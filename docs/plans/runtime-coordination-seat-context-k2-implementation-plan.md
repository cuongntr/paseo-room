# Paseo Room Runtime Coordination — Seat Context K2 Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Routing decision | [Seat context delta routing decision](../design/runtime-coordination-seat-context.md#routing-decision): brownfield; plan → implement, one plan per phase; §11.2 qualification is each phase's release gate |
| Source PRD / requirements | [Runtime Coordination PRD](../product/runtime-coordination-prd.md), amended 2026-09-26: REQ-028 (replace a project Lead with a reviewed handoff) |
| Source Technical Design | [Seat context delta](../design/runtime-coordination-seat-context.md) — Active 2026-09-26; K1 shipped in `3f45f95` |
| Related ADRs | N/A — no ADR directory exists. No contract asset changes in K2; two new runtime prompt assets grant nothing (§2, *Model-facing text*). |
| Phase | K2: Replace Lead — the K-D5 state machine, its RPCs, handoff storage and the panel flow |
| Execution | Direct, in work-package order; no Beads |

## 1. MVP-Lock

- **In:**
  - delta K-D5 (the succession protocol), K-D7 (handoffs as local records), §5.1 `succession` on
    `runtime.room`, §5.2 succession RPCs, §5.4 log records, §6 model-facing text;
  - delta §8.2 (*Replace Lead…* on the Lead row, *Finish replacing Lead*) and §8.3 (the Replace Lead
    modal), and *Replace Lead…* on a `context-high` incident (K-D6);
  - the three refinements of §2 marked **Refinement**, each from a Paseo fact or a dead end found
    while planning;
  - the D4 Human row, `runtime-panel-ux.md` and the README amended for what K2 ships.
- **Out:**
  - choosing another provider for the successor (Q-K05);
  - exporting handoffs (Q-K03);
  - K3 resilience options and K4 automatic succession;
  - Supervisor succession;
  - any contract asset, Peer or Supervisor tool change.
- **Exit criteria:**
  1. every work-package exit condition below holds;
  2. `npm run verify` passes the complete chain;
  3. installed on this machine, and at the first succession the Human runs, Q-C5, Q-C6 and Q-C1
     (the successor's environment) are recorded in the delta's §11.2;
  4. the delta, D4, the panel UX doc and the README record what shipped.
- **Default checkpoint posture:**
  - *Replace Lead…* is available to the Human on every live room Lead; nothing starts one
    automatically.
  - **Containment:** do not start one. A succession waiting after its archive can be finished or
    cancelled from the project screen. Or disable the plugin.
  - **Rollback:** reinstall the previous package. It ignores `attention/successions/`. Finish or
    cancel a waiting succession first; otherwise the project is left without a Lead, which the
    previous package's *Start Lead* fixes.

## 2. Settled Implementation Decisions

| Decision | Resolution | Basis |
|---|---|---|
| Module | `server/attention/succession.ts` (new) holds the K-D5 state machine. It runs on its own lane, one step at a time across all successions. It reads Observer facts through `attention.run`, never holding the attention lane across a Paseo call whose events that lane processes. It calls Paseo only through `paseo-port.ts`, and reads a project's ledger through `Controller` inside that project's queue. It is wired in `server/context.ts`, answers the RPCs in `rpc.ts`, and is told of turn ends in `index.server.ts`. | Delta §3; the attention lane processes the `created` and `archived` events a succession causes |
| Records | `runtime/v1/attention/successions/<id>.json`, replaced atomically, beside `<id>.handoff.md`, both mode `0600`, where `<id>` is `suc_` and 16 random base64url characters.<br>The record holds `id`, `projectKey`, `root`, `fromAgentId`, `fromTitle`, `provider`, `supervisorAgentId` (or null), `reason`, `note?`, `step`, `toAgentId?`, `receivedBytes?`, `failure?`, `createdAt` and `updatedAt`.<br>This refines K-D7's `handoffs/<project id>/`: a project without a runtime ledger has no project id, and the record names its project.<br>The engine's start prunes, with the log, terminal records and their handoffs not updated for 30 days; a waiting one is kept. | K-D7; attention A-D8 |
| Steps | `requested → received → archived → created → completed`.<br>• `cancelled` is reached from `requested`, `received` or `archived`.<br>• `failed` is reached only before the archive: an unusable handoff.<br>Each step's record is written after its Paseo effect, and every effect repeats safely:<br>• archiving an archived agent returns its time;<br>• the successor's creation key `succession-<id>` replays Paseo's receipt;<br>• the kickoff's message id is checked with `promptDelivered` before a resend.<br>A retry after a crash or reload therefore repeats at most the last call, never its effect. | K-D5 idempotency and resume |
| Preflight | Answers blockers, notes, descendants, the Supervisor and the successor.<br>**Blockers,** each with a code:<br>• not a live room Lead of an observed project (`lead_unknown`);<br>• not idle or closed (`lead_busy`);<br>• an assignment it leads that is not `settled` (`assignments_open`);<br>• an undelivered runtime notice addressed to it (`notices_pending`);<br>• a descendant running or on a permission (`descendants_running`);<br>• a succession of the project not yet terminal (`step_conflict`);<br>• no model for its provider (`model_unavailable`).<br>**Notes,** which do not block:<br>• retained worktrees of settled assignments, which stay for the Human to close;<br>• a context within 5 points of the Lead's compact mark, where the handoff turn may itself compact.<br>**Also answered:** each descendant with its fate (below), the Supervisor the successor gets, and the successor's provider and model. | K-D5 step 1 |
| Descendants | **Refinement.** Paseo 0.9.2 archives a live agent's children with it, recursively. It detaches, clearing the parent label of, a child in another workspace or open in a client tab (`S/agent/agent-manager.js` `cascadeArchiveChildren`, `shouldDetachFromArchivedParent`).<br>Keeping a same-workspace descendant is therefore not a choice the runtime can offer, and `archiveDescendants` is dropped. The preflight and the confirm step show which seats Paseo archives with the Lead and which it detaches.<br>A detached seat has no parent, so it raises no `peer-orphaned`. A running descendant still blocks: Paseo would either cancel it, or detach it from the Lead waiting on its result. | Paseo source; K-D5 step 4 |
| Handoff request | `[paseo-room succession <id>] `, then the asset `runtime/handoff-request.md`, then the Human's note, if given, as `Human's note: <note>`. It is sent with `send(…, 'steer')` and message id `succession-request-<id>`, so a turn that began after the preflight is steered into and never cancelled. | K-D5 step 2, §6.1; attention §7.4 |
| Reading the handoff | Once the Lead has no active turn, the runtime reads the projected timeline tail of 300 entries, in which Paseo merges a message's streamed chunks. The user entry with the request's message id names the turn; the handoff is that turn's trailing run of assistant entries, joined with a blank line. It is checked at the Lead's turn end and at each `succession-status`, so a lost event or a reload only delays it.<br>Refusals:<br>• `handoff_failed` when the turn failed or was cancelled (Observer), holds an error entry, or is not in the tail;<br>• `handoff_empty` when there is no text;<br>• `handoff_too_large` above 64 KB.<br>No new port method is needed: `recentTimeline` already carries full assistant text. | K-D5 step 2; Q-C5; `S/agent/timeline-projection.js` `mergeAssistantChunks` |
| Recorded, not relayed | `triggerOf` classifies a first message beginning `[paseo-room succession ` as `succession`. `processLeadTurn` records such a turn when it has no marker line, before asking whether Paseo reports it and before any sensor call. Neither the Supervisor nor the sensor ever receives handoff text. A marker line still goes, quoted alone. | K-D5 step 2, K-D7; attention §6.1a |
| Compact mark while handing over | **Refinement.** `compactMarkEnv` sets no mark on a Lead that has a `requested` succession. Sending the request to a closed Lead resumes it; with the mark, a Lead past it would compact before writing its handoff. | K-D3, K-D4 |
| Complete | 1. Re-runs the preflight. Any blocker refuses and nothing is archived; a Supervisor other than the one the Human reviewed refuses with `step_conflict`.<br>2. Archives the Lead.<br>3. Opens Paseo's workspace for the project root, refusing a mismatch as *Start project* does.<br>4. Creates `<name> — Lead` with the predecessor's provider and its room profile's launch, parented to the preflight's Supervisor or to none, with key `succession-<id>`.<br>5. Runs the kickoff with message id `succession-kickoff-<id>`.<br>6. Records `completed` and tells the Supervisor.<br>It writes no portfolio record. | K-D5 steps 4–7 |
| Kickoff | `[paseo-room succession <id>] `, then `kickoff()` from `seat-starter.ts`, which gains a wording for no Supervisor. Then `Your predecessor <title> (<id>) handed over; its handoff follows verbatim.`, the asset `runtime/successor-kickoff.md`, and the reviewed handoff between fixed delimiter lines. The successor's session receives the current carrier contract at creation. | Delta §6.2, K-D4 |
| Finish and cancel | A succession in `archived` or `created` shows *Finish replacing Lead*. `succession-complete` resumes after the recorded step, with the stored or newly edited handoff.<br>**Refinement:** cancel is also accepted in `archived`, while no successor exists. It leaves the project without a Lead and keeps the handoff, and the project offers *Start Lead* again. Otherwise a successor that cannot be created, for example because its model is gone, would block the project.<br>`runtime.start-project` refuses with `succession_pending` while a succession of the project waits. | K-D5 step 7 |
| Supervisor line | A new engine method, `told(projectKey, line)`, enqueues a digest item to the project's Supervisor when letters are on and remembers it for feedback. Example: `cmdb · Lead replaced: cmdb — Lead (8e2e0280) succeeds CMDB - Lead (cb26329e)`. | K-D5 step 5 |
| Model-facing text | Two `section` assets in a new prompt group `runtime`: `runtime/handoff-request.md` (§6.1) and `runtime/successor-kickoff.md` (§6.2). Setup renders them into `server/generated/succession.ts` as it renders the location module. The checked-in placeholder is `undefined`, and without it every succession RPC answers `succession_unavailable`. Neither text grants a tool or authority. `contractDigest` covers only role instructions, so no seat is reported as running an old contract. | Delta §6; AGENTS.md "Working on the role contract" |
| RPCs | Each mutating RPC takes an `idempotencyKey`:<br>• `runtime.succession-preflight { leadAgentId }`;<br>• `runtime.succession-start { leadAgentId, reason: 'context' \| 'contract' \| 'other', note? (1 KB), idempotencyKey }`, answering `{ successionId }`;<br>• `runtime.succession-status { successionId }`, answering the step, the handoff once received, `receivedBytes`, the successor and any failure;<br>• `runtime.succession-complete { successionId, handoff (64 KB), idempotencyKey }`;<br>• `runtime.succession-cancel { successionId, idempotencyKey }`.<br>Refusal codes: the delta's list plus `lead_unknown`, `notices_pending`, `model_unavailable`, `workspace_mismatch`, `handoff_too_large`, `succession_unavailable`, and `succession_pending` on `start-project`. | Delta §5.2, refined by the rows above |
| `runtime.room` | Each project gains `succession?: { id, step, fromAgentId, fromTitle, canFinish, canCancel, failure? }` for its non-terminal succession. | Delta §5.1 |
| Log | `succession.started`, `.handoff-received`, `.archived`, `.created`, `.delivered`, `.completed`, `.cancelled` and `.failed`. Each carries `{ successionId, projectKey, fromAgentId, toAgentId?, reason, step, bytes? }` and never handoff text. | Delta §5.4 |
| Panel | • *Replace Lead…* on the Lead row of the project screen and on a `context-high` incident.<br>• *Finish replacing Lead* in place of *Start Lead* while a succession waits.<br>• `client/succession.tsx` (new) holds the three-step modal of §8.3.<br>&nbsp;&nbsp;– Step 1: reason, note, the preflight's blockers and notes, and the descendants' fates.<br>&nbsp;&nbsp;– Step 2: *Ask the Lead for a handoff*, polling `succession-status`, then the handoff in an editable monospace field with its size in KB.<br>&nbsp;&nbsp;– Step 3: the summary and *Replace Lead*, then *Open new Lead*.<br>• Reopening the modal on a Lead with a succession in flight resumes at its step. | Delta §8.2, §8.3, K-D6 |

## 3. Work Packages

| WP | Scope | Files | Exit condition |
|---|---|---|---|
| WP-S1 Model-facing text | The two assets, the `runtime` prompt group, the generated module and its placeholder | `src/room/prompts/runtime/*.md` (new), `src/room/prompts.ts`, `src/runtime.ts`, `src/runtime-plugin/server/generated/succession.ts` (new) | Unit:<br>• the rendered module equals the loaded assets;<br>• the request asks for §6.1's eight sections, for verified content only, and for no new work and no Peer;<br>• neither text names a tool;<br>• `contractDigest` is unchanged;<br>• the package inventory lists the assets |
| WP-S2 Records and log | Succession records and handoff files, atomic writes, modes, listing, pruning; log record types | `server/attention/succession.ts`, `server/attention/log.ts`, `server/attention/engine.ts` (prune at start) | Unit:<br>• round trip;<br>• files are `0600`;<br>• a torn temporary file is ignored;<br>• pruning keeps a waiting succession and drops a 31-day-old terminal one |
| WP-S3 Preflight | The blockers, notes, descendant fates, Supervisor and successor launch; the RPC | `server/attention/succession.ts`, `server/rpc.ts`, `shared/rpc-contracts.ts` | Unit, one per blocker and note:<br>• the fates match Paseo's cascade rule for same-workspace, cross-workspace, open-tab and grandchild seats;<br>• a closed Lead is accepted |
| WP-S4 Request and handoff | Start, the request, reading the reply, failure codes, cancel before archive; the Observer trigger and the recorded-not-relayed rule; the compact-mark exemption; the RPCs | `server/attention/succession.ts`, `server/attention/observer.ts`, `server/attention/engine.ts`, `server/hooks.ts`, `index.server.ts`, `server/rpc.ts`, `shared/rpc-contracts.ts` | Unit and fake-Paseo integration:<br>• sent with `steer` and its message id;<br>• the reply is read whole when split into chunks, and only the trailing run after a tool call;<br>• `handoff_failed` for a failed, cancelled or missing turn;<br>• `handoff_empty` and `handoff_too_large`;<br>• read at the turn end, and at status after a simulated reload;<br>• no letter item and no sensor call for the turn, while a marker line still goes;<br>• no compact mark on a resume while `requested` |
| WP-S5 Complete | Re-check, archive, create, kickoff, Supervisor line, finish after failure, cancel after archive, `succession_pending` on `start-project`, the RPCs | `server/attention/succession.ts`, `server/attention/seat-starter.ts`, `server/attention/engine.ts`, `server/rpc.ts`, `shared/rpc-contracts.ts`, `test/runtime-fake-paseo.ts` (cascade archive, workspace creation, receipts) | Fake-Paseo integration:<br>• a full succession: the successor's parent is the Supervisor, its kickoff carries the handoff verbatim, and the portfolio file is unchanged;<br>• a failure after the archive, then *Finish*, creates exactly one successor;<br>• no `duplicate-lead`, `lead-gone-with-work` or `peer-orphaned`;<br>• `message_lead` answers `lead_unavailable` in the gap and reaches the successor after it;<br>• cancel is refused once `created` |
| WP-S6 Panel | `runtime.room` `succession`; *Replace Lead…*, *Finish replacing Lead*, the incident action and the modal | `server/attention/engine.ts`, `server/rpc.ts`, `client/succession.tsx` (new), `client/room.tsx`, `client/model.ts`, `client/views.tsx`, `client/data.ts` | • Model-function unit tests for step labels, the preflight checklist and fates, and the handoff's size;<br>• typecheck and build of the client bundle;<br>• the boundary test unchanged |
| WP-S7 Docs and release | D4 Human row; `runtime-panel-ux.md`; README runtime section; the delta's K-D5, K-D7, §5 and §8.3 amended for the refinements; its revision history | docs, `README.md` | Docs name only what K2 ships; `npm run verify` passes |

Order: WP-S1 → WP-S2 → WP-S3 → WP-S4 → WP-S5 → WP-S6 → WP-S7. WP-S1 is independent and may go
later.

## 4. Qualification after install

1. `setup --agent claude --runtime --no-claude-memory-contract --apply`, then `verify`, as for K1.
   Only runtime plugin files change, and Paseo reloads the plugin without a daemon restart.
2. **Before any succession, with no seat touched:**
   - Call `runtime.succession-complete` with a 64 KB handoff for an unknown succession id. It must
     answer `succession_unknown`, which proves the plugin RPC transport carries the input (Q-C5,
     second part).
3. **At the first succession the Human runs** (the cmdb Lead is the likely first), record:
   - **Q-C5:** the stored handoff equals the Lead's final message in its transcript, byte for byte;
     the kickoff that carried it appears whole in the successor's transcript.
   - **Q-C6:**
     - no `duplicate-lead` or `lead-gone-with-work` in the attention log;
     - the successor's `paseo.parent-agent-id` names the Supervisor;
     - `portfolio.json` is unchanged.
   - **Q-C1:** the successor's `claude` process environment shows
     `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000`.
   - **Handoff fidelity (§11.3):** the discrepancies the successor reports.

   A 64 KB `run` is not exercised on purpose: it would spend a seat's turn. The first handoff above
   8 KB proves the path, and a larger one waits for the owner's go-ahead.

## 5. Risks specific to K2

- **Paseo's archive cascade changes with Paseo.** The descendant fates copy Paseo's rule, so a later
  Paseo could archive what the preflight said it would detach. The rule is read from 0.9.2, within
  the plugin's `<0.10.0` range; a Paseo upgrade re-reads it.
- **The handoff turn can compact.** A Lead within a few points of its compact mark may cross it
  while writing. The preflight notes it, and a Human who replaces at the rotate mark has 20 points
  to spare.
- **A cancelled succession leaves a Lead that was told to start no new work.** The modal says so;
  the Human tells the Lead to continue. The runtime prompts no seat on its own.
- **A stale timeline read.** A handoff turn of more than 300 timeline entries hides its own request
  and fails with `handoff_failed`; cancel and ask again. It has not been observed: tool calls
  collapse to one entry each.

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-27 | Bytes | Created Active for K2 of the approved seat context delta, on the owner's instruction to proceed after K1 shipped. Planning found that Paseo 0.9.2 archives a Lead's same-workspace descendants with it, so the descendants option is dropped. It adds two more refinements: cancel after the archive, and no compact mark while a Lead writes its handoff. All three go to the delta with WP-S7. |
