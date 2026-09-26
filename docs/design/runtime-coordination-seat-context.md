# Paseo Room Runtime Coordination — Seat Context Delta: Context Budgets, Lead Succession and Compaction Resilience

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | Operator requests 2026-09-26 (in session): a near-full 1M context and its compaction make a Lead hallucinate, a context budget should be settable in percent, and starting or replacing a Lead from the panel is inconvenient. [Runtime Coordination PRD](../product/runtime-coordination-prd.md), amended by §12 of this delta |
| Related ADRs | N/A — no ADR directory exists. Governing: [Runtime Coordination Technical Design](runtime-coordination.md) (Active; D3, D4, D9), [Attention delta](runtime-coordination-attention.md) (Active; §5, §7, §8.2), [Panel UX](runtime-panel-ux.md) (Active; §4, §5), [Claude carrier](claude-strong-contract-carrier.md) (Q-001), canonical contracts `src/room/prompts/contract/lead.md` ("Project Technical Ownership") and `supervisor.md` ("Lead Discovery and Recovery") |
| Routing decision | See below |

## Routing Decision
- Variant preset: brownfield
- Triggered risks:
  - a new Human-initiated lifecycle operation that archives a Lead and creates its successor through the runtime;
  - launch-environment injection into room seats;
  - new host settings;
  - new persisted runtime state (handoffs and a succession log);
  - consumed-contract changes (`runtime.room` fields, new RPCs, a leaner `assignment_status`);
  - a proposed PRD amendment.
- Required artifacts/gates: this delta [design-ready] → owner decisions on §14 → implementation plan per phase → implementation, with §11.2 qualification as each phase's release gate (Q-C1–Q-C3 for K1, Q-C5–Q-C6 for K2, Q-C4 before K3)
- Execution path: plan → implement, one plan per phase (§13)
- Exceptions: none
- Decided: 2026-09-26 — Repository owner (in session: design properly and evaluate thoroughly before any code)
- Owner decisions: 2026-09-26 — Repository owner, on §14:
  - Q-K01: Lead compacts at 50%, not 40%;
  - Q-K02: the Supervisor receives the `context-high` line;
  - Q-K03: handoffs are not exported for now;
  - Q-K04: Codex and Pi enforcement goes to a later delta;
  - Q-K05: choosing another provider is accepted but deferred beyond K2;
  - Q-K06: Supervisor stays out of this delta.
- Approved: 2026-09-26 — Repository owner, after a fresh-eyes review of this delta
- Supersedes: none

Paseo facts are read from the installed `0.9.2` packages. `S/` is `@getpaseo/server/dist/server/server/`
under the global `@getpaseo/cli` install; `P/` is `node_modules/@getpaseo/protocol/dist/` in this
repository. Claude Code facts come from the `2.1.283` binary the room seats run
(`~/.local/bin/claude`) and from the official documentation where cited. Reading source is not
qualification; §11.2 lists what a running daemon must confirm.

## 0. Problem

A Lead is a long-lived seat. It owns one project across turns and days, while every call re-reads its
whole context. Evidence from this operator's role homes, 2026-09-10 to 2026-09-26: 39 Lead and 18
Supervisor Claude sessions on Opus.

| Observation | Evidence |
|---|---|
| Leads run far into the window | 12 of 39 Leads peaked above 500k tokens, and 4 above 900k (cmdb 944k, xOne 966k, dx-one 934k, kernel 927k). 3 Supervisors peaked above 500k. |
| Automatic compaction happens only at the very end | The xOne Lead compacted automatically at 965k. The cmdb Lead's 3 compactions (381k, 524k, 943k) were all manual `/compact` by the Human. |
| A busy Lead fills fast | Starting from a fresh or compacted 25–50k, the cmdb Lead reached 300k in 1.6–3.1 hours of work and 500k in 3.7–4.4 hours. |
| What fills a Lead is mostly its own shell work | Bash calls and their results are about 46% of the cmdb Lead's content (702 calls) and 74% of the xOne Lead's (1,087 calls). |
| The room's own tools add avoidable bulk | `assignment_status` answered 33 times with a median 10.7 KB. In its largest answer, 64% was the brief Lead itself had written. Paseo's `get_agent_status` added 8.5 KB per call, 36 times. |
| Cost follows context size | Average context per call: cmdb 358k (1,050 calls), xOne 400k, dx-one 528k. |
| A handoff to a fresh seat worked | On 2026-09-26 the cmdb Lead wrote an 11 KB handoff; its successor started at 88k after verifying it and found three discrepancies, one of them substantive (the chart template rejects `no-verify`). |
| Replacing a Lead is not supported | That replacement took eight manual steps across three tools (§8.1). The panel refuses a project that still has a Lead, and the start directive is capped at 8 KB. |

The operator reports that a Lead near a full 1M window, and after its compaction, hallucinates
noticeably. Two mechanisms account for it:
- Attention over a very long context is weaker.
- Compaction replaces the conversation with a generic summary, compressing roughly 950k into 50k.
  What falls out is the kind of fact a Lead depends on: a Human decision, a standing constraint, an
  open question, a promise made. The reference model names this failure: "decision bị bỏ quên qua
  compaction/handoff" (deep dive §4.2).

