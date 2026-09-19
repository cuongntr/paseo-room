# Workspace protocol template (scaffold)

A shape to start from, not content to ship. Every section here is optional: keep a section
only when this repository's own evidence supports it, and delete the rest. A protocol that
states a rule nothing in the repository supports is worse than a shorter one.

Replace every bracketed prompt with the repository's own evidence-backed statement, and delete
any section whose prompt cannot be answered from evidence.

---

# Workspace protocol — [repository name]

[One or two sentences: what this repository is, and that this file is its complete workflow
policy for agent work. Note that it directs how work is done and never changes role authority.]

## Verification

[The exact commands that gate a change in this repository, copied from the manifest scripts or
CI configuration, in the order they must run. Say who runs them: the writer of the change.
State that a candidate whose gate was not run is not a candidate, if the repository wants that
stated locally.]

## Work Shaping

[How work is sized and split here: what is done directly, what warrants a bounded delegated
implementation, and what needs read-only investigation before implementation. Derive this from
the repository's actual change history and module boundaries, not from a generic matrix.]

## Review

[When this repository requires independent review of a stable candidate, and against what
risks. Derive it from what is expensive or hard to reverse here: migrations, public contracts,
authentication, infrastructure, released artifacts.]

## Model and Effort Routing

[Only if this repository actually wants to override seat profile defaults. Name the routing
rule and the kind of task it applies to. Delete this section entirely when the repository has
no such rule — the seat profile defaults then stand.]

## Repository Conventions

[The conventions visible in the code and configuration: layout, naming, typing strictness,
dependency policy, what may not be added without asking, documentation that must stay in step
with code. Cite where each one is observable.]

## Escalation

[What gets escalated here and to whom: missing decisions, external dependencies, cost,
irreversible risk. Keep it to this repository's own escalation surface.]

## Protocol Maintenance

[How this file changes: from a repeated observed failure with its causal evidence rather than
one incident, with Human approval for anything touching authority or material cost.]
