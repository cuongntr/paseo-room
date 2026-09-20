# Role Contract Maintainability and Paseo Runtime Guard — PRD

| Field | Value |
|---|---|
| Status | Accepted; workspace-default portions superseded |
| Owner | Repository owner |
| Created | 2026-09-16 |
| Related product PRD | [Historical Paseo Room PRD](paseo-room-prd.md) — historical context only; current behavior is defined by the README and design notes |
| Routing decision | Brownfield; contract/packaging compatibility, trusted-plugin security boundary, new Paseo plugin dependency, multi-phase delivery; PRD → Technical Design → Implementation Plan → Beads; decided 2026-09-16 by Repository owner |
| Superseded by | [Lead Project Onboarding Skill design](../design/lead-project-onboarding-skill.md) for the default workspace document, workspace carrier, and workspace-digest requirements only |

> **Supersession note.** This PRD remains the accepted source for Markdown role ownership,
> semantic headings, additive carriers, asset validation, packaging, and the plugin track. Its
> requirements to preserve and package a room-owned default workspace protocol are historical:
> the later repository-owner decision removes that default and its generated room carrier, keeps
> repository workflow optional and Lead-read, and ships a Lead-only onboarding skill instead.

## Routing Decision

- **Variant preset:** brownfield
- **Triggered risks:** new architecture/dependency; generated and packaged instruction contract; trusted-plugin security boundary; multi-session handoff; phased delivery
- **Required artifacts/gates:** PRD (`prd-ready`), Technical Design (`design-ready`), Implementation Plan (`plan-ready-for-beads`), feature closure (`feature-done`)
- **Execution path:** plan → converter
- **Exceptions:** none
- **Decided:** 2026-09-16 — Repository owner
- **Supersedes:** none; the original product PRD remains historical and is not an active requirements source

## 1. Context

The role contract is the most important behavioral asset in `paseo-room`: it defines authority boundaries and compensates for orchestration constraints that Paseo cannot currently enforce. Its wording is nevertheless stored as TypeScript template literals, assembled through numeric `RC-*` and `WP-*` identifiers, and rendered with those opaque identifiers as headings in the documents read by agents.

This representation makes prompt changes harder to author and review than ordinary Markdown. It also conflates internal composition keys with model-facing structure: the identifiers help implementation and tests select content, but provide little meaning to the receiving model. Additional model-facing prose, including Pi-specific capsules and role prefaces, is spread across implementation files rather than presented as one reviewable content system.

Paseo v0.8 preview plugins add launch hooks, lifecycle events, daemon-side RPCs, and native UI surfaces. These capabilities may strengthen runtime validation and observability, particularly where the current room relies on procedural role instructions. They do not remove the need for durable role homes, credential isolation, offline setup and verification, or explicit login and removal flows. Plugin availability and API maturity must therefore be proven before any plugin becomes part of the supported product surface.

This initiative first makes the role contract a maintainable, semantically structured artifact while preserving current behavior. It then evaluates an optional companion plugin as a defense-in-depth runtime guard and user interface. The CLI remains the durable enforcement and recovery floor for this initiative. Replacing that floor, including any setup, login, verification, or removal responsibility, requires a separate accepted PRD and routing decision.

## 2. Goals and Success Evidence

- **G-001 — Markdown-first contract ownership:** Maintainers can read, edit, and review all room-owned model-facing prose as Markdown without navigating TypeScript data literals.
  - **Success evidence:** Every room-owned role document, workspace-protocol fragment, and Pi-specific prompt capsule has one canonical Markdown source. Phase 1 itself preserves wording; afterward, a prompt-only wording change requires no TypeScript production-source edit unless composition changes. Behavioral tests may change when authority-bearing wording changes, but do not pin incidental phrasing.
- **G-002 — Semantic runtime instructions:** Generated documents communicate their sections through meaningful headings rather than opaque numeric codes.
  - **Success evidence:** Generated Supervisor, Lead, Peer, and workspace documents contain semantic headings and contain no rendered `RC-*` or `WP-*` heading codes.
