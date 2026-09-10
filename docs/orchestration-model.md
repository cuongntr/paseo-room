# Agent orchestration: a reference model

A model for running several coding agents on one project without losing the thing that
makes strong agents worth using — their independent judgment.

This document is deliberately tool-agnostic. It describes roles, authority, instruction
layers, invariants and failure modes; it names no product. Two words appear throughout:

- **agent runtime** — whatever actually runs a model with tools against a repository.
- **control plane** — whatever owns agent identity, lifecycle, workspace placement and the
  timeline of what happened.

[`docs/design.md`](design.md) describes how one particular tool implements this model, and
[`src/room/clauses.ts`](../src/room/clauses.ts) is the model rendered as instructions an
agent reads. This file is the concept layer both of those depend on.

## 1. The problem

The obvious way to use several agents is an orchestrator that decomposes a task and hands
each worker a precise instruction. It underperforms, for a reason that is easy to miss: the
orchestrator has already solved the problem in the plan, so the workers can only be right
about the wrong thing.

```text
Lead: "Implement solution X. Report PASS/FAIL."
Peer: optimises until X runs.
A false foundation survives, defended by working code.
```

Versus:

```text
Lead: "The outcome is Y. Here are the constraints and the evidence I have.
       Investigate the mechanism; if the premise does not hold, reopen it."
Peer: may find a different solution, or demand a missing dependency.
```

The second only works if the worker is structurally allowed to disagree. Everything below
exists to keep that possible while still producing a decision someone is accountable for.

## 2. Actors and authority

```text
                    Human
                      │
         ┌────────────┴────────────┐
    Supervisor                 Project Lead
  governance / observation   project authority
         │                         │
         └──── observes ───────────┤
                                   │
                                Peer(s)
```

This is **not** a hierarchy of rank. Supervisor and Lead hold different *kinds* of
authority, and neither reports to the other.

**Human / Owner** keeps the decisions no agent may infer: product goals, priority,
material cost, external effects, and anything irreversible. Human may also direct the
technical route and override an acceptance decision, but does not normally operate the
protocol day to day.

**Lead** is the binding technical arbiter for one project. It owns framing, decomposition,
routing, ownership assignment, dependencies, integration, verification and technical
acceptance — inside the Human's boundaries. A Lead is not a senior engineer with a spawn
button; if it implements a difficult change *and* accepts it, separation of judgment is
gone.

**Supervisor** observes Lead–Peer workflows, across projects if there are several. It
detects loss of momentum, authority-gradient behaviour, framing capture, repeated local
patches, moving scope, weak verification, attention dilution. It routes the Human's
decisions unchanged, and advises Lead. It does **not** own implementation or technical
acceptance, and does not direct a Peer while Lead is healthy.

**Peer** owns exactly one bounded outcome delegated by Lead, forms its own technical
position, and hands back something reproducible. It does not manage other agents, infer the
room's topology, or accept its own difficult work.

Naming is load-bearing. A seat called *Root* with *subagents* under it produces compliant,
bot-like behaviour; a seat called *Lead* delegating to a *Peer* who *owns a bounded
outcome* produces an independent co-worker. Use the social vocabulary, not the
control-plane vocabulary.

### Peer is one profile, not four jobs

The same thin Peer profile becomes a different worker through its brief:

| Disposition | Mode | Mandate |
|---|---|---|
| Engineer | writes | Implement one bounded outcome in one moving scope, with proportionate proof. |
| Architect | read-only | Answer an ownership/lifecycle question with alternatives, the strongest counterargument, and reversal conditions. |
| Reviewer | read-only | Falsify a named candidate against a stated risk; approve or return findings. |
| Scout | read-only | Establish what is actually true in unfamiliar territory before anyone commits. |

Keeping this one profile has three effects: attention stays on the task instead of on a
role identity, the number of profiles does not grow with the number of situations, and Lead
picks a method by risk rather than being locked in by a role name.

## 3. Three layers of instruction

| Layer | Lifetime | Holds | Never holds |
|---|---|---|---|
| Role profile | Durable, across repositories | Identity, authority, invariants, anti-pattern guards | Tactics specific to one repository |
| Workspace protocol | Durable, one repository | Topology per task class, model/effort policy, review rhythm, escalation, project anti-patterns | Details of one task |
| Task brief | One assignment | Objective, scope, exclusions, authority, verification, handoff | The organisation manual |