The role contract itself survives compaction. The appended system prompt is recorded once and
reused unchanged ([Agent SDK: modifying system prompts](https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts)).
What is lost is the conversation.

## 1. Scope

**In:**
- Context visibility: each seat's used and maximum context, and its compactions, on the panel.
- A per-role context budget, set in percent of the seat's model window, with two marks:
  - **rotate at**: advisory, Lead only;
  - **compact at**: enforced by the agent's own compaction; Claude only in this delta.
- **Lead succession**: a Human-initiated Replace Lead flow. It asks the current Lead for a structured
  handoff, lets the Human review it, archives the Lead and starts a successor with the handoff.
- **Start Lead** on a project that has none, from the project's own screen.
- A `context-high` attention signal when a Lead passes its rotate mark.
- A leaner `assignment_status`.
- An evaluated, not committed, set of compaction-resilience options (§7).

**Out:**
- Automatic succession without a Human decision (§13 phase K4, separately approved).
- Supervisor succession. It needs the Supervisor notebook (attention O4) and portfolio re-pointing.
- Enforcing budgets for Codex and Pi. Their compaction is configured in files the CLI writes (§4.3);
  this delta shows their context but does not enforce it.
- Changing what Lead delegates. Shell-heavy Leads are a contract and repository-protocol question,
  not a runtime one (§9.4).
- Model-written summaries by the runtime; any change to Peer.

**Invariants kept:**
- Paseo is the only lifecycle control plane (D3). The runtime archives and creates through Paseo,
  on the Human's instruction.
- Code chooses every recipient and class (attention A-D2).
- No seat gains a tool or authority.
- Supervisor still never opens a Lead for freshness (`supervisor.md`).
- The runtime stays opt-in.

## 2. Decisions

### K-D1 — Measure context from Paseo, not from transcripts
Paseo reports `lastUsage.contextWindowUsedTokens` and `contextWindowMaxTokens` per agent
(`P/agent-types.d.ts` `AgentUsage`). For Claude it computes the used figure from the latest
request's input, cache-read, cache-creation and output tokens (`S/agent/providers/claude/agent.js`
`buildStreamUsageEvent`, `buildResultUsage`). A live read on 2026-09-26 returned 119,586 of
1,000,000 for the new cmdb Lead and 404,214 of 1,000,000 for the Supervisor.

`lastUsage.cachedInputTokens` is summed over a turn's calls (798,966 for the same Supervisor), so it
is never used as a context size. Compactions come from Paseo's `compaction` timeline item
(`status`, `trigger: auto | manual`, `preTokens`), which a turn's timeline carries. The Observer reads
both. It persists nothing, as A-D1 requires.

### K-D2 — A budget per role, set in percent, applied in tokens
Settings hold, per role:
- `rotateAtPercent`: Lead only, advisory;
- `compactAtPercent`: enforced where the agent supports it.

Percent is what the operator reasons in. It is converted to tokens against the seat's own model
window at session open, because windows differ (1M and 200k Claude models share providers) and every
agent's knob is in tokens. Defaults, as decided on Q-K01:

| Role | rotate at | compact at | Why |
|---|---|---|---|
| Lead | 30% | 50% | Rotation is the remedy (K-D4). Compaction at 50% is the safety net when the Human does not rotate, and the 20-point gap left the busy cmdb Lead about 1.5–3 hours between the two marks (§0). |
| Supervisor | — | off | It is the Human's conversation partner and at 40% today; compacting it early loses that conversation, and no succession exists for it yet. |
| Peer | — | off | Peers are short-lived; none approached the window. |

A compact mark reaches a seat only when its session next opens (K-D3): at creation, or at a resume
such as after a daemon restart. A live seat keeps the mark it opened with until then. A seat already
past a new compact mark compacts at its first turn after it reopens, and the settings screen says so
before saving. The rotate mark applies at once, since it only reads Paseo's usage figure.

