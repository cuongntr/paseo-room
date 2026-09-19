# Lead Project Onboarding Skill — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | Repository owner's 2026-09-19 decision to replace the always-on default Workspace Protocol with Lead onboarding support |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Routing decision | Brownfield public/model-facing contract and cross-adapter resource change; Technical Design → direct implementation as one settled delivery atom |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** public/model-facing role contract; cross-adapter skill distribution; managed-path migration.
- **Required artifacts/gates:** this Technical Design and `design-ready`; no PRD amendment because project outcomes and role authority are unchanged.
- **Execution path:** direct implementation; no plan or Beads because the change has one repository, one owner, no rollout phases, and no prerequisite graph.
- **Exceptions:** skill quality is covered by deterministic contract/distribution/package tests in this delivery; interactive model benchmarking is deferred until real onboarding transcripts exist.
- **Decided:** 2026-09-19 — Repository owner.
- **Supersedes:** the always-on default, point-by-point precedence, and generated-template portions of [workspace-protocol-prompt-simplification.md](workspace-protocol-prompt-simplification.md). Its role authority and prompt-consolidation decisions remain active.

## 1. Boundaries

This design owns:

- removing the full default Workspace Protocol from every Lead prompt;
- making a repository-root `WORKSPACE_PROTOCOL.md` optional and complete when present, with no hidden point-by-point merge against a room default;
- retaining only the minimum visible assignment vocabulary and operating baseline Lead needs to act safely;
- shipping one room-owned Agent Skill, `paseo-project-onboarding`, to Lead for evidence-based protocol drafting and maintenance;
- retargeting each Lead `skills` symlink from the operator directory to an exact room-owned aggregate that adds the room skill without modifying the operator home and preserves rollback shape;
- removing the obsolete generated `~/.paseo-room/room/WORKSPACE_PROTOCOL.md` regular file on apply; and
- updating provenance, package contents, tests, and active documentation.

This design does not own:

- changing Human, Supervisor, Lead, or Peer authority;
- allowing another writer, changing Paseo tool access, or giving the onboarding skill to Supervisor or Peer;
- automatically writing a repository file during ordinary work;
- inferring repository policy without evidence;
- changing provider/profile configuration, credentials, MCP declarations, or prompt carriers; or
- modifying an operator's Codex, Claude, or Pi home.

## 2. Architecture

```text
Before
  durable Lead contract
    + full generic workspace/default.md on every Lead turn
    + optional root WORKSPACE_PROTOCOL.md merged point by point
  room/WORKSPACE_PROTOCOL.md generic template
  Lead skills -> whole operator skills directory alias

After
  durable Lead contract
    + small visible assignment vocabulary and operating baseline
    + optional root WORKSPACE_PROTOCOL.md as the complete repository workflow policy
  Lead skills symlink -> room/skill-projections/<agent>/lead/
    + links to every operator skill except a same-name collision
    + link to room-owned paseo-project-onboarding
  room/skills/paseo-project-onboarding/
    SKILL.md
    references/workspace-protocol-template.md
```

The role prompt is deterministic and repository-independent. Lead resolves the repository root and reads `WORKSPACE_PROTOCOL.md` in full when it exists. Repository policy remains subordinate to the shared authority floor. Lead's short visible operating baseline remains in the contract rather than becoming a second hidden document.

The skill is procedure, not policy. It inspects repository evidence, returns an evidence map, unresolved decisions, and a complete standalone draft. It writes the root file only under an explicit Human request to apply the draft. Its bundled template is loaded only when the skill runs and is never appended to ordinary Lead sessions.

## 3. Assignment Vocabulary and Operating Baseline

Lead's durable body keeps only the small, visible behavior required in every repository:

- use the exact profile model and thinking defaults unless a repository protocol explicitly routes them;
- keep the four assignment dispositions as compact room vocabulary because every Peer brief must select one;
- name and run the repository's actual verification gate; an unrun gate cannot support acceptance;
- use a fresh read-only review when Human or repository policy requires it, or when Lead identifies material technical risk; and
- preserve the existing one-writable-Peer, stable-handoff, brief, and acceptance rules.

