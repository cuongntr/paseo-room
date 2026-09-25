# Paseo Room Runtime Coordination — Peer Effort Delta: Lead Chooses Thinking Within the Operator's Envelope

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | Operator request 2026-09-25 (in session), with the cmdb ledger as evidence; [Paseo Room Runtime Coordination PRD](../product/runtime-coordination-prd.md) "Enable runtime coordination" (unchanged for thinking, see Q-E02) |
| Related ADRs | N/A — no ADR directory exists. Governing: [Runtime Coordination Technical Design](runtime-coordination.md) (Active; its launch rule "chooses neither" is amended by §4.2), [design.md](../design.md) §7 "No per-seat model or task routing", canonical contract `src/room/prompts/contract/lead.md` |
| Routing decision | See below |

## Routing Decision
- Variant preset: brownfield
- Triggered risks: canonical-contract authority change (Lead gains a cost-affecting choice); changed consumed contract (`assignment_dispatch` input); persisted-event additions; new host setting
- Required artifacts/gates: this delta [design-ready] → owner approval of §4 and Q-E01–Q-E03 → implementation plan → implementation
- Execution path: plan → implement
- Exceptions: none
- Decided: 2026-09-25 — Repository owner (in session: a fixed disposition-to-thinking table is too rigid, since a Scout does not always need deep thinking; Jev is not to decide)
- Approved: 2026-09-25 — Repository owner (§4 contract amendments, Q-E01–Q-E04 as recommended)

Paseo facts are read from the installed packages: `P/` is `node_modules/@getpaseo/protocol/dist/`.

## 0. Problem