The separation is the point. A Peer that must spend attention deciding which rules apply to
its task follows none of them well.

Two practical rules follow. First, the workspace protocol is read by Lead (and by
Supervisor when auditing); Lead quotes the relevant constraint into a brief rather than
broadcasting the whole file to implementers. Second, it does not belong in the file every
agent already reads by default — that is exactly the broadcast being avoided.

## 4. Structural invariants

These are the rules that hold the model up. Each one has a specific failure behind it.

**One control plane.** One system owns agent lifecycle, parentage, workspace placement and
the timeline. If a seat can also spawn its own agents, there are two ledgers and no way to
say which agent owns a task, a workspace, or a correction — review and cleanup stop being
trustworthy. Close every native multi-agent path in the runtime, and give orchestration
tools only to the seats whose job is orchestration.

**One writer per moving scope.** Two agents editing one subsystem produce a diff nobody
owns. Before transferring write ownership, stop the previous writer and establish a stable
handoff. Read-only review does not create a second writer.

**Review only a stable candidate.** A moving target produces false confidence:

```text
Reviewer reads file A at 10:00
Writer changes file A at 10:02
Reviewer approves at 10:05
What gets integrated is not what was reviewed.
```

A stable candidate is an immutable commit, or a deterministic snapshot digest when the
agent has no commit authority.

**Independence requires a fresh session, not a fork.** Forking the Lead's session to make a
"reviewer" inherits the Lead's premises and framing; the review then checks the
implementation of a decision it was never able to question. Start a new session with a
neutral brief and the exact candidate.

**Workspace isolation is a filesystem property.** Two workspace identifiers pointing at one
checkout are one workspace. Concurrent writers need separate working trees.

**Wait on events, not on polls.** Continuous status checking consumes the orchestrator's
attention and produces no new information. Confirm a start, then wait for a completion,
error or attention event; use a bounded wait when one is genuinely needed, and treat
heartbeats as a safety net rather than a schedule.

**Capability shapes behaviour.** An agent that *can* orchestrate will drift toward
orchestrating. Give Lead macro capabilities (decomposition, framing, routing, review,
synthesis), Supervisor strategic ones (timeline analysis, pattern detection, recovery), and
Peer micro ones (language, framework, test, debug, research). Loading every capability into
every seat dilutes all of them.

## 5. The delegation contract

A brief that is missing any of these produces a predictable failure rather than a question:

| Element | Missing it causes |
|---|---|
| One bounded outcome | Scope creep, or work that stops at the first ambiguity |
| Prerequisites and current state | Rediscovery, or an assumption stated as fact |
| Explicit write scope, or read-only mode | Moving-scope collision |
| Exclusions | Helpful edits nobody asked for |
| Stable contract and invariants | Integration failure at handoff |
| Required acceptance evidence | Proof shaped to the implementation |
| Conditions that reopen the decision | A false premise defended to completion |

The brief states an outcome and a boundary. It must not contain the verdict in disguise —
"implement X" where X is the conclusion the Peer was supposed to be able to challenge.

### Return signals

The right to disagree has to be a protocol element, otherwise it does not survive contact
with an authority gradient. Three signals, each carrying evidence, the consequence, and the
decision or dependency needed:

- **REOPEN_REQUEST** — a technical premise of the brief does not hold.
- **DEPENDENCY_REQUEST** — safe completion needs something the Peer does not own.
- **BLOCKED** — no safe in-scope progress remains.

Lead resolves technical questions itself and escalates owner-only ones. Disagreement is
evidence to reconcile, not disobedience. The opposite failure is equally real: manufactured
objections to look rigorous. Independence means judgment backed by evidence, and agreement
is a valid conclusion when the evidence supports it.

### Handoff

A candidate identifies its immutable commit or snapshot, the original base, every changed
path, the verification performed and its results, and the residual risk. The receiving seat
must be able to reproduce the inspection without asking a question.

## 6. Acceptance

Acceptance is an authority act, not a status transition.

