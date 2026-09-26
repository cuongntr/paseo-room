# Paseo Room Runtime Coordination — Seat Context K1 Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Routing decision | [Seat context delta routing decision](../design/runtime-coordination-seat-context.md#routing-decision): brownfield; plan → implement, one plan per phase; §11.2 qualification is each phase's release gate |
| Source PRD / requirements | [Runtime Coordination PRD](../product/runtime-coordination-prd.md), amended 2026-09-26: REQ-026, REQ-027, REQ-024 (Start Lead from a project's screen) |
| Source Technical Design | [Seat context delta](../design/runtime-coordination-seat-context.md) — Active 2026-09-26 |
| Related ADRs | N/A — no ADR directory exists. No contract asset changes in K1. |
| Phase | K1: context visibility, `context-high`, settings, Claude compact mark, lean `assignment_status`, Start Lead on the Project screen |
| Execution | Direct, in work-package order; no Beads |

## 1. MVP-Lock

- **In:**
  - delta K-D1 (usage and compactions from Paseo), K-D2 (settings), K-D3 (Claude compact mark at
    session open), K-D6 (`context-high`) and K-D8 (lean `assignment_status`);
  - delta §8.2 (the Lead row's context line and *Start Lead*) and §8.4 (context line on seat rows and
    the role pill, *Add repository*, the Supervisor picker, the *Seat context* settings section);
  - the D4 Human row and `runtime-panel-ux.md` amended for what K1 ships.
- **Out:**
  - everything in K2 (Replace Lead, handoffs, the succession RPCs and log records);
  - K3 resilience options and K4 automation;
  - Codex and Pi enforcement (Q-K04);
  - Supervisor budgets beyond display (Q-K06);
  - Room clutter;
  - any contract asset or Peer change.
- **Exit criteria:**
  1. every work-package exit condition below holds;
  2. `npm run verify` passes the complete chain;
  3. installed on this machine, with Q-C1 and Q-C3 (usage) recorded in the delta's §11.2, and Q-C2
     and the rest of Q-C3 recorded at the first natural compaction;
  4. the delta, D4 and the panel UX doc record what shipped.
- **Default checkpoint posture:**
  - Lead rotate 30%, compact 50%; Supervisor and Peer off.
  - **Containment:** set the Lead's marks to *off* in Settings › Room seats. A compact mark already
    given to an open session stays until that session next opens. Or disable the plugin.
  - **Rollback:** reinstall the previous package. Nothing K1 adds is persisted except the host setting
    `context`, which the previous package ignores.

## 2. Settled Implementation Decisions

| Decision | Resolution | Basis |
|---|---|---|
| Settings | `shared/seat-context.ts`: `defineSettings({ id: 'context', scope: 'host', version: 1 })`, schema as delta §5.3 without `succession`. Percent is an integer 10–95 or `null`; `rotateAtPercent < compactAtPercent` when both are set; schema defaults Lead 30/50, others `null`. Registered in `index.server.ts` like `peer-effort`; without a store the defaults apply. | Delta §5.3; existing settings pattern |
| Percent → tokens | `compactWindow(percent, windowTokens)` returns `floor(percent / 100 × window)` rounded down to a thousand, or `undefined` when the result is below 100,000 or the window is unknown. Pure, and it lives in `shared/seat-context.ts` so the client can show the same figure. | Delta §5.3, K-D2 |
| Which seats get the variable | A seat is eligible when `recognition.recognize(provider)` names manifest `agent: 'claude'`, its role's `compactAtPercent` is set, and a window is known. The `session_open` handler returns `{ ...request, env: { ...request.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW } }`; otherwise it returns `undefined` as today. `handleSessionOpen` correlation runs first and is unchanged. | Delta K-D3; the hook may change only env |
| Model window | At `reason: 'resume' \| 'refresh'`: the agent snapshot's `model`. At `reason: 'create'`: `paseo.resolveLaunch(provider).model`, the provider profile's model. Then `paseo.modelWindow(provider, model)` reads `contextWindowMaxTokens` from `providers.listModels`, matching id or alias and cached per provider for 10 minutes. On any failure, no variable. | Delta §4.1 |
| Usage | `AgentSnapshot` gains `usage: { used: number; max: number } \| null`, from `lastUsage.contextWindowUsedTokens` and `.contextWindowMaxTokens` when both are finite and positive. `cachedInputTokens` is never read. | Delta K-D1; Q-C3 |
| Compactions | `toTimelineEntry` maps a `compaction` item with `status: 'completed'` to `{ kind: 'compaction', trigger, preTokens }`. On turn end the Observer sets `seat.compaction = { lastAt, lastTrigger, lastPreTokens, seen: seen + 1 }` for each one in the turn's entries. | Delta K-D1, §5.1 |
| Usage refresh | On `turn_ended` for a Lead or Supervisor, the Observer re-reads that agent's snapshot (one `getAgent`) before `settle()`, so a crossing is seen at the turn that caused it. Other seats refresh with the existing stale sweep. | Delta K-D6 |
| `context-high` | A level-triggered condition in `signals.ts`:<br>• a live Lead whose `usage.used / usage.max × 100 ≥ rotateAtPercent`;<br>• key `context-high:<leadAgentId>`, level `digest`, subject the Lead;<br>• recipient by the existing rule (project Supervisor, else panel);<br>• text `<Lead label> · context <p>% (<used>k of <max>) — past the <r>% rotation mark`;<br>• evidence the rotate mark itself, so a growing figure updates the open incident's text without reopening it.<br>It clears below the mark or on archive. `KIND_LABEL` gains `Context past rotation mark`. | Delta K-D6; attention §7.2 dedup |
| Lean `assignment_status` | Input gains `full?: boolean`.<br>• By default, one assignment answers the detail view minus `brief` (keeping `brief.outcome` as `outcome`), with `history` cut to the last 10.<br>• The list form answers open assignments that way, and settled ones as `{ id, state, outcome }`.<br>• `full: true` answers exactly today's shapes.<br>• The tool description says so. | Delta K-D8, refined for the list form: a Lead with 43 assignments would otherwise receive 43 whole details |
| Start Lead | *Start Lead* on the Project screen opens `StartLeadModal`: the Lead step of `NewProjectModal`, reused, with the project's root fixed and its Supervisor preselected. It calls `runtime.start-project` unchanged. `NewProjectModal` becomes *Add repository*, and its folder field offers observed projects without a live Lead as one-tap choices. | Delta §5.2, §8.2, §8.4 |
| Supervisor picker | Lists live Supervisors first, with state and folder. It defaults to the project's current Supervisor, else the first live one. Closed ones stay selectable. | Delta §8.4 |
| Context line | `contextLine(seat, budgets)` in `client/model.ts`, for example `context 31% · last compacted 3 h ago (auto, at 498k)`. Its tone is `warning` at the rotate mark, `danger` at the compact mark and neutral otherwise; there is no line when usage is unknown. Used by seat rows, the Lead row and the role pill's *Context* line. | Delta §8.2 |
| Seat context settings | A section in Settings › Room seats, after *Thinking Lead may choose*, built from host Settings controls:<br>• per role, selects for rotate (Lead only) and compact, `off` or 10–95 in 5-point steps;<br>• the converted token figure for 1M and 200k windows;<br>• the notice that a compact mark reaches a seat at its next session open, and that one already past it compacts at its first turn after reopening. | Delta §8.4 |

## 3. Work Packages

| WP | Scope | Files | Exit condition |
|---|---|---|---|
| WP-K1 Settings | `context` settings, the conversion, registration, runtime holder | `shared/seat-context.ts` (new), `index.server.ts`, `server/context.ts` | Unit: defaults, bounds, ordering, the 100k floor, 1M and 200k conversions; the runtime keeps defaults without a store |
| WP-K2 Compact mark | Model window lookup; `session_open` returns the variable for eligible seats | `server/paseo-port.ts`, `index.server.ts`, `server/hooks.ts` | Unit, on fake requests:<br>• exact Claude seat with a mark → variable;<br>• Codex or Pi seat, no mark, or unknown window → no change;<br>• create and resume resolve the model differently;<br>• correlation handling unchanged |
| WP-K3 Usage and compactions | Snapshot usage, compaction timeline entries, Observer facts, `runtime.room` fields | `server/paseo-port.ts`, `server/attention/observer.ts`, `server/attention/engine.ts` (`SeatView`) | Unit and fake-Paseo integration:<br>• usage read on refresh and on a Lead or Supervisor turn end;<br>• a compaction item counted with trigger and pre-tokens;<br>• `runtime.room` carries both |
| WP-K4 `context-high` | Condition, letter line, panel label | `server/attention/signals.ts`, `server/attention/engine.ts`, `client/model.ts` | Integration:<br>• raised once at the crossing, one Supervisor digest line;<br>• updated text without a second line as usage grows;<br>• cleared after a compaction item drops usage, and on archive;<br>• panel only when no Supervisor;<br>• nothing when `rotateAtPercent` is `null` |
| WP-K5 Lean `assignment_status` | Input `full`, lean single and list views, description | `server/contracts/actions.ts`, `server/handlers/actions.ts`, `server/domain/views.ts`, `server/tools.ts` | Unit:<br>• default single view has no `brief`, has `outcome`, at most 10 history entries;<br>• list form lean for open, one-line for settled;<br>• `full: true` byte-equal to today's answer |
| WP-K6 Panel | Context line; Start Lead; Add repository; Supervisor picker; role pill line; Seat context settings | `client/model.ts`, `client/room.tsx`, `client/forms.tsx`, `client/role-pills.tsx`, `client/views.tsx`, `client/context-settings.tsx` (new), `index.client.tsx` if needed | Model-function unit tests for `contextLine` and picker ordering; typecheck and build of the client bundle; the boundary test unchanged |
| WP-K7 Docs and release | D4 Human row; `runtime-panel-ux.md` §4–§6; README runtime section (budgets, context line, Start Lead); delta §11.2 record | docs, `README.md` | Docs name only what K1 ships; `npm run verify` passes |

Order: WP-K1 → WP-K2 → WP-K3 → WP-K4 → WP-K5 → WP-K6 → WP-K7. WP-K5 is independent and may go
first.

## 4. Qualification after install

1. `setup --agent claude --runtime --apply` on this machine, then `verify`.
2. **Q-C1.** A room Claude seat whose session opens after the install carries the variable. For the
   next Lead that opens, read `/proc/<pid>/environ` of its `claude` process, found through
   `PASEO_AGENT_ID`. It should show `CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000`, and the Supervisor's
   should show none. A live seat receives it only at its next open (a restart or a new seat), and
   that is the Human's call.
3. **Q-C3.** `runtime.room` context figures match the transcripts, as already done on 2026-09-26.
4. **Q-C2 and the rest of Q-C3**, at the first natural Lead compaction:
   - the `compaction` item's `preTokens` sits at or below 500k;
   - usage drops to the post-compaction size;
   - `context-high` clears if the figure fell below 30%.

   All three are recorded in the delta.

## 5. Risks specific to K1

- **The trigger point is not documented.** Q-C2 records it. If Claude ignores the variable under
  Paseo, K1 still ships visibility and the signal, and the compact mark is reported as not enforced
  on the settings screen until fixed.
- **One `getAgent` per Lead or Supervisor turn end** adds a read per turn, a few hundred a day. This
  is acceptable, since the stale sweep already reads every seat every 5 minutes.
- **The lean `assignment_status` changes what a running Lead sees on its next call.** The description
  names `full`, and nothing in the Lead contract depends on the brief being echoed.

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | Bytes | Created Active for K1 of the approved seat context delta, on the owner's instruction to proceed. |