- **G-003 — Behavior-preserving delivery:** The refactor preserves role authority, every existing contract statement, per-role content distribution, additive vendor prompt delivery, setup/verify drift behavior, and published-package operation.
  - **Success evidence:** A reviewed traceability map accounts for every existing `RC-*` clause and `WP-*` section in the new semantic structure; the complete project verification gate passes; focused negative tests prove that Peer receives no topology/orchestration content and that all three vendor carriers receive the intended exact document.
- **G-004 — Evidence-based plugin decision:** The project reaches a documented go/no-go decision on an optional Paseo companion plugin using current public APIs and explicit failure-mode evidence.
  - **Success evidence:** A bounded feasibility phase demonstrates or disproves each required hook, lifecycle, disable/reload, ordering, version, and parentage property without making the plugin mandatory.
- **G-005 — Stronger optional runtime visibility:** If the feasibility decision is “go,” operators can inspect room health and material policy violations inside Paseo without weakening CLI behavior when the plugin is absent.
  - **Success evidence:** The optional plugin reports its own state and supported checks, and disabling or removing it leaves the CLI-generated room in its previously supported safe state.

## 3. Out of Scope

- Replacing Codex, Claude Code, Pi, or Paseo base system prompts.
- Reimplementing Paseo's built-in Codex, Claude, or Pi providers as plugin providers.
- Moving interactive vendor login, destructive room removal, or daemon-down recovery exclusively into a plugin.
- Removing isolated role homes or sharing mutable credentials between seats.
- Treating a trusted plugin as an operating-system security sandbox.
- Expanding the orchestration model, changing role authority, or introducing additional room roles as part of the Markdown migration.
- Making the companion plugin mandatory or a prerequisite for any documented guarantee in this initiative.
- Claiming complete runtime enforcement of creator/parent authority when the public hook contract does not expose the required evidence before creation.
- Operator-facing CLI output, authentication guidance, diagnostics, and release prose are not prompt-source migration targets, except where documentation must explain this feature's operator impact.
- Replacing the CLI as the durable enforcement or recovery floor within this initiative; any such proposal requires a separate PRD and routing decision.
- Moving `ROLE_NOTES` profile metadata into Markdown in Phase 1; it remains short, typed Paseo configuration rather than a role document or prompt capsule.

## 4. Affected Actors

- **Role-contract maintainer:** Evolves authority and workflow wording, needs document-native review, clear section names, and reliable evidence that each role receives only the intended content.
- **Repository reviewer:** Reviews behavioral changes without reconstructing a document from TypeScript literals or interpreting internal numeric codes.
- **Room operator:** Runs setup and verify, expects existing role isolation and prompt delivery to remain intact, and may optionally install a trusted plugin for native status and runtime guardrails.
- **Adapter maintainer:** Changes a vendor adapter without duplicating prompt content or silently altering the cross-agent role contract.
- **Paseo plugin maintainer:** Maintains an explicitly version-bounded, optional integration whose failure or absence must not disable the room's durable controls.

## 5. Operational Journeys

- **Review and change the contract:** A maintainer opens the Markdown prompt sources, reads the role and workspace wording with semantic headings, changes one bounded statement, runs verification, and sees precisely which generated role documents and behavioral assertions are affected.
- **Update an installed room:** An operator upgrades `paseo-room`, previews setup, sees expected prompt drift, applies the update, restarts the relevant seats, and verifies that the generated carriers and live provider/profile chain agree.
- **Evaluate the plugin safely:** A maintainer installs the feasibility plugin on an explicitly plugin-enabled test daemon, exercises agent creation, resume, reload, disable, conflicting-hook, and invalid-topology cases, then records a go/no-go decision without changing the CLI's supported guarantees.
- **Use optional runtime visibility:** After a “go” decision and release, an operator opens a Paseo room-health surface to inspect prompt generation, room provider/profile state, and supported policy findings; the surface distinguishes enforced, detected-after-the-fact, and unverifiable conditions.
- **Recover without the plugin:** The plugin is disabled, incompatible, or failed. Existing CLI setup, verify, login guidance, and remove behavior continue to work, and room seats do not silently gain authority or native multi-agent capabilities because a plugin hook disappeared.

