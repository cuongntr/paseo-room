# Orchestration Quality Hardening — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | The 2026-09-18 repository orchestration review (since removed from the tree), independently challenged by Oracle and accepted for implementation by the repository owner |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Routing decision | Brownfield; role authority and control-plane capability boundaries change; Technical Design → Implementation Plan → Beads; decided 2026-09-18 by repository owner |

## Routing Decision

- **Variant preset:** brownfield.
- **Triggered risks:** public/model-facing role contract; privilege and control-plane boundary; cross-adapter behavior; generated-state compatibility; multi-session handoff.
- **Required artifacts/gates:** Technical Design (`design-ready`) and Implementation Plan (`plan-ready-for-beads`). No PRD amendment: the accepted requirements are the repository review plus the owner's explicit implementation decision, and product intent is unchanged.
- **Execution path:** plan → converter → implementation.
- **Exceptions:** vendor behavior that remains unproven is documented rather than enforced as fact.
- **Decided:** 2026-09-18 — Repository owner.
- **Supersedes:** none. Partly superseded: the workspace-reader and prompt-granularity decisions below are replaced by [`workspace-protocol-prompt-simplification.md`](workspace-protocol-prompt-simplification.md); the runtime capability decisions in this document remain active.

## 1. Boundaries

This design owns:

- anti-pre-solving, independent-judgment, and Supervisor observation/advice contract gaps;
- truthful clarification of the room's conservative one-writable-Peer policy and task-risk model/effort defaults;
- Peer capability hygiene for shared skills, plugins, hooks, commands, and operator MCP configuration;
- Codex active-profile multi-agent/catalog pins and fail-closed catalog scrubbing;
- provider/profile diagnostics that detect capability-affecting drift;
- managed-entry replacement safety and atomic regular-file/symlink replacement;
- contract provenance and removal of duplicated authoritative procedure from active docs.

This design does not own:

- an operating-system sandbox or a claim that Peer cannot contact a local daemon through arbitrary shell/network code;
- filtering or rewriting operator MCP, hook, plugin, model, or credential configuration;
- speculative enforcement of `ultra` / `ultracode` as delegation without vendor evidence;
- a Supervisor notebook or a new persistent artifact;
- moving Lead discovery/recovery into a skill;
- relaxing the current project-wide single writable Peer policy in this release;
- a custom Claude command-line prompt hack. Paseo's Claude provider uses the Agent SDK; a stronger provider-owned append channel requires Paseo support.

## 2. Decisions

### D1 — Capability hygiene is not sandboxing

Peer receives no Paseo-native room tools. The room also stops advertising or automatically loading known orchestration surfaces into Peer: `paseo*` skills are excluded, and executable plugin/hook/command resources are not shared with Peer. Supervisor and Lead retain the operator resources they already receive.

Peer still has full shell access. These controls prevent accidental capability pollution and close known configuration paths; they do not claim hostile-process containment. `docs/design.md` will distinguish task routing from seat-level capability closure so the existing “no per-seat model or skill routing” non-goal is not misread as requiring unsafe capability parity.

### D2 — Detect and fail; never rewrite operator control-plane configuration

If an operator MCP server is recognizably Paseo-related by server name, executable name, or URL/argument token, setup and verify fail before applying changes. The diagnostic names the source and asks the operator to remove or rename the conflicting Peer-visible server. The room does not delete, filter, or rewrite the operator's MCP configuration.

Detection is an explicit bounded heuristic, not a security scanner. It recognizes the token `paseo` at identifier/path boundaries and reports why it matched. Tests cover Codex `mcp_servers`, Claude `mcpServers`, and Pi `mcp.json`.

### D3 — Peer skills become an exact managed projection

For Supervisor and Lead, an existing operator `skills` directory remains one shared symlink. For Peer, the room creates an exact managed directory whose children are symlinks to non-`paseo*` operator skills. Setup reconciles stale children and verify reports additions/removals, so changing the operator skill inventory cannot silently leave Peer stale.

The exact managed-directory primitive is restricted to explicitly declared directories such as Peer `skills`; it is never used for role homes or credential-bearing paths.

### D4 — Codex closes profile precedence and fails closed without catalog evidence