| Who | Owns |
|---|---|
| Engineer | Proof proportionate to its own writes |
| Reviewer | Falsification of a named candidate against a stated risk |
| Lead | Technical acceptance of the project's result |
| Human | Product, cost, external-effect and irreversible-risk trade-offs |

Passing tests prove a set of behaviours. They do not prove the architecture is sound, the
product is right, or the change may ship. A lifecycle status of `finished` means an agent
stopped; it is a reason to look, not a result. Acceptance runs against the exact artifact,
by someone with the authority to give it, and among agents that is Lead alone — subject to
Human override.

## 7. Topology by difficulty

Use the smallest topology that answers the question. Agent count is not authority: two
models agreeing does not make an unevidenced conclusion true.

```text
Tiny task
  Lead → one Engineer → focused checks → Lead inspects

Bounded implementation
  Lead → Engineer in an isolated workspace → stable candidate
       → Reviewer if the protocol or risk calls for one → Lead's verdict

Architecture-sensitive slice
  Lead → Architect (read-only, neutral brief)
       → Lead's binding design decision
       → Engineer (one moving scope) → independent Reviewer (falsification)
       → correction in the same Engineer session → new stable candidate
       → Lead's verdict

Difficult council
  Lead ├── Architect A: ownership, lifecycle, alternatives
       └── Reviewer B: failure modes, falsification, migration risk
       sealed reports → Lead extracts 3–5 material propositions
       → verify only the decision-changing ones
       → at most one challenge/response per proposition → one binding verdict

Several projects
  Human ├── Supervisor observes workflows across workspaces
        ├── Lead A → Peer(s) → evidence A
        └── Lead B → Peer(s) → evidence B
```

A council is not a vote. Each seat needs a distinct mandate, and seats must not read each
other's reports before submitting if genuine divergence is the point. Across projects, each
Lead keeps authority inside its own workspace: evidence from project A never accepts work
in project B, and Supervisor does not become a Lead over both.

## 8. Anti-patterns

Named failures, in the form they actually appear.

**Authority-gradient compliance.** Every Peer response agrees; the foundation is never
checked. The brief contained the verdict. Send evidence and an open question, and require a
typed reaction (confirm / partial / challenge / block) rather than asking the agent to
"push back". *Opposite failure:* performative contrarianism.

**Pre-solving.** The plan fixes every file, API and lifecycle in advance, leaving PASS/FAIL
for the worker. The orchestrator implemented the task in the plan, using untested
assumptions. Make the plan a provisional map: outcome, boundaries, risks, checkpoints.

**Parachute instead of brakes.** The third correction is still treating the same symptom;
complexity rises, the root mechanism does not move. Stop patching and ask which shared
mechanism produces the whole series.

**Architecture lock-in.** The feature works, but every subsequent change needs a new
adapter or exception. A strong agent can keep a feature running on a weak foundation longer
than a human can, so the failure surfaces late and expensive. Get an independent
architecture review with alternatives, the strongest counterargument, and reversal
conditions — before a hard-to-reverse decision, not after.

**Architecture fog.** Many layers and terms, but nobody can state ownership or lifecycle in
one sentence; each decision is deferred behind another wrapper. Demand a concrete state
owner, transitions, failure semantics, and a deletion test: which behaviour disappears if
this abstraction goes?

**Moving-scope collision.** Two writers in one subsystem, or a reviewer reading while a
writer edits. One writer per moving scope, isolated working trees, explicit handback,
stable candidate digest.

**Self-acceptance.** The same agent designs the benchmark, implements against it, runs it,
and declares success — metric and implementation share a blind spot. The success boundary
comes from Lead or Human; an independent reviewer handles decisions that matter.

**Test-shaped proof.** Tests written to match the implementation, mocks that remove the
real failure, green suites that prove no user outcome. Ask which wrong mechanism would make
this test fail. If the answer is "none", it is not proof.

**Overengineering an edge case.** Thousands of lines of infrastructure to cover a rare
case, at a maintenance cost above the risk. Quantify frequency, impact, the simpler
fallback, and the cost of reversal. More complete is not automatically better.

**Polling debt.** Repeatedly asking whether an agent is done; retrying an identical call
with unchanged prerequisites; a heartbeat that has quietly become a worker. Use events and
bounded waits, and after two identical failures check prerequisites, quota, auth and
authority instead of retrying.