## 6. Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Store shared, Supervisor, Lead, and Peer contract prose—including model-facing document titles and role prefaces—in canonical Markdown sources. | P1 | A wording-only change to any listed category is made in Markdown; each category has one identifiable canonical source; no duplicate authoritative copy exists in TypeScript or another Markdown file. |
| REQ-002 | Store the default workspace protocol—including its model-facing title and preface—and Pi-specific communication/runtime capsules in canonical Markdown sources appropriate to their layers. | P1 | Topology, verification, review, repository-convention, workspace preface, Pi communication, and Pi runtime wording each have one identifiable source; Pi capsules remain vendor-specific content ordered before the role document; role authority is not moved into the workspace or vendor-specific layers. |
| REQ-003 | Render meaningful semantic headings and retire numeric composition identifiers. | P1 | Generated role and workspace documents contain descriptive headings; active composition uses semantic keys rather than `RC-*` or `WP-*` numeric keys; semantic keys and other implementation identifiers are not emitted unless they are themselves meaningful document headings. |
| REQ-004 | Preserve deterministic role-specific composition and ordering. | P1 | All seats receive shared authority; Supervisor receives Supervisor obligations; Lead receives Lead obligations; Lead and Peer receive challenge signals; Peer receives no topology or seat-creation instructions; repeated renders are byte-identical. |
| REQ-005 | Fail closed when a required prompt fragment or composition reference is missing or invalid. | P1 | Setup, verification, tests, or build fail with an actionable error rather than rendering an empty section or publishing an incomplete document. |
| REQ-006 | Preserve the existing additive delivery contract for Codex, Claude Code, and Pi. | P1 | Codex still receives the exact role document through `developer_instructions` and its readable copy; Claude still receives operator memory followed by the role document; Pi still receives operator append, Pi capsules, and the role document through its pinned append file. |
| REQ-007 | Preserve setup, verify, and update behavior for generated prompt drift. | P1 | A modified generated carrier makes `verify` fail; dry-run reports the repair; `setup --apply` restores the expected content without modifying operator homes or credential contents. |
| REQ-008 | Publish every prompt asset required by the installed CLI and prove the packed artifact works independently of the source checkout. | P1 | A packed-package test renders all role and workspace documents from an isolated install with no missing source asset and no repository-relative dependency. |
| REQ-009 | Retire numeric contract identifiers and update contributor and design documentation to use semantic section names. | P1 | `RC-*` and `WP-*` remain only in the one-time migration traceability map; active code, tests, README, contributor guidance, orchestration model, and design notes neither use them as authoring/citation keys nor direct maintainers to removed TypeScript prose maps. |
| REQ-010 | Provide complete migration traceability while preserving existing statement text and rendered order. | P1 | A reviewed map accounts for every existing `RC-*` clause and `WP-*` protocol section exactly once. Structural merge/split may regroup semantic headings with an explicit rationale, but statement text and its order in each rendered role/workspace document remain byte-identical; any wording, authority, or statement-order change is reviewed separately after Phase 1. |
| REQ-011 | Conduct a bounded Paseo plugin feasibility evaluation before committing to a supported plugin product. | P1 | The evaluation records results for prompt/config mutation, session environment mutation, duplicate-Lead prevention, creator/parent evidence, plugin ordering, disable/reload behavior, version compatibility, UI/RPC viability, and behavior with no app connected; feasibility artifacts are labeled unsupported and excluded from the published `paseo-room` package. |
| REQ-012 | Keep the CLI-generated role and provider configuration as the enforcement and recovery floor throughout feasibility and initial plugin delivery. | P1 | With the plugin absent or disabled, these baseline guarantees remain true: native multi-agent paths stay closed through every required agent and provider surface, Peer receives no Paseo tools, each seat retains isolated role homes and credentials, prompt delivery remains additive, and CLI setup/verify/auth/remove behavior remains available under the compatibility claims in the accepted README, `docs/design.md`, and `AGENTS.md`. |
| REQ-013 | Produce an explicit plugin go/no-go decision with bounded claims. | P1 | The decision names which conditions can be prevented before creation, which can only be detected/remediated afterward, which remain procedural, the minimum supported Paseo range, and the consequences of plugin disablement. |
| REQ-014 | If approved, provide an optional room-health and runtime-guard plugin without duplicating the canonical role contract. | P2 | The plugin identifies itself as optional, exposes only verified checks/actions, labels evidence boundaries, and consumes a versioned shared contract artifact or avoids injecting contract text; it does not maintain an independent prose copy. |
| REQ-015 | If approved, make plugin lifecycle failure visible and safe. | P2 | Install/reload/disable/incompatibility states are visible; hook failures do not silently claim enforcement; disabling or removing the plugin leaves durable CLI-managed controls intact. |
| REQ-016 | Document migration and operator impact for prompt output changes. | P1 | Release guidance explains expected one-time `verify` drift, the required `setup --apply` and seat restart, and the distinction between generated configuration evidence and already-running model context. |