### K-D3 — Claude's compact mark is injected at session open by the runtime
Claude Code reads `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, the same as the `autoCompactWindow` setting: the
window, in tokens, that auto-compaction works against
([model configuration](https://code.claude.com/docs/en/model-config.md)). The 2.1.283 binary reports
it as "Auto-compact window: N tokens (from CLAUDE_CODE_AUTO_COMPACT_WINDOW)", capped by the model.

The runtime already handles `before('agent.session_open')`. That hook may change only the launch
environment (`S/plugins/lifecycle/index.js`), and Paseo overlays it last onto the Claude process
environment, at create and at resume alike (`S/agent/agent-manager.js` `buildLaunchContext`;
`S/agent/providers/claude/agent.js` `buildSdkEnv`). The runtime sets the variable there for an exact
room Claude provider whose role has a compact mark.

Why the runtime and not setup:
- the value lives in a Paseo setting and needs no re-apply;
- it reaches resumed sessions, which a creation hook does not (carrier Q-001, 2026-09-26);
- it touches no operator-owned provider entry.

The exact trigger point inside that window is not documented, so it is measured (Q-C2).

### K-D4 — Succession, not compaction, is the remedy for a Lead
A successor starts from:
- the latest contract;
- the repository's own evidence;
- a handoff the predecessor wrote on request, for a named reader, and the Human reviewed.

A compaction starts from a generic summary written by the degraded context itself. The handoff of
2026-09-26 shows the difference: it was checked against the repository and the cluster, and its
errors surfaced as a list. Succession also delivers a new contract generation to the seat, which
neither a resume nor a compaction does (carrier Q-001).

Succession is a lifecycle decision. It is the Human's:
- the Lead contract ends ownership when "Human closes or reassigns the project";
- Supervisor must "never open another Lead for freshness or convenience".

In this delta the runtime therefore only **suggests** (K-D6) and **executes the Human's
instruction** (K-D5). Automatic succession is phase K4 and needs its own approval.

### K-D5 — The succession protocol
One Human action, *Replace Lead*, runs a guarded sequence in which each step is recorded before the
next. Every step before *archive* can be abandoned and leaves the Lead in place; the handoff turn is
the only trace.

```text
preflight ─▶ request handoff ─▶ Human reviews/edits ─▶ archive old Lead ─▶ create successor ─▶ deliver kickoff+handoff ─▶ done
   │ refuse        │ fail: abort          │ cancel: abort        │ fail: abort           │ fail: "finish" state      │ fail: retry
```

1. **Preflight**, all required. On refusal, show what blocks:
   - the Lead is idle: no active turn, no pending permission;
   - it leads no runtime assignment that is not settled. The ledger binds each assignment to its Lead
     (`controller.ts`: "belongs to another Lead"), so a successor could not act on it;
   - none of its descendants is running or waiting on a permission, which would otherwise page
     `lead-gone-with-work`;
   - no runtime notice to it is pending. A notice stays pending while its recipient holds a
     permission, or after a failed delivery until it is retried (`notices.ts`), and it would reach no
     one once the Lead is archived.

   Preflight also resolves the project's Supervisor (A-D3). The confirm step shows it and step 5
   uses it, so the Human confirms the parent the successor gets.
2. **Request the handoff.** The runtime sends the Lead a fixed request (§6.1) with `run`, and waits
   for the turn to end. It reads the turn's assistant messages whole from the timeline; the Observer
   keeps only a 4,000-character tail. It refuses an empty handoff or one from a failed turn.

   The handoff request and the successor's kickoff are the runtime's own prompts, so the turns they
   start are recorded and not relayed as `lead-turn` items. The Supervisor would otherwise receive the
   handoff's tail as a digest line, and the successor's "waiting" reply. A marker line in either turn
   still goes, as §6.1a of the attention delta requires.
3. **Review.** The Human sees the handoff and may edit or shorten it (bounded at 64 KB). Cancel ends
   the flow and leaves the Lead untouched.
4. **Archive** the Lead, and, when the Human leaves it checked (the default), its idle or closed
   descendants. Otherwise each would raise `peer-orphaned` after `orphanHours`. The Lead is archived
   first so that two live Leads never coexist; coexisting Leads would page `duplicate-lead`.
5. **Create the successor** as Start project does (attention §8.2, change-003 D-3), except that it
   writes no portfolio record:
   - through the repository's workspace handle, with the predecessor's provider (choosing another
     room Lead provider is deferred, Q-K05);
   - parented to the Supervisor resolved at preflight, or to none, in which case the kickoff names no
     Supervisor;
   - titled `<repository> — Lead`.

   The portfolio record, keyed by project, is unchanged.

   The Supervisor receives one digest fact line, for example `cmdb · Lead replaced: cmdb — Lead
   (8e2e0280) succeeds CMDB - Lead (cb26329e)`, so that it knows whom `message_lead` now reaches.
6. **Deliver** one `run` with the kickoff (§6.2) followed by the handoff. The reviewed handoff
   reaches the runtime in `runtime.succession-complete`, whose `handoff` field has its own 64 KB bound
   instead of the 8 KB `boundedString` default. The `run` carries no RPC bound.
7. **Record** `succession.completed` and show the successor. If step 5 or 6 fails after step 4, the
   project shows *Finish replacing Lead* with the stored handoff. Retrying uses the same idempotency
   key and creates no second successor.

Each step's idempotency key derives from the succession id, so a retried RPC or a reload repeats no
effect. A plugin reload mid-flow resumes from the last recorded step.

### K-D6 — `context-high` is a fact, told once per crossing
When a live Lead's used context crosses its rotate mark, the Observer raises `context-high` for that
Lead, at level `digest`:
- the panel shows it, with *Replace Lead…*;
- its Supervisor receives one fact line, for example `cmdb · Lead cmdb — Lead · context 31% (312k of
  1M), past the 30% rotation mark`;
- no advice, per attention §7.4.

It closes when the context falls below the mark (after a compaction) or the Lead is archived.
`rotateAtPercent: null` turns the signal off; *Replace Lead* stays available either way, since it is
the Human's action, not a response to the signal. A
Supervisor may relay the line to Human; its contract gives it no authority to act on it. Supervisors
are never subjects: their context shows on the panel only. The Supervisor line was decided on Q-K02,
because the Human talks to the Supervisor more than to the panel.

### K-D7 — Handoffs are local records, not letters
A handoff routinely carries hosts, addresses and procedures; the one of 2026-09-26 did. So a handoff:
- is stored at `runtime/v1/attention/handoffs/<project id>/<succession id>.md` with mode `0600`;
- is never sent to the sensor;
- is not exported: `paseo-room export` copies only project ledgers (`src/export.ts`), and adding
  handoffs would take an explicit flag (Q-K03);
- is deleted with the attention log's 30-day retention, by the same prune, unless a succession
  still waits on it.

It is not masked. The successor needs it verbatim, and it never leaves the machine.

### K-D8 — `assignment_status` stops echoing the brief
Lead wrote the brief and has it in context. `assignment_status` returns, by default:
- the brief's `outcome` only;
- the state, candidate, verification, gates and the last 10 history entries.

`full: true` returns today's answer: the whole brief and the whole history. The median answer falls
from about 10.7 KB to an estimated 3 KB. This changes a consumed Lead tool contract, but not its
schema version: the fields kept are unchanged. The tool description states the default.

## 3. Architecture

```text
 Paseo daemon ── lifecycle + timeline (compaction items) ──┐      agents.get → lastUsage
                                                           ▼               ▲
 ┌──────────────────────────── paseo-room-runtime (server) ───────────────┼───────────────┐
 │ Observer ──(context, compactions)──▶ Signals: context-high ──▶ Triage/Delivery (digest)│
 │    │                                                                  └▶ panel incident │
 │    ▼                                                                                   │
 │ Succession ── preflight/handoff/archive/create/deliver ──▶ PaseoPort (run, archive,   │
 │    │            (idempotent steps, log + handoff files)      createAgentInWorkspace)   │
 │    ▼                                                                                   │
 │ before(agent.session_open) ── Context settings ──▶ CLAUDE_CODE_AUTO_COMPACT_WINDOW env │
 └────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ RPC: runtime.succession-*, runtime.start-project     ▲ settings "context" v1
        └──────────── client: Project screen (Start Lead, Replace Lead), seat context, Settings
