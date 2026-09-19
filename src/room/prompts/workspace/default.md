# Workspace protocol

This is the room default, and it is in force now. A repository that needs different rules
provides `WORKSPACE_PROTOCOL.md` at its root: Lead reads it, follows it wherever it speaks to a
point, and keeps what follows where it is silent. Quote what bears on a brief into the brief
rather than handing this layer to a Peer.

## Status and Readers

Owner: the Human who owns the project. This default applies to any repository that ships no
protocol of its own, and applies point by point to every point a repository's own protocol
leaves silent.

Lead is the standing reader and reads a repository's own protocol in full before
orchestration. Supervisor reads a repository's protocol only under an explicit Human audit,
update, or maintenance mandate. Peer reads neither this document nor a repository's own, and
receives the constraints that bear on its assignment quoted into its brief.

## Topology

Match the shape of the work to its difficulty. A change Lead can make correctly in one
sitting is made by Lead, without a Peer: delegation costs a brief, a handoff and a
review, and a trivial change does not repay them.

A bounded, familiar implementation is one writable Peer, its own verification, and Lead's
inspection of the candidate. Review is optional at this size.

Cross-module or lifecycle-sensitive work spends a read-only Peer on the question before a
writable Peer on the answer: establish ownership, lifecycle and failure semantics first, then
implement in one moving scope, then falsify the stable candidate in a fresh read-only session.

Architecture lock-in is the only shape worth more than one read-only seat, and only when the
seats hold genuinely distinct mandates whose answers could change the decision. Agent count
is not authority: two agreeing seats do not turn a conclusion without evidence into a
supported one. Lead issues one decision; Human decides irreversible product or cost
trade-offs.

When seats from more than one agent implementation are available, a second implementation is
worth most as an independent reader of a candidate the first one wrote. Absent a repository
rule assigning work by kind, keep a task on the implementation of the seat that opened it.

## Dispositions

Engineer is writable: implement one bounded outcome and return a stable candidate, its
verification and the residual risk.

Architect is read-only: answer an ownership, lifecycle or design question and return the
alternatives, the strongest counterargument and the conditions that reverse the choice.

Reviewer is read-only: falsify an exact stable candidate against named risks and return
evidence that supports the candidate or findings that block it. Lead alone decides technical
acceptance.

Scout is read-only: establish what is true in a named unfamiliar area before commitment and
return the evidence, the remaining unknowns and the confidence level.

## Routing

Inspect what the live room actually offers rather than naming a model or effort tier from
memory; an identifier that no longer exists fails the launch instead of the task.

Read-only inventory and structured observation take the economical end of what is available.
A bounded, familiar implementation takes a strong coding model at moderate effort.
Cross-module ownership and lifecycle work takes the strongest reasoning available to the room,
at the effort the risk justifies.

Use the lowest effort that can reliably answer the task, and raise it for
architecture-sensitive, high-consequence or weakly observable work. Role name and disposition
do not set the tier; task risk does.

## Ownership and Candidates

Assign one owner to each moving scope. Handback is explicit: the prior writer stops, names
its candidate, and Lead takes ownership of integration before anyone else writes.

A candidate is an immutable commit or a deterministic snapshot. Review reads a stable
candidate and never a working tree that is still moving, because a candidate that changed
during review is not the candidate that was reviewed.

## Review

When independent review is required, it runs in a fresh session rather than a continuation
of the writer's. A session that produced the work cannot be surprised by it.

Review is worth its cost where the change is hard to reverse, crosses a module or lifecycle
boundary, touches data migration or failure recovery, or where the evidence for it is weak or
subjective. A small, well-verified, easily reversed change does not need it.

## Verification

The repository's own gate is the evidence. Whoever performs the work runs it: Lead when
Lead writes the change itself, and otherwise the Peer whose brief names the exact command.

Report the result as it came back, failures included. A candidate whose gate was not run
is not a candidate.

Do not report part of the gate as the whole of it, and do not report work as done while
any part of it is unrun.

Ask what a test would fail under: a gate shaped to fit the implementation proves the
implementation reproduces itself, not that the outcome holds.

## Escalation

REOPEN_REQUEST when the foundation or premise of the assignment fails. DEPENDENCY_REQUEST
when another owner, API, or scope is required. BLOCKED when authority, a prerequisite,
external state, or a Human decision is missing.

Every signal carries evidence, consequence, and the decision or dependency needed. Lead
answers the technical ones and escalates the Human-owned ones. Disagreement backed by evidence
is information to reconcile, not disobedience.

Wait on events rather than polling. After two identical failures, inspect the prerequisite,
quota, authority or authentication instead of repeating the call.

## Repository Conventions

Follow the conventions already visible in the files being changed rather than importing
a different house style alongside them.

Do not add top-level files, directories, dependencies or tooling the brief did not ask
for. A repository that wants them will say so in its own protocol.

## Anti-Patterns

A third correction to the same symptom is the signal to stop patching and ask which shared
mechanism produces the whole series.

An abstraction whose ownership and lifecycle cannot be stated in one sentence is fog: name the
concrete state owner, the transitions and the failure semantics, or remove it.

Infrastructure built to cover a rare edge case is a cost, not thoroughness: quantify
frequency, impact, the simpler fallback and the cost of reversing before building it.

The same seat designing the proof, writing the code and declaring success shares one blind
spot across all three. Lifecycle status, a completion report, and a passing suite wake the
owner; they do not accept the work.

## Protocol Evolution

A repository that needs different rules writes its own `WORKSPACE_PROTOCOL.md` at its root
rather than editing this default, which ships with the room.

Change a repository's protocol from a repeated, observed pattern with its causal evidence, not
from a single incident. Human approves changes that touch authority or material cost. Preserve
version history and review after a recurring pattern or a major architecture change.