## 7. Non-Functional Requirements

- **Maintainability:** Model-facing prose is reviewable as ordinary Markdown. Composition policy remains small and understandable, and maintainers are not required to learn a second prompt-authoring language beyond Markdown.
- **Reliability:** Rendering is deterministic and missing assets fail closed. Existing setup/verify exact-content comparison remains authoritative for generated carriers.
- **Security:** Operator prompt/config resources and credential contents remain unread or preserve-only according to existing policy. Any plugin is treated as trusted, unsandboxed code and requires explicit operator enablement. Plugin checks must not overstate procedural or post-creation evidence as pre-creation enforcement.
- **Availability:** CLI dry-run, source-level validation, login guidance, and local recovery remain usable without a running plugin. Operations that require Paseo continue to fail clearly when the daemon is unavailable.
- **Compatibility:** Phase 1 preserves Node 22+, macOS/Linux support, existing CLI flags, room paths, provider/profile identities, and supported vendor carriers. Plugin phases declare an explicit Paseo semver range and remain optional.
- **Performance:** No specific latency target is introduced; rendering role documents requires no network access or external process invocation.
- **Reviewability:** Behavioral prompt changes and composition changes are distinguishable in code review. Generated output does not expose implementation-only identifiers.
- **Testability:** `npm run verify` remains the completion gate. Tests cover source loading, composition, negative role distribution, adapter carriers, drift repair, and packed-package assets; plugin phases add lifecycle and disable/failure cases against the supported Paseo version range.

## 8. Boundaries and Dependencies

- **Depends on:** Existing role and workspace semantics in [demonthorn-agent-orchestration-deep-dive.md](../demonthorn-agent-orchestration-deep-dive.md), implementation rationale in [design.md](../design.md), Node.js 22+, tsup/npm packaging, Vitest, and the documented additive prompt contracts of Codex, Claude Code, and Pi.
- **Plugin feasibility additionally depends on:** Paseo's current public plugin and SDK contracts, an explicitly plugin-enabled test daemon, and a version matrix that includes the intended minimum release.
- **Does NOT own:** Paseo plugin API stability; Paseo core provider implementation; vendor base prompts; operator-authored global prompts; vendor authentication; OS-level sandboxing; project-specific root `WORKSPACE_PROTOCOL.md`; changes to the underlying Supervisor/Lead/Peer authority model.
- **Compatibility boundary:** Generated wording and headings may change intentionally, causing expected managed-file drift. CLI commands, room layout, role identity, authority semantics, provider/profile linkage, and credential ownership must remain compatible in Phase 1.