**Ceremony capture.** Every task becomes a council; process output exceeds evidence. Seat
count creates a feeling of certainty, not certainty. Smallest useful topology; a council
only for genuinely independent, decision-changing propositions.

**Debate framing capture.** The two options offered both sit inside a wrong framing, and
the challenger argues within it. Have someone reconstruct the real problem before seeing
the preferred solution.

**Forked independence.** A "reviewer" forked from the Lead's own session. Fresh session,
neutral brief, exact candidate, no inherited framing.

**Attention dilution.** The Human asks the Lead everything, and the Lead spends its context
explaining instead of holding dependencies, topology and acceptance state. Route
conversation through Supervisor or an ordinary advisory session; deliver decisions to Lead
already condensed.

**Capability pollution.** The Peer starts orchestrating; the Lead dives into framework
details; every seat loads capabilities it will never use. Macro for Lead, strategic for
Supervisor, micro for Peer.

**Status as acceptance.** `finished` or "tests pass" reported as done, with no inspection of
the diff, the scope, or the candidate. Lifecycle status wakes the owner; it does not accept
anything.

**Supervisor overreach.** The Supervisor sees a problem and fixes the code, issues an
architecture verdict, or manages a Peer directly — the governance plane becomes a second
Lead and the authority conflict is permanent. Ask an evidence-backed question, relay the
owner's decision, or propose a handoff. Intervene in implementation only under an explicit
recovery mandate.

## 9. Operating checklists

**Before dispatch**

- Correct repository root and project identity.
- Lead has read the workspace protocol.
- Runtime, model and workspace identifiers inspected, not guessed.
- The brief has objective, ownership, exclusions, authority and verification.
- Concurrent writers have separate working trees.
- The brief contains no disguised verdict.

**While running**

- No unbounded polling.
- The Peer can still reopen, request a dependency, or report blocked.
- Scope expansion is proposed, never self-granted.
- Findings arrive as hypotheses with evidence.
- Disagreement is not treated as disobedience.
- A repeated correction triggers a root-mechanism check.

**Before acceptance**

- The candidate is stable and has an exact identity.
- The actual diff or artifact was inspected.
- The verification commands and their results are real.
- An independent reviewer was used if the protocol requires one.
- The review covered this exact candidate.
- Unresolved findings are still visible.
- The accepting party holds the authority to accept.
- No task-local schedules or heartbeats are left running.

## 10. What a runtime has to provide

The model is portable, but not free. Before adopting it, confirm the stack can do these
things — each one maps to an invariant above.

| Capability | Serves |
|---|---|
| Independent sessions with different instructions | Role separation, unforked independence |
| Isolated runtime state and configuration per seat | Three seats without three logins or three identities |
| Durable agent identity and parentage | One control plane, an auditable timeline |
| Workspace placement with real filesystem isolation | One writer per moving scope |
| Per-seat tool policy | Orchestration tools for the seats that orchestrate |
| A way to disable the runtime's own multi-agent features | One control plane |
| Completion, error and attention events | Event-driven supervision |
| Stable candidate identity (commit or deterministic snapshot) | Review and acceptance |

If the runtime cannot disable its own subagents, you have two control planes and the
ownership invariants do not hold — fix that before building on top of it.

## 11. Provenance and how to adapt this

The model originates with Demonthorn's agent-orchestration practice, refined in public over
several weeks of operation, and is reconstructed here from that material plus a reference
implementation of it. Statements about failure modes come from observed behaviour; the
tables and checklists are a synthesis, not a transcript.

Vocabulary shifted during that period — an earlier `Root` became `Lead` precisely because
of the naming effect described in §2 — so a snapshot of the model taken mid-development
will disagree with a later one. When a written description and a working implementation
conflict, trust the implementation: it is what actually ran.

Adapt the surface, keep the invariants. Seat names, the number of concurrent Peers, which
capabilities each seat carries, and how strict a repository's protocol is are all local
decisions. The parts that are not local are §4: one control plane, one writer per moving
scope, stable candidates, unforked independence, events over polls, and capability
discipline. A setup that drops one of those will look like this model and fail like the
thing it replaced.
