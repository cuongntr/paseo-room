# Workspace Protocol and Prompt Simplification — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [`demonthorn-agent-orchestration-deep-dive.md`](../demonthorn-agent-orchestration-deep-dive.md) plus the repository owner's 2026-09-19 direction |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Routing decision | Brownfield model-facing contract change; technical design → direct implementation because this is one settled delivery atom with no rollout or dependency graph |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** public/model-facing role contract and control-plane authority boundary.
- **Required artifacts/gates:** this Technical Design and `design-ready`; no PRD amendment because the owner clarified the existing orchestration intent rather than adding a product outcome.
- **Execution path:** direct implementation; no Beads or implementation plan because the change has one owner, one repository, no phased rollout, and no independent prerequisite graph.
- **Exceptions:** none.
- **Decided:** 2026-09-19 — Repository owner.
- **Supersedes:** the workspace-reader and prompt-granularity portions of [`orchestration-quality-hardening.md`](orchestration-quality-hardening.md); its runtime capability decisions remain active.

## 1. Boundaries

This design owns:

- making Lead the only standing reader of the workspace layer;
- making Supervisor read a repository protocol only under an explicit Human audit, update, or maintenance mandate;
- keeping Peer unaware of the protocol file while receiving assignment constraints through its brief;
- moving repository workflow policy—dispositions, task topology, model/effort routing, review triggers, stable-candidate rhythm, and protocol evolution—out of durable role-specific prose and into the default Workspace Protocol;
- retaining role authority and room capability constraints outside repository control;
- consolidating Markdown assets by independently distributed review unit instead of one file per heading; and
- updating semantic composition, tests, contributor guidance, and active operator/design documentation.

This design does not own:

- changing Human, Supervisor, Lead, or Peer authority;
- allowing additional writable Peers, adding worktree isolation, or changing Paseo tool access;
- changing provider/profile configuration, prompt carriers, room paths, credential handling, or CLI behavior;
- rewriting a repository's `WORKSPACE_PROTOCOL.md`; or
- changing the default's point-by-point precedence semantics. A repository rule still wins where it speaks and the room default remains where it is silent.

## 2. Architecture

### Before

```text
32 Markdown assets
  → one file per semantic heading
  → instructions.ts reconstructs role documents from long key lists
  → default workspace fragments are appended to Lead and Supervisor
  → thin workspace layer is supplemented by workflow policy in Lead contract
```

### After

```text
document heads
  + shared authority body                all roles
  + shared seat-identity evidence        Supervisor + Lead
  + shared challenge vocabulary          Lead + Peer
  + one role-specific body               exactly one role
  + one complete default workspace doc   Lead only
  → unchanged additive vendor carriers
```

Canonical prompt assets become review units:

```text
src/room/prompts/
  documents/{supervisor,lead,peer}.md
  contract/
    shared-authority.md
    shared-seat-identity.md
    challenge-signals.md
    supervisor.md
    lead.md
    peer.md
  workspace/default.md
  pi/{communication-style,runtime}.md
```

A role body may contain multiple H2 sections. The workspace document contains one H1, a hard-wrapped preface that survives rendering verbatim, and multiple H2 sections. The loader gains a `body` and a `document` kind for those two shapes, validates both, and continues to normalize each blank-line-delimited statement into the existing rendered bullet form. Shared single-section assets keep the existing `section` kind and the single-H2 shape. Twelve Markdown assets remain, down from thirty-two.

The asset names the layers carry are: `Human Authority`, `Authority Floor`, `Evidence and Event-Driven Waiting` and `Scope and Unrelated Work` in the shared authority body; `Room Seat Identity` as the shared seat-identity section; `Challenge Signals` as the shared Lead/Peer section; Supervisor's new `Workspace Protocol Mandate` replacing the former `Workspace Protocol Precedence`; and Lead's `Workspace Protocol` carrying the standing read obligation and point-by-point precedence.

## 3. Layer Contract

### Durable role and room contract

The durable layer keeps, in the shared authority body plus the role bodies:

- Human decision boundaries;
- Supervisor non-interference and Lead routing/recovery authority;
- Lead project ownership and technical acceptance;
- Peer bounded outcome, independent judgment, no orchestration, and no self-acceptance;
- challenge-signal vocabulary;
- exact room-seat identity evidence;
- the project-wide one-writable-Peer limit caused by absent writer isolation; and
- the rule that repository workflow cannot enlarge or weaken role authority, worded as an `Authority Floor` without naming the protocol file, so Peer carries the invariant without learning a path it has no use for.

### Workspace Protocol

`workspace/default.md` owns:

- reader/status metadata;
- task classes and topology;
- Engineer, Architect, Reviewer, and Scout disposition meanings;
- provider/model/effort routing principles;
- ownership, stable-candidate, review, verification, and escalation rhythm;
- repository conventions and project-specific anti-patterns; and
- protocol evolution.

Lead reads the root `WORKSPACE_PROTOCOL.md` in full before orchestration when present. The repository wins point by point; the default applies where it is silent. Supervisor does not carry the default and reads the repository file only when Human explicitly assigns protocol audit, update, or maintenance; ordinary routing and observation require no protocol reading, and Supervisor may propose a change with causal evidence but never impose one. Peer receives neither the path nor the workspace document.

Lead's `Complete Peer Brief` keeps only the brief schema, the requirement that exactly one disposition is selected, the quoting duty, and the anti-pre-solving guard. The four disposition definitions moved to the workspace default because they are workflow policy, and the concrete disposition arrives in the task brief.

### Task brief

The brief selects one actual disposition and supplies the concrete objective, mode, scope, exclusions, constraints quoted from the effective protocol, exact verification, handoff, and reopen conditions. It does not embed a verdict.

## 4. Compatibility and Rollback

The rendered prompt bytes and contract digest change intentionally. Existing rooms will report drift and require `setup --apply` followed by restarting affected seats. Provider/profile identities, prompt carrier locations, and the standalone generated `room/WORKSPACE_PROTOCOL.md` remain unchanged.

Rollback is package-level: use the previous package version, run its `setup --apply`, and restart seats. No repository, credential, or external data migration exists.

## 5. Testing Strategy

- Assert exact heading order and role distribution in rendered documents.
- Prove Supervisor receives no workspace preface, path, or workspace sections by default.
- Prove Lead receives the complete default and the obligation to read the repository protocol in full.
- Prove Peer receives no protocol path or workflow layer and retains authority, reporting, and no-orchestration invariants.
- Test multi-section role-body and complete workspace-document validation and normalization.
- Keep focused assertions for authority and capability boundaries; remove incidental phrase-by-phrase lifecycle assertions.
- Run the full repository gate: `npm run verify`.

## 6. Open Questions

None. Point-by-point default precedence remains unchanged in this delivery and can be reconsidered only from observed repository-level ambiguity.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-19 | Bytes | Activated from the repository owner's accepted Workspace Protocol layering and prompt-granularity direction. |
| 2026-09-19 | Bytes | Aligned with the delivered implementation: named the rendered sections, recorded the `body` and `document` loader kinds and the 32 → 12 asset count, and noted that disposition definitions moved to the workspace default. |