```

| Component | Responsibility |
|---|---|
| `attention/observer.ts` | Adds `context` (`used`, `max`) and `compaction` (`lastAt`, `lastTrigger`, `lastPreTokens`, `seen`) per seat, read on refresh and from turn timelines; derived and not persisted, so `seen` counts only compactions since the runtime started. |
| `attention/signals.ts` | `context-high`, as in K-D6. |
| `attention/succession.ts` (new) | The K-D5 state machine, its log records and handoff files. It calls only `paseo-port.ts`. |
| `hooks.ts` | `session_open` returns the compact-mark environment variable for a matching Claude seat, and nothing otherwise. |
| `shared/seat-context.ts` (new) | Settings schema and the percent-to-token conversion; pure. |
| client | Project screen actions, the seat context line and a "Seat context" settings section (§8). |

Only `server/paseo-port.ts` calls Paseo, as today. It already has `archive(agentId)`, and it gains
`readTurnMessages(agentId, turnId)` and the seat's `lastUsage`.

## 4. Enforcement per agent

### 4.1 Claude
Enforced as described in K-D3. It needs the seat's model window. On a resume the model is the
agent's own; at creation, where no agent record exists yet, it is the provider profile's model. The
runtime then reads that model's `contextWindowMaxTokens` from Paseo's model catalog (1,000,000 or
200,000 per `S/agent/providers/claude/model-manifest.js`), which it already lists for Peer effort. A
model switched mid-session keeps the window it opened with until the next open.

When the window is unknown, the runtime sets nothing and the settings screen says so.
`autoCompactEnabled: false` in an operator's settings is not inherited: the room's role
`settings.json` is minimal and room-owned.

### 4.2 What compaction then does
- Claude compacts inside the smaller window.
- Paseo emits the `compaction` item and sets the used figure to the post-compaction size
  (`buildCompactionUsageEvent`).
- The Observer counts it.

A compaction is still lossy; the budget only bounds how degraded the context is when it happens,
and how much must be compressed.

### 4.3 Codex and Pi (displayed, not enforced)

| Agent | Knob (installed versions) | Written by |
|---|---|---|
| Codex | `model_auto_compact_token_limit` in `config.toml` (present in the installed `codex` binary) | the CLI's role `config.toml` |
| Pi | `compaction.reserveTokens`, compacting when `contextTokens > contextWindow − reserveTokens`, with per-model overrides (`pi-coding-agent` `core/compaction/compaction.js` `shouldCompact`) | the CLI's role `settings.json` |

Neither reads an environment variable for this, so neither can be set at session open. Enforcing
them is a CLI setup change with `verify` drift checks. It is left to a later delta (Q-K04,
decided).

## 5. Data and contracts

### 5.1 `runtime.room` additions (read-only)
- For each seat:
  - `context?: { used: number; max: number; percent: number }`;
  - `compaction?: { lastAt: string; lastTrigger: 'auto' | 'manual'; lastPreTokens?: number; seen: number }`,
    where `seen` counts compactions since the runtime started.
- For each project, `succession?`: the in-flight succession's id, step and whether it can be finished.

### 5.2 New RPCs
Every mutating RPC takes an `idempotencyKey`. All answer the existing `answer()` envelope, and refuse
with codes:
`lead_busy`, `assignments_open`, `descendants_running`, `handoff_empty`, `handoff_failed`,
`succession_unknown`, `step_conflict`.

*Start Lead* on the Project screen needs no new RPC. It calls the existing `runtime.start-project`
with the project's root and the preselected Supervisor.

| RPC | Input | Effect |
|---|---|---|
| `runtime.succession-preflight` | `{ leadAgentId }` | What blocks, the idle descendants, and the successor's Supervisor. |
| `runtime.succession-start` | `{ leadAgentId, reason: 'context' \| 'contract' \| 'other', note? }` | Steps 1–2. Returns a succession id; the handoff arrives asynchronously and is polled. |
| `runtime.succession-status` | `{ successionId }` | Step, handoff text when received, failure. |
| `runtime.succession-complete` | `{ successionId, handoff, archiveDescendants }` | Steps 4–7. |
| `runtime.succession-cancel` | `{ successionId }` | Before step 4 only. |

### 5.3 Settings `context`, version 1
In the host settings store, beside `attention` and `peer-effort`:

```ts
{
  budgets: {
    lead:       { rotateAtPercent: number | null /* 30 */, compactAtPercent: number | null /* 50 */ },
    supervisor: { compactAtPercent: number | null /* null */ },
    peer:       { compactAtPercent: number | null /* null */ },
  },
}
```

Validation:
- percent is an integer in 10–95;
- `rotateAtPercent` is below `compactAtPercent` when both are set;
- a compact mark converted to fewer than 100k tokens is refused, because the documented values of
  `autoCompactWindow` start at 100k. Q-C2 confirms the floor.

Without a settings store, the defaults apply, as for attention.

### 5.4 Log records
Appended to the attention log (A-D8), with no handoff text:
- `succession.started`, `succession.handoff-received`, `succession.archived`, `succession.created`,
  `succession.delivered`, `succession.completed`, `succession.cancelled` and `succession.failed`;
- each carries `{ successionId, projectKey, fromAgentId, toAgentId?, reason, step, bytes? }`.

## 6. Model-facing text

The handoff request is instruction prose of the length this repository keeps in Markdown (AGENTS.md
"Working on the role contract"). It is an asset under `src/room/prompts/runtime/`, generated into the
plugin tree as the carrier's `contract.ts` is. The successor kickoff extends the existing TypeScript
kickoff (`seat-starter.ts`) with one fixed sentence and the handoff.

### 6.1 Handoff request (to the outgoing Lead)
It uses the sections of the 2026-09-26 handoff:
1. goal and roadmap in the Human's words;
2. work-item state;
3. Git state (branches, unpushed commits, retained worktrees, open reviews), and every Peer still
   open with what it holds;
4. Human decisions not yet recorded in the repository, verbatim;
5. open questions for Human;
6. incidents, risks and unkept promises;
7. next steps in order;
8. what to read first.

It says:
- the handoff is for a named successor and will be read verbatim;
- write only what was verified, and mark what is uncertain;
- start no new work and open no Peer.

It grants nothing.

### 6.2 Successor kickoff
The Start project kickoff (attention §8.2), then:
- "Your predecessor <title> (<id>) handed over; its handoff follows verbatim";
- the handoff;
- an instruction to:
  - read the listed files;
  - verify the Git, work-item and runtime state it can reach within authority already granted;
  - report to Human what it confirmed, where the handoff differs and which questions still wait;
  - act only inside the repository until it has reported, and outside it afterwards only as the
    handoff's recorded Human decisions allow.

The Lead contract is unchanged. The successor's authority comes from its contract and the Human
decisions the handoff quotes, which the Human reviewed in step 3.

## 7. Compaction resilience — options, evaluated, not committed

A compaction still happens whenever the Human does not rotate. Four ways to make it lose less:

| Option | Mechanism | Value | Cost and risk | Verdict |
|---|---|---|---|---|
| C1 Compact instructions | A `# Compact instructions` section in role `CLAUDE.md` ([memory](https://code.claude.com/docs/en/memory.md)) telling the summary to keep Human decisions, constraints, open questions and promises verbatim | Medium: steers the one summary that matters | Cheap. It lands only where the room writes `CLAUDE.md`, and this operator runs `--no-claude-memory-contract`. Whether an appended system prompt steers the summary the same way is unknown. | Qualify (Q-C4) and then decide |
| C2 Re-inject after compaction | A room-owned `SessionStart` hook with matcher `compact`, whose `additionalContext` carries the runtime's facts: open assignments, marker lines relayed and still open, last handoff ([hooks guide](https://code.claude.com/docs/en/hooks-guide.md)) | Medium: the facts the runtime holds come back | A room-owned hook command in the minimal role `settings.json` is a new policy surface, and only runtime-known facts come back | Candidate for phase K3 |
| C3 Runtime re-grounding notice | On a `compaction` item for a Lead, the runtime sends a notice with the same facts | Low to medium | No new surface, but it costs a turn and works only after the fact | Fallback if C2 is refused |
| C4 Continuous state file | Lead keeps a project state file current, and C2 re-injects it | High | A new standing duty in the Lead contract, and a file whose place belongs to the repository protocol | Not in this delta; revisit with evidence from K1–K2 |