## 9. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 1 MVP — Markdown contract foundation | Move all room-owned model-facing prose to canonical Markdown; render semantic headings; retain typed deterministic composition through semantic keys; preserve all three vendor carriers, drift behavior, and package distribution; update active docs and tests. | REQ-001 through REQ-010 and REQ-016 pass; `npm run verify` passes; the traceability map accounts for every prior clause/protocol section; the packed artifact renders every document outside the source checkout; review confirms no active `RC-*`/`WP-*` identifiers or duplicate prompt prose remain. |
| Phase 2 — Plugin feasibility gate | After Phase 1 passes `feature-done`, is included in a published release, and the repository owner gives a separate approval, create only the bounded feasibility artifacts needed to test the listed v0.8 hook, lifecycle, parentage, ordering, disable/reload, version, RPC, and UI claims; keep them outside supported enforcement and the published CLI package. | Timebox: at most 3 working days. REQ-011 through REQ-013 pass within the timebox and results are reproducible on the declared Paseo versions, or the result is no-go. A signed-off decision classifies every proposed guarantee as preventable, detectable/remediable, procedural, or unsupported. Timeout defaults to no-go and closes the plugin track with Phase 1 remaining the supported outcome. |
| Phase 3 — Conditional companion plugin | Only after a “go”: deliver bounded runtime guards and room-health UI backed by proven APIs, while retaining CLI durable controls and a single prompt source. | REQ-014 and REQ-015 pass; plugin install/reload/disable/failure tests pass; no documented CLI guarantee regresses without the plugin; supported checks are accurately labeled in UI and docs. |
| Phase 4 — Conditional operational hardening | Only after Phase 3 ships: exercise release/update compatibility, multiple-plugin ordering, remote daemon topology where supported, and maintenance ownership; simplify or remove experimental surfaces that do not justify their cost. | A supported-version matrix, upgrade/rollback procedure, failure runbook, and maintenance decision exist; no unresolved high-risk finding remains in the supported plugin surface. |

Accepting this PRD authorizes Technical Design and planning for **Phase 1 MVP only**. Phase 2 requires Phase 1 to pass `feature-done`, ship in a published release, and receive a separate repository-owner approval; Phases 3 and 4 remain conditional on the Phase 2 go decision.

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | What Markdown fragment granularity gives the best balance between whole-role review and reusable shared sections? | Repository owner | open — resolve in Technical Design; does not change product scope |
| Q-002 | Should installed prompt assets be copied beside the bundle or embedded during build? | Repository owner | open — resolve in Technical Design with packed-package evidence |
| Q-003 | What exact Paseo version range is eligible for the feasibility matrix? | Repository owner | open — resolve before Phase 2 design; current v0.8 plugin API is preview |
| Q-004 | Does the public pre-create hook expose enough stable evidence to reject duplicate Leads without false positives across workspace and lifecycle states? | Repository owner | open — Phase 2 feasibility question; plugin delivery is blocked, Phase 1 is not |
| Q-005 | Should the optional plugin ship from this repository/package or as a separately versioned package? | Repository owner | deferred — decide only after a Phase 2 “go” result |
| Q-006 | Can an existing agent's saved prompt configuration be safely updated on plugin upgrade, or must prompt delivery remain exclusively file-backed for restart pickup? | Repository owner | open — Phase 2 feasibility question; no migration of canonical delivery is authorized by this PRD |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-16 | Bytes | Created Review draft covering Markdown-first role contracts, phased plugin feasibility, and the full product roadmap. |
| 2026-09-16 | Bytes | Added complete legacy-to-semantic traceability, explicit prose inventory and CLI baseline, feasibility containment, and conditional go/no-go roadmap exits after PRD review. |
| 2026-09-16 | Repository owner | Accepted PRD: retire numeric IDs, preserve statement text during migration, keep `ROLE_NOTES` out of Phase 1, keep the plugin optional, and require separate approval for a three-working-day Phase 2 feasibility gate. |
| 2026-09-16 | Bytes | Clarified that numeric keys are removed from active composition, semantic keys may remain, migration preserves statement text and rendered order, and Phase 2 starts only after a published Phase 1 release plus separate approval. |
