---
name: paseo-project-onboarding
description: Draft, audit, or update a repository's root WORKSPACE_PROTOCOL.md from that repository's own evidence. Use only when Human asks Lead to onboard a project, create or review its workspace protocol, or turn a repeated observed workflow failure into repository policy. Proposal-first — it reports evidence and a draft and writes the file only under an explicit apply instruction.
---

# Paseo project onboarding

This skill turns a repository's own observable evidence into one standalone root
`WORKSPACE_PROTOCOL.md`: the repository workflow policy Lead reads before orchestration. It is
a procedure for gathering evidence and drafting, not a source of policy.

There is no room default protocol. A repository that ships a protocol has stated its complete
workflow policy; a repository that ships none leaves Lead on the small operating defaults in
Lead's own contract. So the draft has to be complete on its own, and nothing in it may be
assumed to be filled in from elsewhere.

## When to use it

- Human asks to onboard a project or repository.
- Human asks to create, review, audit, or update `WORKSPACE_PROTOCOL.md`.
- The same workflow failure has recurred, with evidence, and Human wants it turned into
  repository policy.

Do not run this during ordinary implementation or orchestration work. A repository file is
never written as a side effect of another task.

## Hard boundaries

These hold in every run and cannot be relaxed by a repository, a draft, or a Human
convenience request inside this skill:

- The skill cannot change Human, Supervisor, Lead, or Peer authority, the Paseo tool policy,
  the one-writable-Peer limit, provider or profile identity, or credentials. A proposal that
  would is reported to Human as out of scope instead of drafted.
- The skill cannot give Peer the protocol, name the protocol path to Peer, or make Peer a
  reader of anything but its brief.
- The skill cannot invent policy. Every statement in a draft names the evidence behind it, or
  it is listed as an open decision for Human instead.
- The skill writes nothing by default, and never writes any path other than the repository's
  root `WORKSPACE_PROTOCOL.md`. It adds no dependency, tooling, or other top-level file.

## Procedure

### 1. Resolve the root and the current state

Resolve the repository root — normally the version-control root rather than the current working
directory when they differ — and report it. If no version-control root exists, use repository
markers and the Human's named scope; report uncertainty instead of silently choosing. Check
whether `WORKSPACE_PROTOCOL.md` already exists there and whether it is a regular file.

If the path exists and is not a regular file, stop: report the shape found and ask Human to
move it aside. Never replace a directory, symlink, or special file.

If it exists as a regular file, read it in full. This run is then an audit or update against
it, not a fresh draft: preserve what still matches the evidence and name each proposed change
with the evidence that motivates it.

### 2. Gather evidence

Read only what the repository actually contains. Note explicitly which of these are absent —
an absent source is evidence about the repository too:

- `AGENTS.md`, `CLAUDE.md`, or equivalent agent instructions, including nested ones;
- `README`, `CONTRIBUTING`, and any contributor or development guide;
- build manifests and their script blocks (`package.json`, `pyproject.toml`, `Cargo.toml`,
  `go.mod`, `pom.xml`, `Makefile`, `justfile`, and equivalents);
- CI and automation configuration, and what gates it actually runs on a change;
- test and lint configuration, and how the suite is invoked;
- architecture, design, decision-record, and operations documentation that exists;
- the visible house style of the code being changed, and the repository's own layout.

Prefer executable evidence over prose: a script or CI job that runs a gate outranks a document
that claims one. When they disagree, record the disagreement as an open decision.

### 3. Separate evidence, proposal, and unknown

Classify every candidate statement before drafting:

- **Evidence** — directly supported by a file, script, or CI job you read. Cite the source.
- **Proposal** — a reasonable workflow rule the evidence suggests but does not establish. Mark
  it as a proposal Human must accept.
- **Unknown or conflicting** — evidence is missing, ambiguous, or contradictory. Name the
  conflict and the decision Human owns; do not resolve it by guessing.

A repository convention that only one person's habit supports is a proposal, not evidence.

### 4. Draft one standalone protocol

Write a single complete document for the repository root. Use
[references/workspace-protocol-template.md](references/workspace-protocol-template.md) as a
scaffold for the shape only: it is a reference loaded during this skill, never a default
appended to a session, and every section it suggests is dropped when the repository has no
evidence for it.

The draft contains repository workflow only: how work is shaped, verified, reviewed, and
escalated in this repository, and the repository's own conventions. It contains no role
authority, no room capability claims, and no generic agent advice that would be equally true
of any repository. Drop a section rather than fill it with filler.

### 5. Report

Report, in this order:

1. the resolved repository root and whether a protocol already existed;
2. the evidence map, naming each source read and each expected source absent;
3. the complete draft;
4. the proposals and open decisions Human still owns; and
5. whether any file was written — by default, none was.

### 6. Write only on an explicit apply instruction

Write the root `WORKSPACE_PROTOCOL.md` only when Human explicitly instructs you to apply the
draft. Then:

- confirm the target is absent or an existing regular file, and refuse any other shape;
- write that one path and nothing else;
- leave every unrelated change in the working tree untouched, and make no commit unless Human
  asked for one; and
- report the exact path written and what it now contains.

An audit or review request is not an apply instruction. If Human's intent is ambiguous, report
the draft and ask.