## 8. Panel

### 8.1 What changes, and why
The 2026-09-26 replacement took eight steps:
1. learning outside the panel that the seats ran an older contract;
2. asking the Lead for a handoff;
3. archiving it in Paseo;
4. looking for the button (labelled "New project", on Room only);
5. retyping the repository path;
6. choosing among three Supervisors all named "Supervisor";
7. finding that the 11 KB handoff exceeds the 8 KB directive;
8. sending it separately.

The workspace panel opens on the Project screen, which has no lifecycle action, and a project whose
Lead is archived offers no way to start one.

### 8.2 Project screen
The Lead row carries:
- a context line, for example `context 31% · last compacted 3 h ago (auto, at 498k)`, coloured at the
  rotate mark (warning) and at the compact mark (danger);
- **Replace Lead…**.

A project with no live Lead shows **Start Lead**, with its Supervisor preselected. It shows **Finish
replacing Lead** instead when a succession is waiting.

### 8.3 Replace Lead modal
Three steps.

1. **Why and preflight.** Reason (context, contract, other), the preflight checklist, and the
   descendants to archive, checked by default.
2. **Handoff.** *Ask the Lead for a handoff* shows the request running and then the text in an
   editable field, with its size.
3. **Confirm.** A summary names:
   - the Lead archived and the Peers archived;
   - the successor's provider and Supervisor;
   - that the successor reads the handoff and reports back.

   **Replace Lead** is the primary action. On success the modal offers **Open new Lead**.

