# Paseo Room Runtime Coordination — Attention Implementation Plan (O1–O2)

| Field | Value |
|---|---|
| Status | Archived |
| Plan-ready | PASS — 2026-09-24 — Bytes (self-evaluated under the repository owner's instruction to proceed to final implementation) |
| Owner | Repository owner |
| Routing decision | [Attention delta routing decision](../design/runtime-coordination-attention.md#routing-decision): brownfield; contract authority change, external egress with a stored secret, new persisted runtime files, new Paseo surfaces, changed consumed contracts; delta → plan → Beads |
| Source PRD / requirements | [Runtime Coordination PRD](../product/runtime-coordination-prd.md), amended 2026-09-24: REQ-013, REQ-014, REQ-021, REQ-022, REQ-023, REQ-024, REQ-025 |
| Source Technical Design | [Attention delta](../design/runtime-coordination-attention.md) — Active 2026-09-24, on the [Runtime Coordination Technical Design](../design/runtime-coordination.md) — Active |
| Related ADRs | N/A — no ADR directory exists; the governing authority change is the approved Supervisor contract amendment (delta §9.3) |
| Phase | O1 (Observer, signals, delivery, portfolio, Human-started seats, notice fix) and O2 (Settings, key, sensor adapter in shadow, offline evaluation) |

## 1. MVP-Lock

- **In:**
  - delta §4–§8 and §11: Observer, the §5 signals, baseline triage, idle-held delivery with digests,
    budget and dedup, the portfolio, Start Supervisor, Start project with preflight, Assign
    Supervisor, the Room view, the §7.4 notice fix, the attention log;
  - the §9.4 Supervisor tool changes;
  - the Room attention settings, the write-only key, the status RPC, the `AttentionSensor` port with
    the System One HTTP adapter, masking, question sets `lead-turn-v1` and `peer-report-v1`, `shadow`
    and `assist` modes gated as §6.4 specifies;
  - the offline evaluation script (§12.3 step 1);
  - live qualification Q-1–Q-6.
- **Out:**
  - operator enablement of assist for any question set (O3: the operator decides after evaluation);
  - the Supervisor notebook and Peer-report assist (O4);
  - Lead or Peer contract or tool changes;
  - any assignment-ledger event type;
  - retention/compaction UI;
  - widening the Paseo range.
- **Exit criteria:**
  1. every work-package exit condition below holds;
  2. `npm run verify` passes the complete chain;
  3. Q-1–Q-6 pass live on an isolated Paseo `0.9.1` daemon, or a failed item is fixed or recorded
     as a delta-change;
  4. a room with the sensor `off` sends nothing off the host (tested);
  5. the delta, Technical Design and PRD record completion.
- **Default checkpoint posture:**
  - Letters default on and the sensor defaults `off`.
  - **Containment:** turn `letters.enabled` off (Supervisor behaviour returns to today's, except the
    notice fix), set the sensor `off`, or disable the plugin.
  - **Rollback:** reinstall the previous package. The attention files are ignored by it and removed
    only by `remove --apply`.
  - **Weak-rollback point:** masked excerpts already sent to the endpoint in `shadow` or `assist`
    cannot be recalled. The owner accepted this on 2026-09-24.

## 2. Settled Implementation Decisions

| Decision | Resolution | Basis |
|---|---|---|
| Module home | `src/runtime-plugin/server/attention/` holds `observer.ts`, `portfolio.ts`, `signals.ts`, `triage.ts`, `delivery.ts`, `log.ts`, `sensor.ts`, `mask.ts`, `questions.ts`, `engine.ts` and `seat-starter.ts`; `shared/attention.ts` holds the settings definition and view types. Only `paseo-port.ts` calls the SDK. | Delta §3; AGENTS.md plugin boundary |
| Detection style | Signals are level-triggered conditions recomputed from Observer facts on every event and on a 30-second sweep; an incident opens when a condition appears and closes when it clears. The only edge-triggered candidates are `lead-turn-ended` and `peer-report`. | Simplest correct form of delta §5 |
| Clock | Every module takes `now(): Date`; tests drive a fake clock and call `sweep()` directly. | Deterministic tests |
| Paseo port additions | `send(agentId, text, messageId, behavior: 'steer')` passes `activeTurnBehavior` through `agents.ref().send` options; `recentTimeline(agentId, limit)` returns `{type, text, timestamp, turnId}`; `AgentSnapshot` gains `title` and `parentAgentId` (from the parent label); `CreateAgentInput.parentAgentId` becomes optional. | Delta §7.4; `C/index.js` |
| Notice fix | `Notices.deliver` holds while the recipient has a pending permission (the notice stays `pending`) and otherwise sends with `steer`; the engine retries a project's pending notices on that recipient's `permission_resolved` or `turn_ended`. | Delta §7.4 |
| Project key | Canonical Git common directory from `GitEvidence.identity`, else the canonical cwd; the display name is the basename of the canonical root. | Delta A-D1 |
| Duplicate Lead | The Observer raises `duplicate-lead` only for projects without a runtime ledger store; a ledger project keeps `checkLeadOwnership`, whose page now goes to the project's Supervisor. | Avoids two pages for one condition |
| Portfolio file | `runtime/v1/attention/portfolio.json`, `{ schema: 1, projects: { [projectKey]: { supervisorAgentId, at } } }`, replaced atomically with mode `0600`. | Delta §11 |
| Log | `runtime/v1/attention/log/YYYY-MM-DD.jsonl`, append-only with mode `0600`; files older than 30 days are deleted at start. | Delta §11, A-D8 |
| Letters | The id is `att_` + 12 base64url characters and is also the `messageId`. There is one queue per Supervisor, held in memory, so a reload drops held letters and their conditions re-fire. | Delta §7 |
| Settings | `defineSettings({ id: 'attention', scope: 'host', version: 1 })` in `shared/attention.ts` with Zod defaults. `registerSettings` failure falls back to the defaults, and status reports `settingsAvailable: false`. | Delta §8.3 |
| Key | RPC `runtime.attention-key` with `{ set }` or `{ clear: true }` returns `{ configured }`. The key is stored at `runtime/v1/secrets/attention-key` (mode `0600`). `PASEO_ROOM_ATTENTION_KEY` is the fallback. | Delta A-D7 |
| Sensor HTTP | `fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer …', 'content-type': 'application/json' }, body, signal })`, with a timeout from settings and a circuit that opens after 5 consecutive failures for 10 minutes. | Delta §6.5 |
| Supervisor tools | `SUPERVISOR_OPERATIONS` gains `attention_feedback`. `message_lead` gains an optional `project`: a ledger project id, a project key, or a repository name. `room_status` and `runtime_findings` add `observed`/`incidents` filtered to the caller's portfolio. | Delta §9.4 |
| Seat start | Launch settings come from `resolveLaunch(provider)` (the room profile). Start Supervisor calls `createAgent` without a parent. Start project calls `createAgent` with `parentAgentId` = Supervisor, then `send` with the kickoff text. Both RPCs carry an idempotency key. | Delta §8.1–§8.2 |
| Offline evaluation | `scripts/attention-eval.ts` is run with `node --import ./scripts/ts-resolve.mjs`. The resolve hook maps `.js` to `.ts`, and type stripping is native on Node 24. It reuses `mask.ts` and `questions.ts`. `--dry-run` makes no call. The script is not shipped. | Delta §12.3 |

## 3. Work Packages

### WP-A1: Approved documents and Supervisor contract amendment

- **Outcome:** the delta is Active and the PRD and Technical Design are amended. `supervisor.md`
  carries the portfolio paragraph and the "Momentum and Attention Letters" section, and the static
  contract tests cover both.
- **Design refs:** delta §9.1–§9.3, §10.
- **Exit condition:**
  - heading and content tests pass;
  - `npm run verify` is green.

### WP-A2: Paseo port additions and notice delivery fix

- **Outcome:**
  - the port additions of §2;
  - `Notices.deliver` steers and holds on a pending permission;
  - the fake Paseo models busy, steer, a pending permission cleared by an interrupting send, timeline
    entries and optional parents.
- **Design refs:** delta A-D4, §7.4.
- **Risk boundaries:** Phase 1–2 notice semantics stay the same except for how the notice is sent.
  Peer dispatch's first `run` is unchanged, since its recipient is always idle.
- **Exit condition:**
  - a notice to a running Lead is sent with `steer`;
  - a notice to a Lead holding a permission is not sent, stays pending, and is delivered after the
    permission resolves;
  - the existing notice and recovery tests pass.

### WP-A3: Observer and portfolio

- **Outcome:**
  - `Observer` rebuilds from `listAgents` and updates from the six lifecycle events, keeping the §4
    facts;
  - `Portfolio` persists explicit assignments and resolves each project's Supervisor by A-D3.
- **Design refs:** delta A-D1, A-D3, §4.
- **Exit condition:**
  - unit tests cover rebuild, each event's effect, project keys (Git, non-Git, linked worktree →
    same project), write evidence from `edit`/`write` details, trigger classification (envelope,
    runtime letter, message), portfolio precedence, and a stale parent that is not a live Supervisor.

### WP-A4: Signals, triage, delivery, log and engine

- **Outcome:**
  - the §5 signals as level-triggered conditions;
  - the `lead-turn-ended` path with the §7.3 envelope check;
  - baseline triage (§6.1);
  - delivery (§7.2) with idle hold, page steer after the hold, digest coalescing, wake budget,
    dedup and receipts;
  - the log;
  - `AttentionEngine` wired into `index.server.ts` and the lifecycle listeners, with a sweep timer
    disposed on cleanup.
- **Design refs:** delta §5–§7, §11.
- **Exit condition:** fake-clock tests cover each signal opening and closing, and the delivery
  timing cases:
  - a `now` letter waits for idle;
  - a page steers after 60 s;
  - a digest at 15 minutes or at 10 lines;
  - a budget overflow goes to the digest;
  - a repeat updates the incident rather than sending again;
  - a Supervisor-subject signal goes to the panel;
  - no double relay when the envelope is present, and a relay when it is absent;
  - `letters.enabled: false` sends nothing.

### WP-A5: Supervisor tools

- **Outcome:**
  - `attention_feedback`;
  - portfolio-filtered `observed`/`incidents` in `room_status`/`runtime_findings`;
  - `message_lead` with `project`;
  - the policy tuple and manifest, tool descriptions and generated tool file;
  - the duplicate-Lead page to the project's Supervisor.
- **Design refs:** delta §9.4, A-D3.
- **Exit condition:**
  - handler tests cover a portfolio of two projects: message by name, a `project_required` refusal,
    feedback on a foreign incident refused;
  - manifest and tool-file tests list four Supervisor operations;
  - the Lead and Peer lists are unchanged.

### WP-A6: Room RPCs and panel

- **Outcome:**
  - `runtime.room`, `runtime.start-supervisor`, `runtime.project-preflight`, `runtime.start-project`,
    `runtime.assign-supervisor` and `runtime.incident-feedback`;
  - the Room view with seat trees, incidents and forms;
  - the Trust text reflects the sensor mode.
- **Design refs:** delta §8.1, §8.2, §8.4.
- **Risk boundaries:**
  - start actions refuse an unknown or wrong-role provider, a non-existent or Git directory for a
    Supervisor, and a project with a live Lead;
  - no directory is created;
  - the client imports no server code.
- **Exit condition:**
  - RPC tests cover each refusal, the kickoff text, the portfolio record, idempotent replay and
    feedback;
  - the boundary test passes.

### WP-A7: Settings, key and sensor (shadow and gated assist)

- **Outcome:**
  - the settings definition and its fallback;
  - the key RPC and store;
  - the status RPC;
  - `AttentionSensor` with the System One HTTP adapter, masking and both question sets;
  - triage consults the sensor in `shadow` (recorded only) and in `assist` (applied only for question
    sets listed in `assistQuestionSets`, per §6.4);
  - `assessment.recorded` entries;
  - the "Room attention" settings screen.
- **Design refs:** delta A-D5–A-D7, §6.2–§6.5, §8.3.
- **Risk boundaries:**
  - no request is made unless the mode is not `off`, a key exists and `egressAcknowledgedHost`
    matches the endpoint host (loopback excepted);
  - the key never appears in any RPC answer, log line or export;
  - a model-id mismatch counts as no answer.
- **Exit condition:**
  - masking corpora tests;
  - a local HTTP stub test for answers, timeout, 429, wrong model and the circuit breaker;
  - consent refusal;
  - sensor `off` issues zero fetches;
  - assist tables with a confidence floor;
  - the key round-trip answers only `configured`.

### WP-A8: Offline evaluation script

- **Outcome:** `scripts/attention-eval.ts` reads Claude role-home Lead transcripts, extracts
  end-of-turn Lead messages, labels each by what followed it, masks it with the production masking,
  and either prints a dry-run summary or calls the configured endpoint and writes a JSONL report and
  a per-label summary. The report is split by language (Vietnamese diacritics present or not).
- **Design refs:** delta §12.3 step 1.
- **Exit condition:**
  - `--dry-run` runs against the operator's transcripts read-only and prints counts;
  - a unit test covers candidate extraction and labelling on a fixture transcript.

### WP-A9: Live qualification, documentation and closure

- **Outcome:**
  - Q-1–Q-6 run on an isolated Paseo `0.9.1` daemon (its own `HOME`, `PASEO_HOME` and port),
    recorded in delta §13;
  - README, AGENTS.md and design.md describe the Room view, letters, portfolio and sensor settings;
  - the delta, Technical Design and PRD revision rows record completion.
- **Exit condition:**
  - the qualification record exists;
  - `npm run verify` is green;
  - `feature-done` passes.

## 4. Dependencies

| Edge | Producer outcome needed |
|---|---|
| WP-A2 → WP-A3 | port reads (`title`, parent, timeline) |
| WP-A3 → WP-A4 | facts and portfolio |
| WP-A2 → WP-A4 | `send` with `steer`, `recentTimeline` |
| WP-A4 → WP-A5 | engine incidents, feedback and portfolio queries |
| WP-A4 → WP-A6 | engine map and incidents; WP-A3 portfolio for assignment |
| WP-A4 → WP-A7 | triage hook points and the log |
| WP-A7 → WP-A8 | `mask.ts`, `questions.ts` and the adapter |
| WP-A5, WP-A6, WP-A7 → WP-A9 | the complete feature under live test |

WP-A1 has no prerequisite and is complete when this plan activates.

## 5. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R-1 | Letters flood Supervisor. | Idle hold, digest, wake budget and dedup (WP-A4); `letters.enabled` off switch. |
| R-2 | A letter interrupts a Human conversation or kills a permission. | Idle hold and steer only; the notice fix (WP-A2); Q-3, Q-4 live. |
| R-3 | The Paseo envelope format changes and double relays appear. | Harmless duplicate digest lines; Q-2 live. |
| R-4 | Masked text still leaks a secret. | Ordered masking with positive/negative corpora; bounded excerpt; off by default (WP-A7). |
| R-5 | The sensor suppresses a real stall. | Only `continuing` may be lowered to `record`; the `project-quiet` backstop; assist gated per question set by the operator. |
| R-6 | The Observer disagrees with Paseo after a missed event. | Rebuild at start; each sweep refreshes the facts of any seat whose snapshot is older than 5 minutes; unknown facts never fire signals. |
| R-7 | Phase 1–2 regress. | Existing suites unchanged; notice semantics change only in how a notice is sent. |

## 6. Test Strategy

- **Deterministic:** Vitest, one file per area:
  - `runtime-observer`, `runtime-attention-signals`, `runtime-attention-delivery`,
    `runtime-attention-sensor`, `runtime-attention-rpc`;
  - the existing fake Paseo extended; a fake clock.
- **Boundary and package tests** stay green.
- **Live:** WP-A9 on an isolated daemon. Seats use Paseo's built-in `mock` provider where a real
  model turn is not the point, so no credential is needed.
- **Gate:** `npm run verify` before any WP is closed.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-24 | Repository owner / Bytes | Owner accepted [change-003](runtime-coordination-change-003-attention-implementation-deltas.md). All exit criteria hold; `feature-done` passed and the plan is Archived. Assist enablement (O3) and the Supervisor notebook (O4) remain future work. |
| 2026-09-24 | Bytes | Executed WP-A1–WP-A9; every bead is closed. Live qualification is in delta §13.1. Implementation deltas are in [change-003](runtime-coordination-change-003-attention-implementation-deltas.md), awaiting the repository owner's review; the plan stays Active until then. |
| 2026-09-24 | Bytes | Created and activated from the Active attention delta; `plan-ready-for-beads` passed; scope frozen to O1–O2 (WP-A1–WP-A9). |