Every runtime-dispatched Peer launches with its room profile's thinking option, and neither the
runtime nor Lead may choose another (runtime-coordination.md: "carries the room profile's `modeId`
and `thinkingOptionId` … and chooses neither"). Evidence from the cmdb ledger (2026-09-24/25):

- 36 assignments, 15 engineer and 21 reviewer, all on `claude-peer`, all at thinking `medium`: the
  room could not spend more on a hard review or less on a well-specified change.
- 7 of the 15 engineer assignments needed rework, 12 reworks in all, one of them four times. Depth
  is not only a cost; too little of it is paid back in review rounds.

A fixed table from disposition to thinking was rejected: effort follows the work, not its label. A
Scout mapping one small module needs little; a Scout entering an unfamiliar legacy subsystem needs
much. A Reviewer of a one-line fix and a Reviewer of a data migration differ the same way. The seat
that knows which case it is, is Lead: it has read the repository and written the brief. An attention
sensor (Jev) was also considered and rejected: it would see only the brief, less than Lead knows, and
it would send briefs off the machine (§2 E-D6).

## 1. Scope

**In:**
- An operator-set **envelope** per room Peer provider: the thinking options Lead may choose from.
- An optional `thinking` choice, with a reason, on `assignment_dispatch`, validated against the
  envelope and the options Paseo lists for the seat's model.
- Recording the chosen and the observed thinking option, so effort can be compared with outcomes.
- The Lead contract sentence that governs the choice.

**Out:**
- **Model choice.** The PRD forbids a runtime model selector; changing that is a PRD amendment
  (Q-E02). Lead still cannot name, change, waive or substitute a Peer's model.
- Any model or sensor deciding effort; any fixed disposition table in code.
- Enforcing the envelope on Peers Lead opens directly with Paseo's own tools; the runtime does not
  see those creates (§4.1 keeps their rule as it is).
- Changing effort after dispatch: rework, answers and follow-ups reuse the same Peer, and a lease
  reclaim reuses the recorded choice.

## 2. Decisions

### E-D1 — The operator sets the envelope; the runtime still chooses nothing
The envelope is Human's material-cost decision, made once per Peer provider in Settings: the set of
thinking options Lead may choose. The profile's own option is always in it and stays the default.
With no envelope configured, the envelope is that one option and behaviour is unchanged.

### E-D2 — Lead chooses per assignment, by the work, with a reason
`assignment_dispatch` takes an optional `thinking` (an option id) and, when it differs from the
profile default, a one-line `thinkingReason`. Omitted, the Peer launches exactly as today.

### E-D3 — The runtime validates; it never substitutes
The Peer's default is its profile's option, else the one Paseo marks as the model's default
(`defaultThinkingOptionId`); naming the default is no choice. Any other choice is accepted only if it
is in the envelope **and** among the `thinkingOptions` Paseo lists for the model the Peer will run
(`P/agent-types.d.ts` `AgentModelDefinition.thinkingOptions`), and is never an option that advertises
automatic task delegation (`ultra`, `ultracode`: the Lead contract's "never select a thinking tier
that advertises automatic task delegation", enforced whatever the envelope says). When Paseo lists no
options for that model, only the default is accepted — the contract's existing "keep the profile
default and never invent an identifier". Anything else is refused before anything is recorded, and
the refusal names the allowed options. The runtime never rounds a choice to a nearby option.

### E-D4 — Choice and observation are recorded
`assignment.dispatch-requested` records the choice and its reason; `binding.published` records the
thinking option the created Peer reports. The pair makes it possible to compare rework and review
outcomes by disposition × thinking later, and lets Supervisor see a hard-to-reverse change reviewed
at low effort. Both are optional fields, so existing ledgers replay unchanged.

### E-D5 — The criteria live in the Lead contract, not in code
Lead chooses by the work's uncertainty and verification burden, not by its disposition name (§4.1).
A repository protocol may narrow the choice further for that repository; it cannot widen the
operator's envelope.

### E-D6 — No sensor in the decision
Jev answers atomic questions over bounded text; "how hard is this work" depends on repository
context it cannot see, and the brief is more sensitive than the Lead excerpts the sensor may send
today. A later delta may run a sensor in shadow as a second opinion on Lead's choice, measured
against the outcomes E-D4 records; it would never choose.

## 3. Mechanism

**Setting.** A host settings document `peer-effort`, version 1:
`{ allowedThinking: { [peerProviderId]: string[] } }`. The *Room seats* settings screen shows, for
each Peer provider a dispatch accepts, the options Paseo lists for its profile model as switches: the
default fixed on, delegating options fixed off, and options saved for an earlier model shown so they
can be turned off. When Paseo gives the plugin no settings storage, the envelope is the default only.

**Dispatch.** After the existing input checks and before anything is recorded: resolve the launch
as today; if `thinking` is present and differs from the launch's option, require `thinkingReason`,
then check the envelope and Paseo's options (E-D3). Refusals: `thinking_not_allowed` (outside the
envelope), `thinking_unsupported` (not an option of this model), `thinking_reason_missing`. The
accepted option replaces `thinkingOptionId` in the create request; `modeId` and `model` are carried
exactly as today.

**Events.** `assignment.dispatch-requested` gains optional `thinking` and `thinkingReason`;
`binding.published` gains optional `thinking`, from the created Peer's snapshot, recorded only when
it fits the event so display evidence never fails a binding. A lease reclaim launches the new Peer on
the choice recorded at dispatch while the envelope and the model still allow it, and otherwise on the
default — decided before `lease.reclaimed` is recorded, since the operator's current cap wins.

**Views.** Every assignment summary — Supervisor's `room_status` included — carries `thinking` with
Lead's `chosen` option and `reason` (absent when the default was kept) and the `observed` option the
Peer reported, so a choice that was never applied shows. The panel's assignment detail shows the same.
The Room panel already shows each seat's live model and thinking.

**Tool text.** `assignment_dispatch` describes `thinking` and `thinkingReason` and defers the choice
to the Lead contract rather than restating it; the Lead tools file lists each Peer provider's allowed,
non-delegating options when the plugin writes it (at start and when the setting changes). A Lead
started before a change learns the current set from a refusal.

## 4. Contract amendments — proposed, require owner approval

### 4.1 `src/room/prompts/contract/lead.md`, "Assignment Vocabulary and Operating Baseline"
Replace:

> Use the exact profile model and thinking defaults of the seat being opened. Only an explicit
> repository routing rule changes them, and a decision with material cost belongs to Human.

with:

> Use the exact profile model of the seat being opened. For a runtime dispatch you may choose the
> Peer's thinking effort from the options the operator allows for that Peer; the profile's option is
> the default. Choose by the work's uncertainty and verification burden, not by its disposition:
> lower for a well-specified change behind a strong gate, higher for unfamiliar code, an open design
> question, or a review of a change that is hard to reverse. State the reason in the dispatch. The
> allowed options are Human's cost decision; do not work around them. Outside the runtime, only an
> explicit repository routing rule changes the profile defaults.

"Peer Seat Lifecycle" is unchanged: its rule for Peers Lead opens directly still holds. Granted: a
per-assignment thinking choice within the operator's envelope. Unchanged: model identity, every
other launch field, the writer limit, acceptance, and every Supervisor and Peer rule.

### 4.2 `runtime-coordination.md` §3.1, launch rule
"Runtime carries the room profile's `modeId` and `thinkingOptionId` into Peer creation exactly as
the operator set them, and chooses neither" becomes: runtime carries `modeId` and the model exactly,
and the profile's `thinkingOptionId` unless Lead chose another inside the operator's envelope
(this delta); the runtime itself still chooses none of them.

### 4.3 `design.md` §7
"No per-seat model or task routing" gains: the operator may allow Lead a per-assignment thinking
choice for runtime-dispatched Peers; the room still ships no routing table.

## 5. Security and failure

| Risk | Control |
|---|---|
| Lead spends more than intended | The envelope is the ceiling, set by Human; default envelope is the profile option only |
| Lead chooses by habit, not by the work | Reason recorded; Supervisor sees choice and reason; outcomes comparable (E-D4) |
| Paseo renames or drops an option | Validation reads Paseo's live options; a missing option refuses with the allowed set |
| Setting storage unavailable | Envelope falls back to the default option; nothing widens silently |
| Replay of older ledgers | New event fields are optional |

## 6. Testing

- Unit: envelope ∩ Paseo options, each refusal, default-only when Paseo lists none, reason required
  only when the choice differs from the default.
- Integration with the fake Paseo: the create request carries the chosen option; `binding.published`
  records the observed one; a lease reclaim reuses the recorded choice; an older ledger replays.
- Contract: the static instruction test pins §4.1's wording; Supervisor and Peer documents do not
  mention the envelope.
- Live: one dispatch per room Peer provider with a non-default option, confirming the Peer's
  reported thinking in Paseo.

## 7. Rollout

Opt-in by configuration: until the operator allows more than the default, nothing changes. Leads
need a restart to receive §4.1 and the new tool text; Supervisors and Peers need nothing.

## 8. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-E01 | Approve the Lead contract amendment (§4.1): Lead chooses Peer thinking per assignment within the operator's envelope? | Repository owner | resolved 2026-09-25 — approved |
| Q-E02 | Thinking only in this delta, with model choice left to a later PRD amendment? | Repository owner | resolved 2026-09-25 — thinking only; a model choice also amends the PRD's "no model selector" and the model-identity drift checks |
| Q-E03 | Require `thinkingReason` only when the choice differs from the default, or always? | Repository owner | resolved 2026-09-25 — only when it differs |
| Q-E04 | Configure the envelope in the runtime's Settings, or with a setup flag? | Repository owner | resolved 2026-09-25 — Settings: it can change without `setup --apply` and shows Paseo's live options |

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-25 | Bytes | Code review: delegating options are always refused and never offered; the default falls back to the model's own; a reclaim re-validates its recorded choice before recording anything; `binding.published` records thinking only when it fits; summaries carry chosen, reason and observed; Settings lists only dispatchable Peer providers, shows saved options for an earlier model, saves one change at a time and reports an unavailable store; §3's setting shape corrected. |
| 2026-09-25 | Bytes | Implemented: the `peer-effort` host setting and *Thinking Lead may choose* on Room seats, `runtime.peer-effort`, dispatch validation and refusals, the optional event fields, reclaim reuse, the Lead tool text and the §4 amendments. |
| 2026-09-25 | Repository owner / Bytes | Approved §4 and Q-E01–Q-E04 as recommended; made Active. |
| 2026-09-25 | Bytes | Created Draft from the operator's request and the cmdb ledger: an operator-set thinking envelope per Peer provider, Lead's per-assignment choice within it with a recorded reason, validation against Paseo's listed options, and the Lead contract and launch-rule amendments. Model choice and any sensor stay out. |