### 8.4 Elsewhere
- Seat rows and the role pill show the context line.
- The Room header's "New project" becomes **Add repository**. Its folder field offers the observed
  projects without a live Lead as choices.
- The Supervisor picker lists live Supervisors first, shows state and folder, and defaults to the
  project's current Supervisor.
- Settings › Room seats gains a *Seat context* section:
  - the per-role marks, as selects in 5% steps, with *off*;
  - the notice about seats already past a new mark, and that a new compact mark reaches a seat at its
    next session open.
- [runtime-panel-ux.md](runtime-panel-ux.md) is amended when this delta is approved.

Room clutter is a separate UX change and not part of this delta: stale projects grouped, and
Supervisor names disambiguated.

## 9. Evaluation

### 9.1 Alternatives

| | A. Status quo (manual `/compact`) | B. Lower compact mark only | C. Succession (this delta) | D. Succession + resilience (C + §7) |
|---|---|---|---|---|
| Fidelity after the event | Low: a generic summary of up to about 950k | Better: a summary of about 500k, written from a healthier context, but more summaries over a project's life, and each one loses something | Highest: a Human-reviewed, targeted handoff that the successor verifies | Highest, and compactions that do happen lose less |
| Contract freshness | Never refreshed | Never refreshed | Refreshed at each succession | Same as C |
| Input tokens | Baseline | Lower | Simulated 42–63% of baseline at a 300k rotate mark, and 49–73% at 400k, over four real Leads (§9.3) | Same as C |
| Human effort | A `/compact` whenever the Human notices | None | One guided action per rotation; in simulation, for the busiest Lead, about 3 a day at 300k and 2 at 400k | Same as C |
| Disruption | Mid-work, whenever typed | Mid-turn, whenever the window fills | Only at a quiet point (preflight) | Same as C |
| Implementation risk | None | Low: one environment variable, qualified | Medium: a lifecycle state machine | Medium, plus a new hook surface |
| Reversibility | — | A setting | The suggestion is a setting (`rotateAtPercent`); replacing is an action the Human takes or does not; archived Leads remain in Paseo | Same as C |

**Recommendation:** B as the safety net, and C as the remedy, now. Add D's C2 once K1–K2 produce
evidence about post-compaction errors.

B alone is not recommended. It turns one late, lossy event into several earlier lossy events, and
never refreshes the contract.

### 9.2 Risks of the recommendation
- **A handoff can be wrong.** The Human reviews it, and the successor is told to verify it and report
  differences, as it did on 2026-09-26. The residual risk is a wrong Human decision quoted from a
  compacted memory. Mitigations: the request asks for verbatim quotes, and C2 or C4 later.
- **Rotation too often.** 300k meant about 9 rotations over 3 days for cmdb in simulation. The mode
  is `suggest`, each crossing is told once, and the mark is a setting (Q-K01).
- **A compact mark set on a resumed seat already above it compacts at once.** The settings screen
  warns, and the Supervisor defaults to off.