A repository protocol may add repository-specific routing, review, or verification requirements where the contract permits, but its silence does not erase this baseline. There is no generic topology matrix, anti-pattern catalog, project convention, protocol-evolution policy, or point-by-point default inheritance in the durable prompt.

## 4. Skill Contract

`paseo-project-onboarding` triggers when Human asks Lead to onboard a repository, create/audit/update `WORKSPACE_PROTOCOL.md`, or turn repeated observed workflow failures into repository policy.

The skill:

1. resolves the repository root and checks for an existing protocol;
2. reads the repository's own authority and workflow evidence, including `AGENTS.md`, README/CONTRIBUTING, build manifests, package scripts, CI, test configuration, and architecture/operations documentation that exists;
3. separates observed facts from proposals and names conflicts or unknowns instead of guessing;
4. drafts one standalone root protocol containing only evidence-backed repository workflow;
5. reports evidence, draft, unresolved Human decisions, and whether any write occurred; and
6. writes only on an explicit Human apply instruction, preserving unrelated work and refusing a non-regular target shape.

The skill never changes the room authority floor, tool policy, writer cap, provider identity, credentials, or Peer readership. It does not add dependencies, tooling, or top-level files other than the explicitly approved protocol.

## 5. Resource Ownership and Migration

Supervisor keeps the existing whole-directory aliases for operator resources. Peer keeps its exact non-`paseo*` skill projection and receives no room-owned onboarding skill.

Lead's role-home `skills` path remains a symlink and is retargeted to a room-owned aggregate whose declared children are:

- one link per current operator skill, preserving all existing operator skills;
- one room-owned `paseo-project-onboarding` link; and
- adapter-declared runtime-owned names such as Claude's `synced` bucket as reserved children that are neither linked nor reconciled.

A same-name operator skill is not linked into Lead; the room-owned skill owns that name inside the aggregate, while the operator copy remains untouched. The aggregate is an exact managed directory. Keeping the role path as a symlink lets both this package and the previous package replace it by the same shape during upgrade or rollback; neither package traverses or modifies the old target.

The shared skill source under `~/.paseo-room/room/skills/` is composed from package assets and managed by exact file/directory shape. The old room protocol template is declared absent so setup removes it only when it is the regular file the room formerly generated.

## 6. Compatibility, Provenance, and Rollback

The rendered Lead prompt and contract digest change intentionally. Existing rooms report drift and require `setup --apply`; running seats must restart to load the new role text. The next apply also retargets Lead skill aliases and removes the obsolete generated protocol template.

The contract digest covers the three rendered role documents only. Skill files are live managed entries: `verify` compares their exact bytes independently, and a skill update does not falsely claim that an already-running seat holds different startup instructions.

Rollback is package-level. The previous package can recreate its default prompt/template and legacy skill aliases through its own setup behavior; no repository file, operator resource, credential, or external state is migrated.

## 7. Testing Strategy

- Assert Lead receives no default workspace headings or hidden workspace asset.
- Assert the visible Lead baseline defines disposition vocabulary, profile defaults, verification, and review behavior without restoring the removed generic protocol.
- Assert Supervisor and Peer remain unaware of the root protocol path except for the authority floor's path-free conflict rule.
- Assert the skill source has valid Agent Skill frontmatter and contains proposal/apply, evidence, authority, and no-guess safeguards.
- Assert Lead receives all operator skills plus the room-owned skill across Codex, Claude, and Pi; Supervisor remains aliased; Peer receives neither room nor operator `paseo*` skills.
- Assert legacy Lead skill symlinks retarget without touching prior targets or operator homes, remain replaceable by the prior package, reserve Claude runtime state, and select the room-owned link on same-name collisions.
- Assert setup removes the old generated protocol file, detects skill drift, and stabilizes on a second run.
- Assert the packed package contains every skill asset and reports an actionable reinstall failure when one is missing.
- Run `npm run verify` in the repository-defined order.

## 8. Open Questions

None. The Human has selected the minimal-fallback plus onboarding-skill architecture; the skill remains proposal-first and repository writes require explicit approval.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-19 | Bytes | Activated the removal of the always-on default and the Lead-only project onboarding skill with managed resource migration. |