The active Codex profile supports `model_catalog_json` and `features`; therefore generated role config writes the generated catalog path and disables `multi_agent` / `multi_agent_v2` in that profile as well as at top level. `[agents].enabled` remains top-level because Codex profiles do not support it.

A custom catalog replaces Codex's built-in catalog. The room must preserve its instruction fields; stripping them would risk an empty or invalid base prompt. Catalog capture remains setup-time generated state, but inability to obtain/parse the catalog is a failure because the design already states that scrubbing `multi_agent_version` is not redundant.

### D5 — Contract changes remain minimal and semantic

- Lead briefs state outcomes, boundaries, evidence, and reopen conditions without embedding a verdict or treating a plan/file list as binding.
- Peer receives an `Independent Judgment` section: form a technical position, challenge with evidence, and accept agreement when evidence supports it.
- Supervisor receives `Observation and Advice`: observe named process failures, ask Lead evidence-backed questions, and advise without acquiring technical authority.
- The existing project-wide one writable Peer limit remains in force and is documented as a conservative local divergence from the reference model. Worktree-enabled concurrency is deferred to a separate owner decision.
- The room Peer profile's model and thinking values are defaults. Lead may vary them only when repository protocol explicitly supplies a task-risk policy; provider, mode, workspace, parent, and feature constraints remain eligibility evidence. No claim is made that a particular thinking tier itself enables delegation.

#### D5.1 — Subsequent contract refinement (2026-09-18, supersedes the last D5 bullet)

The combined model/effort default above was later split asymmetrically, and the Peer brief gained an explicit disposition mandate. The rest of D5 stands as decided.