- **The environment variable's semantics could change** between Claude Code versions. The room's
  provider pins the executable path, not its version (`~/.local/bin/claude` is a symlink the vendor
  updates), so qualification records the version it measured. A version change is a reason to
  re-run Q-C2.
- **Archive, then create failure.** The project has no Lead until *Finish* runs. It is shown as such,
  with the handoff kept.
- **Notices addressed to the old Lead.** The preflight refuses while one is pending. A notice
  created after the preflight would come from an assignment or from `message_lead`. The first
  cannot happen, because every assignment is settled. The second resolves the project's active Lead
  when it is sent (`handlers/actions.ts`): the successor after step 5, and `lead_unavailable` in the
  seconds between steps 4 and 5. K2 tests cover both.
- **A Supervisor opening a Lead in the gap.** Between archive and create the project has no live Lead
  for a few seconds. A Supervisor that opened one in that gap would raise the existing
  `duplicate-lead` page. That needs a Supervisor turn, which a succession does not prompt.

### 9.3 How the numbers were obtained
- Context sizes are the sum of input, cache-read and cache-creation tokens per assistant message in
  each role-home session transcript.
- Compactions are the transcripts' continuation markers and `/compact` commands.
- Content shares are character counts of tool inputs and results by tool name, a proxy for tokens.
- The simulation replays each Lead's per-call context growth:
  - the context resets to 90k at the mark;
  - each rotation is charged 40 calls at 90k for onboarding;
  - the sum of per-call context is compared with the actual sum.
- It ignores that a fresh Lead may re-read files. The onboarding charge is meant to cover that; the
  new cmdb Lead reached 88k in 32 calls.

### 9.4 What this delta does not fix
Most of a Lead's context is its own shell work: cluster commands, gates, Git. Some of it is Lead's by
contract, since Lead inspects exact candidates and runs gates when it writes. The rest, operating
clusters and reading large logs, could be a Scout's or Engineer's. That is a repository-protocol and
Lead-contract question with its own evidence. It is noted here so that a budget is not mistaken for a
cure.

## 10. Authority and contract

- **D4, Human/operator row, adds:**
  - replace a project Lead with a successor after a reviewed handoff;
  - start a Lead for an observed project that has none;
  - set seat context budgets.

  The D4 row, [runtime-panel-ux.md](runtime-panel-ux.md) and the PRD are amended as each phase lands:
  D4 and the panel doc with K1 and K2, and the PRD on approval (§12).
- **Unchanged:**
  - Supervisor's row; it may relay `context-high` to Human;
  - Lead's row;
  - Peer's row.
- **Contracts:** `lead.md`, `supervisor.md` and `peer.md` are unchanged in K1–K2. Human-initiated
  succession is "Human … reassigns the project" (`lead.md`). The handoff request is a Human
  instruction carried by the runtime, not a new duty. K3's C2 changes no contract. C4 would, and is
  out of scope.

## 11. Testing and qualification

### 11.1 Automated
- **Unit:**
  - percent-to-token conversion and settings validation (bounds, ordering, the 100k floor);
  - the `session_open` hook: only exact room Claude providers with a mark, nothing otherwise;
  - `context-high` raised once per crossing and closed on a fall or an archive;
  - each K-D5 step's refusal codes, idempotency and resume after a simulated reload;
  - the handoff read whole across several assistant messages;
  - `assignment_status` default and `full`;
  - the handoff and kickoff turns recorded, not relayed, while their marker lines still go.
- **Integration**, with the fake Paseo from `test/runtime-fake-paseo.ts` extended with `lastUsage`,
  compaction items and archive:
  - a full succession;
  - failure after archive, then *Finish*;
  - no `duplicate-lead` page;
  - no `peer-orphaned` when descendants are archived;
  - *Start Lead* on a leadless project through `start-project`.
- **Boundary:** the plugin import boundary test is unchanged.
- **Panel:** the model functions for the context line and the preflight rendering.

### 11.2 Live qualification (release blockers)
| Id | Question |
|---|---|
| Q-C1 | An environment variable returned by `session_open` reaches the Claude process at create and at resume (source says yes: `buildSdkEnv` overlays). |
| Q-C2 | With `CLAUDE_CODE_AUTO_COMPACT_WINDOW` set, where does a 1M Opus seat auto-compact? It must be at or below the window, and the observed trigger is recorded. |
| Q-C3 | `lastUsage.contextWindowUsedTokens` tracks the transcript's per-call context within 5%, and resets after compaction. |
| Q-C4 | Does an appended system-prompt section steer the compaction summary as `# Compact instructions` in `CLAUDE.md` does? (Informs §7 C1.) |
| Q-C5 | A handoff of more than 8 KB is read whole from the timeline, a 64 KB `handoff` passes the plugin RPC transport, and a 64 KB `run` is delivered. |
| Q-C6 | Archive-then-create raises no `duplicate-lead` and no `lead-gone-with-work`. The successor's `paseo.parent-agent-id` names the Supervisor, and the portfolio is unchanged. |

**Record:**

