# Change Request — Attention (O1–O2) implementation deltas

| Field | Value |
|---|---|
| Change ID | `runtime-coordination-change-003` |
| Short name | Attention implementation deltas |
| Original plan | [runtime-coordination-attention-implementation-plan.md](runtime-coordination-attention-implementation-plan.md) |
| Design | [runtime-coordination-attention.md](../design/runtime-coordination-attention.md) (Active) |
| Status | Applied |
| Owner | Repository owner |
| Created | 2026-09-24 |
| Accepted | 2026-09-24 — repository owner, on review |
| Applied | 2026-09-24 |

## 1. Change summary

The frozen attention plan was executed through WP-A1–WP-A9. Live qualification on an isolated Paseo
`0.9.1` daemon and a second reading of Paseo's source found eight places where the Active delta could
not be carried out as written. None adds a tool, an event type, a role capability or contract prose
beyond the approved §9, and none changes what reaches a Supervisor or why. They are recorded here
instead of by editing the Active plan, and the delta cites this document where it changed.

## 2. Compelling reason

Each item was forced by Paseo `0.9.1` behaviour, observed live or read from its source (`S/` is
`@getpaseo/server/dist/server/server/`). Items D-1, D-2 and D-3 would have made the feature wrong
in production: a Supervisor relayed every Lead turn it had prompted itself, a Lead's first file edit
marked every later turn as a write, and a Human-started Lead sat in its Supervisor's directory.

## 3. What changed

| # | Before (delta) | After | Reason |
|---|---|---|---|
| D-1 | §7.3: skip relaying a Lead turn when the Supervisor's timeline holds Paseo's `<paseo-system>` finish envelope for it. | Skip it when the Supervisor's own latest `send_agent_prompt` to that Lead came after the Lead's previous turn ended (or, when the Observer did not see that turn, within 60 s of this turn's start), unless the call opted out with `notifyOnFinish: false` in the background. `TimelineEntry.prompts` carries the target and choice from the tool call's input. | Paseo never records its envelopes: `S/agent/agent-manager.js` drops every `isSystemInjectedEnvelope` user message from dispatch and imported timelines. A read-only check of the operator's 11 Supervisors found no envelope in any timeline. Paseo reports a prompted agent's first following finish to its caller — as the envelope in the background, as the call's result otherwise (`S/agent/tools/paseo-tools.js`). The tool call itself is recorded, with `agentId`, `prompt` and `notifyOnFinish` in its input (observed on the operator's dx-one Supervisor). Q-2 is closed as failed-and-replaced. |
| D-2 | §4: the Observer takes a turn's facts from the `turn_ended` event's timeline. | The Observer reads the turn's own entries back with `recentTimeline` and filters by the event's `turnId`. Without an id or an answer, only items after the timeline's last user message count, and write evidence is kept only when that boundary exists. | `turn_ended` carries the agent's whole timeline: `timelineStore.getItems(agentId)` in `S/agent/agent-manager.js`. Taken as is, a Lead's first edit would mark every later turn as writing, and every turn's trigger would be its very first prompt. Live check: a letter carried exactly the last assistant message of its own turn, with entry turn ids (`foreground-turn-N`) matching the event's. |
| D-3 | §8.2: create the Lead with `cwd` = repository and `parentAgentId` = Supervisor. | Open the repository's Paseo workspace (`workspaces.open({ cwd })`) and create the Lead through that workspace handle, with the Supervisor as parent. A workspace whose directory is not the repository refuses `workspace_mismatch`. | Live: the Lead created by cwd sat in the Supervisor's desk directory. This is the Phase 2 P2-D8 behaviour: a parented child lands in its parent's workspace unless it is created through a workspace handle. After the change, the Lead's `cwd` was the repository and `paseo.parent-agent-id` named the Supervisor (Q-5). |
| D-4 | A-D4: a page "steers into a running turn; it never interrupts." | A page steers after `pageHoldSeconds`. Steering is accepted by the Claude, Codex, Pi and mock providers, except while Claude is compacting, running a slash command, or switching streams; in that case Paseo replaces (interrupts) the turn. A `now` letter or digest still never interrupts, because it waits for idle. Phase 1–2 notices steer under the same caveat. | `steerOrReplaceActiveTurn` in `S/agent/agent-manager.js` falls back to replacing when a provider does not accept the steer (`S/agent/providers/claude/agent.js` `steerActiveTurn`). A page is by definition urgent, so its rare interruption is the accepted cost. Q-3 is qualified from source; a credential-less isolated room cannot hold a turn open. |
| D-5 | §7.2: a page may go while the Supervisor holds a permission, after the hold. | Nothing — page, letter or notice — is sent while the recipient holds a pending permission. | `clearPendingPermissions` is always set on the session send path, and a steer with it calls `denyPendingPermissionsSupersededBySteer`: the pending request is **denied**, not merely cleared (Q-4, from source). |
| D-6 | A-D3: the parentage default reads the project's live Leads. | When no Lead of the project is live, it reads every Lead of the project, archived included. | A Lead archived with work still running (`lead-gone-with-work`, a page) otherwise had no Supervisor and could reach only the panel. |
| D-7 | §6.4: `continuing` with nothing running is `record`, backed by `project-quiet`. | `continuing` is `record` only while a Peer runs or a permission is pending; otherwise it is `digest`. `project-quiet` remains the backstop for the `record` case. | Being conservative is cheap: a Lead that says it continues while nothing runs is what the Human currently has to nudge. |
| D-8 | Plan §2: run the offline evaluation with `--import ./scripts/ts-resolve.mjs` and native type stripping. | `node --experimental-transform-types --no-warnings --import ./scripts/ts-resolve.mjs` (`npm run attention:eval`), with `scripts/**/*.ts` added to `tsconfig.json`. | The runtime's classes use constructor parameter properties, which strip-only mode rejects. |

## 4. Impact

- **Tests:** unit tests cover D-1, D-2, D-3, D-6 and D-7. D-4 and D-5 are covered by the delivery
  hold tests and the notice tests.
- **Qualification record:** delta §13.1.
- **Contract, tools, events, settings and PRD:** unchanged.
- **Open risk:** D-1's 60 s window is a heuristic only when the plugin missed the Lead's previous
  turn, for example right after a reload. A wrong guess costs one duplicate digest line or one
  unrelayed turn. Every page and momentum signal is unaffected, since those are not Lead-turn
  relays.

## 5. Decision

Accepted by the repository owner on 2026-09-24 without amendment. The plan is Archived.