- The model stays the exact current Peer profile default unless the workspace protocol in force explicitly supplies model routing. Thinking effort is Lead's per-brief choice on task risk, uncertainty, context size/complexity, and verification burden: the lowest effort that can reliably answer the task, raised for architecture-sensitive, high-consequence, or weakly observable work, and restricted to an option the live Paseo/provider context establishes as supported so no identifier is invented. Disposition is one signal and never a fixed tier per disposition. Tiers advertising automatic delegation remain excluded, material-cost decisions remain Human's, and the eligibility evidence above is unchanged. (Superseded in placement: the risk/uncertainty/context/verification criteria now live in the default Workspace Protocol; Lead's durable contract keeps the profile-model restriction, supported-option requirement, automatic-delegation ban, and Human cost boundary.)
- Every Peer brief names exactly one disposition — Engineer, Architect, Reviewer, or Scout — with its mode and return contract. One Peer profile remains; the disposition is an assignment mandate, not seat identity. Reviewer returns approval evidence or findings and never a technical acceptance. (Superseded in part: the four disposition definitions now live in the default Workspace Protocol; Lead's contract keeps only the requirement that a brief select exactly one.)
- Package behavior is unchanged: `thinkingOptionId` is still seeded once and profile configuration stays operator-owned. This governs Lead's per-created-Peer launch configuration only.

### D6 — Runtime-owned Claude state is inspected narrowly

Claude `.claude.json` remains seed-once and runtime-owned. Setup/verify may parse only the `mcpServers` object and compare server names for diagnostics and Paseo-conflict detection; it does not synchronize, replace, or inspect authentication/history fields. New operator MCP names missing from a role produce a warning after the conflict check, not mutation.

### D7 — Managed replacement safety

Unexpected path types fail before deletion. A regular managed file may replace only an absent path or regular file; a managed symlink may replace only an absent path or symlink. A path the room declares absent — generated content a current option suppresses — is deleted only when it is a regular file, so a directory, symlink or special file there fails instead. The explicit managed-directory projection may migrate the legacy whole-directory symlink and reconcile only its declared child names.

Files and symlinks are created at a unique sibling temporary path and atomically renamed into place. Temporary artifacts are cleaned on failure. This is local replacement safety, not transaction machinery; rerunning setup remains the recovery model.

## 3. Architecture

```text
operator homes
  ├─ config / MCP declarations ── parse + bounded Paseo conflict checks
  ├─ skills ───────────────────── Supervisor/Lead: shared directory link
  │                               Peer: exact managed child-link projection
  └─ plugins/hooks/commands ───── Supervisor/Lead only where supported
                       │
                       ▼
agent build plans ── entries + diagnostics + provider pins
                       │
                       ▼
shared desired-state planner
  ├─ exact provider env/params/tool-policy comparison
  ├─ profile identity + operator-owned tuning diagnostics
  ├─ managed file/link/directory planning
  └─ contract digest in room marker
                       │
                       ▼
apply: refuse unexpected type → sibling temp → rename → refresh
```

The adapter seam remains `Agent.build()`. Shared helpers may be introduced for resource projection and MCP conflict inspection, but provider construction stays centralized in `commands.ts`, and `ROLE_PASEO_TOOLS` remains the only Peer room-tool policy source.

## 4. Compatibility and Migration

Existing rooms currently have `roles/<agent>/peer/skills` as a symlink. The first upgraded setup migrates that one known managed path to an exact directory of child symlinks. It never traverses or deletes operator skill contents. If the path has become a real unrecognized directory before this version, setup fails rather than assuming ownership.

Contract changes cause expected managed-file drift. Operators inspect dry-run, apply setup, then restart affected seats. Existing model contexts do not reload the contract.

The room marker gains an optional contract digest. Old markers remain readable. Applying the upgrade writes the digest; rollback to an earlier package ignores the extra JSON field only if that package schema permits it, so package-level rollback must regenerate the old marker through the prior setup. No credential or external data migration exists.

Containment is package-level: run the prior package with the same agent selection and `setup --apply`, then restart seats. No commit, stash, or destructive operator-home action is part of rollback.

## 5. Testing Strategy

Vitest tests use existing temporary `$HOME`, fake executable, and fake daemon patterns.

- Prompt tests assert semantic heading order and exact authority-bearing phrases for anti-pre-solving, independent judgment, observation/advice, writer-policy divergence, and model/effort defaults.
- Adapter tests prove Supervisor/Lead keep shared resources, Peer excludes executable orchestration resources, Peer skill inventory is exact and updates deterministically, and credentials remain untouched.
- MCP tests cover positive/negative detection in Codex TOML, Claude state JSON, and Pi `mcp.json`, including role-owned stale Claude state.
- Codex tests prove active-profile catalog/features pins and fail-closed catalog capture.
- Paseo tests prove extra live provider environment keys cause drift while unrelated top-level provider fields remain ignored.
- Marker tests prove backward-compatible parsing and deterministic contract digest rendering.
- Filesystem tests prove expected updates are atomic from the caller's perspective, unexpected types are preserved with failure, managed skill migration/reconciliation is bounded, and no temporary siblings remain.
- Integration tests retain dry-run, idempotence, credential preservation, drift repair, remove recovery, build, and packed-package evidence.

The mandatory completion gate remains `npm run verify` in repository order.

## 6. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Can `ultra` / `ultracode` enable delegation despite runtime closure? | Repository owner | unresolved vendor behavior; warning-only language, no hard enforcement in this phase |
| Q-002 | Can Paseo expose a provider-owned Claude SDK `systemPrompt.append` field? | Paseo upstream | unsupported by the current paseo-room provider schema; document limitation, no CLI argv workaround |
| Q-003 | Should repositories be allowed multiple writable Peers in isolated worktrees? | Repository owner | deferred; current conservative policy retained |
| Q-004 | Can every plugin-contributed subagent path bypass Claude `disallowedTools`? | Repository owner | unproven; Peer plugin sharing is removed regardless because plugins also contribute MCP/hooks |

No open question blocks the bounded implementation selected above.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | Bytes | Created and activated after repository review, independent Oracle challenge, vendor-source spikes, and design-ready self-review. |
| 2026-09-18 | Bytes | Added D5.1: explicit Peer disposition mandate in the brief, and asymmetric model-vs-thinking-effort policy superseding the last D5 bullet. |
| 2026-09-19 | Bytes | Recorded partial supersession by `workspace-protocol-prompt-simplification.md`: Lead is now the only standing workspace-protocol reader, Supervisor's is mandate-bound, disposition definitions moved to the workspace default, and prompt assets are cut by distribution. Runtime capability decisions unchanged. |