| Id | Date | Observed | Result |
|---|---|---|---|
| Q-C3 | 2026-09-26 | For the cmdb Lead (`8e2e0280`) and the Supervisor (`e42ba93e`), `lastUsage.contextWindowUsedTokens` equalled the last transcript call's input, cache-read and cache-creation tokens plus its output tokens, exactly: 133,298 + 365 = 133,663, and 404,952 + 333 = 405,285. `contextWindowMaxTokens` was 1,000,000 for both. No compaction happened, so the reset is not yet observed. | partial pass |

### 11.3 Success measures (baselines from §0)
- Lead sessions that reach 500k context: 12 of 39 so far; target none with K1–K2 enabled.
- Average context per Lead call: baseline 358–528k; target below 250k.
- Human `/compact` commands on Leads: baseline 3 in 3 days on cmdb; target zero.
- Handoff fidelity: the discrepancies each successor reports, logged per succession.
- Post-event corrections: Human messages to a Lead that correct a forgotten decision within its next
  20 turns, after a compaction versus after a succession. This is counted by hand from transcripts
  for the first two weeks, and decides K3.

## 12. PRD amendment — approved 2026-09-26
- **New REQ-026:** each live room seat's context use and compactions are visible to Human, and a Lead
  past its rotate mark is reported once per crossing.
- **New REQ-027:** Human sets a context budget per role, in percent. The room enforces the compact
  mark where the agent supports it and says where it does not.
- **New REQ-028:** Human can replace a project Lead with a successor that receives a reviewed
  handoff, only at a quiet point. A failure never leaves two Leads, or a project without a way to
  finish.
- **REQ-024 amended:** Human can start a Lead for an observed project from that project's own screen.

## 13. Rollout

| Phase | Contents | Default |
|---|---|---|
| K1 | Context visibility, `context-high`, settings, Claude compact mark, lean `assignment_status`, Start Lead on the project screen | Lead 30/50, Supervisor and Peer off |
| K2 | Replace Lead: the K-D5 state machine, RPCs, modal, handoff storage | available to the Human; suggested at the rotate mark |
| K3 | One resilience option chosen from §7 by the evidence of §11.3 | off until chosen |
| K4 | Automatic succession at a quiet point, if ever | requires its own approval |

- K1's signal and compact marks are settings. K2 is an action the Human takes or does not. Each
  phase can be reverted on its own.
- Removing or disabling the plugin removes all of it. Seats launched with a compact mark keep it until
  their next session open.
- Existing rooms need `setup --runtime --apply` to receive the new plugin, as for every runtime change.

## 14. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-K01 | Default marks for Lead: rotate at 30%, and compact at 40% or higher? | Repository owner | resolved 2026-09-26 — rotate 30%, compact 50%, for more room between the suggestion and the safety net |
| Q-K02 | Should the Supervisor receive the `context-high` fact line, or should it stay on the panel only? | Repository owner | resolved 2026-09-26 — send it; the Human talks to the Supervisor |
| Q-K03 | Should `paseo-room export` gain a flag that includes handoffs? | Repository owner | resolved 2026-09-26 — not now; export keeps copying project ledgers only. Recorded for later. |
| Q-K04 | Enforce Codex and Pi budgets through setup, or leave them displayed only? | Repository owner | resolved 2026-09-26 — a later delta; displayed only until then |
| Q-K05 | Allow the Human to choose a different room Lead provider for the successor? | Repository owner | resolved 2026-09-26 — accepted, deferred beyond K2; K2 keeps the predecessor's provider |
| Q-K06 | Keep Supervisor out of this delta until the notebook (O4)? | Repository owner | resolved 2026-09-26 — yes; its compact mark stays off |

## 15. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-26 | Repository owner / Bytes | Approved after a fresh-eyes review. The review changed:
- *Start Lead* reuses `runtime.start-project`; the planned `runtime.start-lead` is dropped.
- `succession.mode` is dropped, and `rotateAtPercent: null` turns the suggestion off.
- The handoff and kickoff turns are recorded, not relayed.
- The Supervisor gets one line when a Lead is replaced.
- Preflight also requires no pending notice and no descendant on a permission, and resolves the Supervisor before the archive.
- The successor acts only inside the repository until it has reported.
- Compaction counts are labelled as since runtime start.
- `assignment_status` takes `full` rather than `includeBrief`.
- The model window is resolved at create and at resume.
- Qualification became each phase's release gate.
- The PRD amendment (§12) is applied. |
| 2026-09-26 | Repository owner / Bytes | Owner decisions on Q-K01–Q-K06: Lead compacts at 50% (rotate stays at 30%); the Supervisor receives `context-high`; handoffs are not exported; Codex and Pi enforcement is a later delta; choosing another successor provider is deferred beyond K2; Supervisor stays out. Next: live qualification Q-C1–Q-C6, then the K1 plan. |
| 2026-09-26 | Bytes | Created Draft from the operator's report of Lead hallucination near a full 1M context and after compaction, the 2026-09-26 cmdb Lead replacement, and measurements of 57 role-home sessions. It proposes context visibility, per-role budgets enforced for Claude at session open, Human-initiated Lead succession with a reviewed handoff, a leaner `assignment_status`, and an evaluated set of compaction-resilience options. |
