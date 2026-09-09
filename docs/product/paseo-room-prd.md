# Paseo Room — PRD

| Field | Value |
|---|---|
| Status | Accepted |
| Owner | Repository owner |
| Created | 2026-09-09 |
| Related service PRD | N/A — greenfield product |
| Routing decision | Greenfield; new public CLI and cross-agent orchestration contract; PRD → Technical Design → Implementation Plan → Beads; decided 2026-09-09 by Repository owner |

## Routing Decision

- Variant preset: greenfield
- Triggered risks: new architecture and dependencies; public CLI/config contract; security and privilege boundary; multi-agent/session handoff; phased delivery
- Required artifacts/gates: PRD (`prd-ready`), Technical Design (`design-ready`), Implementation Plan (`plan-ready-for-beads`), feature closure (`feature-done`)
- Execution path: plan → converter
- Exceptions: none
- Decided: 2026-09-09 — Repository owner
- Supersedes: none

## 1. Context

Paseo can run multiple coding-agent providers, but a personal three-seat orchestration setup still requires users to coordinate provider profiles, role instructions, isolated agent state, compatibility checks, and safe updates themselves. The reference `codex-room-setup` demonstrates the desired Supervisor/Lead/Peer operating model, but its installation is tied to Codex, Python/Bash, a pinned Paseo fork, and repository-specific paths.

Paseo Room will provide one reproducible npm-distributed setup for this operating model. The first phase preserves the observable Codex Room behavior while using a user-managed Paseo installation with native per-provider Paseo-tool policy. Later phases add Claude Code, Pi, and OpenCode through agent-specific adapters without weakening the shared authority contract.

## 2. Goals & Success Metrics

- **Goal G-001 — Reproducible personal room:** A user can create and verify a Supervisor/Lead/Peer Codex room without manually assembling runtime files or Paseo provider definitions.
  - **Success evidence:** On a supported fresh test home, one documented `npx paseo-room` flow reaches a verified three-provider inventory.
- **Goal G-002 — Safe ownership:** Installation, update, failed installation, and uninstall preserve user-owned Codex and unrelated Paseo state.
  - **Success evidence:** Automated acceptance tests cover repeated install, rollback after injected failures, customized-file preservation, and uninstall without changing canonical agent credentials/configuration.
- **Goal G-003 — Enforced role capability boundary:** Supervisor and Lead receive Paseo orchestration tools while Peer does not.
  - **Success evidence:** Live verification reports the effective policy for all three provider IDs and fails closed on an incompatible Paseo daemon.
- **Goal G-004 — Extensible agent model:** Adding a new supported coding agent does not require rewriting transaction, ownership, or shared role-contract logic.
  - **Success evidence:** The Phase 1 architecture defines an adapter contract and the Codex implementation conforms to it without Codex-specific behavior in shared lifecycle modules.
- **Goal G-005 — Human-friendly and automatable:** The same lifecycle supports guided personal setup and deterministic scripting.
  - **Success evidence:** Interactive wizard and non-interactive flags produce the same planned managed state; CI can run plan and verification without a TTY.

## 3. Out of Scope

- Installing, upgrading, authenticating, or repairing Paseo or any coding-agent CLI.
- Supporting Windows in Phase 1 MVP.
- Mixed-agent rooms where different seats use different coding agents.
- Claude Code, Pi, and OpenCode runtime adapters in Phase 1 MVP.
- Replacing Paseo's daemon, provider adapters, MCP/tool catalog, workspace model, or UI.
- Providing a hard security sandbox against a Peer that has unrestricted shell access; Phase 1 enforces Paseo tool delivery and role authority, not operating-system isolation.
- Building a mandatory Paseo plugin. A plugin may be introduced later for optional UI and observability.

## 4. Affected Actors

- **Personal operator:** Already uses a supported coding-agent CLI and Paseo, wants a repeatable room without losing personal configuration, authentication, sessions, or unrelated provider definitions.
- **Automation/CI operator:** Needs deterministic non-interactive planning and verification against disposable homes without accessing real credentials.
- **Future adapter maintainer:** Adds agent-specific runtime behavior while preserving the shared room protocol, ownership rules, and lifecycle safety.

## 5. Operational Journeys

- **First setup:** The operator runs `npx paseo-room`, reviews the detected Codex and Paseo prerequisites and the planned user-global changes, explicitly approves apply, starts or reloads their user-managed Paseo daemon when instructed, and receives a verified inventory containing Supervisor, Lead, and Peer with the intended tool policy.
- **Repeat/update:** The operator runs the current package version again. Paseo Room detects files it owns, stages the desired state, preserves unrelated or customized user files, applies only safe changes, and verifies the resulting room. Failure restores the prior managed state.
- **Uninstall:** The operator requests uninstall and reviews a plan. On explicit apply, Paseo Room removes only unchanged artifacts recorded as owned, restores or preserves affected prior values where possible, and leaves canonical Codex credentials/configuration plus unrelated Paseo state untouched.
- **Incompatible dependency:** The operator runs setup with missing, stopped, older, or capability-incompatible Paseo. No managed state is published; the command explains the exact mismatch and how the operator can install or upgrade Paseo themselves.

## 6. Functional Requirements

| ID | Requirement | Priority | Acceptance Criteria |
|---|---|---|---|
| REQ-001 | Provide an npm package named `paseo-room` executable through `npx`. | P1 | A packed package can be executed with `npx`/equivalent npm exec in a clean fixture without a global Paseo Room installation. |
| REQ-002 | Offer an interactive wizard and equivalent non-interactive commands/flags. | P1 | Given identical answers and flags, both modes produce an equivalent plan; non-interactive mode never prompts and reports missing required input as an error. |
| REQ-003 | Default to a read-only plan and require explicit approval for filesystem/configuration changes. | P1 | Running the default planning path leaves the test home byte-for-byte unchanged; apply occurs only after wizard confirmation or an explicit apply flag. |
| REQ-004 | Detect Codex and require an existing usable operator-owned Codex home without modifying it. | P1 | Missing prerequisites produce actionable errors; successful install leaves all canonical Codex files unchanged and references shareable resources without copying secrets into package-owned files. |
| REQ-005 | Detect both Paseo CLI and reachable daemon and require version `>=0.8.0-beta.1` plus native per-provider Paseo-tool policy. | P1 | Setup fails before publish when CLI or daemon is missing, too old, version-mismatched, unreachable, or lacks the required capability; it does not install Paseo automatically. |
| REQ-006 | Create three Codex provider profiles named `codex-supervisor`, `codex-lead`, and `codex-peer`. | P1 | Live provider inventory contains exactly the managed profiles with commands targeting their corresponding isolated runtimes. |
| REQ-007 | Apply the shared Human/Supervisor/Lead/Peer authority contract and role-specific instructions. | P1 | Generated role configurations contain the correct role identity and authority constraints; contract tests reject missing or contradictory required clauses. |
| REQ-008 | Enable Paseo tools for Supervisor and Lead and disable them for Peer using native provider policy. | P1 | Effective configuration and live verification show enabled for Supervisor/Lead and disabled for Peer; failure to prove this condition fails installation verification. |
| REQ-009 | Generate isolated Codex runtime homes while preserving approved shared operator resources. | P1 | Each role receives isolated generated configuration and mutable runtime state; canonical auth, global instructions, skills, and plugins remain operator-owned and are shared only through validated references. |
| REQ-010 | Disable Codex native multi-agent behavior inside managed role runtimes. | P1 | Runtime verification proves relevant native-agent settings/catalog metadata are disabled without changing the canonical Codex configuration. |
| REQ-011 | Apply changes transactionally with backup and rollback. | P1 | Failures during generation, publish, dependency interaction, or final verification restore the previous managed state; backups and generated secret-bearing paths are owner-only. |
| REQ-012 | Make install/update idempotent and preserve customized or unrelated state. | P1 | Applying the same desired state twice produces no semantic change; modified managed artifacts are preserved or require an explicit resolution and are never silently deleted. |
| REQ-013 | Provide `verify`, `doctor`, and safe `uninstall` lifecycle operations. | P1 | Each operation has deterministic exit status and machine-readable output option; uninstall requires explicit apply and removes/restores only manifest-owned state. |
| REQ-014 | Record managed ownership in a versioned installation manifest. | P1 | Update and uninstall decisions can be reconstructed from the manifest, including package version, adapter, destinations, checksums, backups, and compatibility baseline. |
| REQ-015 | Define an internal adapter contract for later Claude Code, Pi, and OpenCode support. | P1 | Shared lifecycle tests use the adapter interface; Phase 1 contains a Codex adapter and no conditional Codex path inside transaction primitives. |
| REQ-016 | Support macOS and Linux in Phase 1 MVP. | P1 | Automated tests run core lifecycle behavior on Linux; documented macOS verification covers user-global paths and a user-managed Desktop/daemon installation. |
| REQ-017 | Add homogeneous Claude Code rooms. | P2 | A later adapter passes the same room lifecycle and role-policy acceptance suite using Claude-native configuration and tool vocabulary. |
| REQ-018 | Add homogeneous Pi rooms. | P2 | A later adapter passes the shared suite using Pi RPC/config/extensions without assuming native MCP support that is absent. |
| REQ-019 | Add homogeneous OpenCode rooms. | P2 | A later adapter passes the shared suite while managing OpenCode's server/config lifecycle correctly. |

## 7. Non-Functional Requirements

- **Security:** Never package, log, or back up credentials outside owner-only storage. Refuse unsafe symlink/path aliasing into canonical agent homes. Treat agent and Paseo config as sensitive. Never claim OS-level isolation from provider tool policy alone.
- **Reliability:** Stage and validate complete desired state before publish. Use atomic replacement where supported and deterministic rollback for handled failures and termination signals. Document power-loss and `SIGKILL` limits.
- **Availability:** Planning and source-level diagnostics must work while Paseo daemon is stopped; live verification and apply steps that require daemon evidence must fail clearly rather than hang.
- **Performance:** A no-change plan or installed-state verification should normally finish within 5 seconds excluding startup/network behavior of external CLIs. Setup must not clone or build Paseo.
- **Portability:** Use Node.js APIs and explicit platform adapters where filesystem semantics differ. Phase 1 supports current macOS and mainstream Linux distributions.
- **Observability:** Human-readable output must identify phase, managed target, result, and remediation. A machine-readable mode must emit stable structured records without mixing protocol output with diagnostics.
- **Maintainability:** Shared lifecycle code must remain agent-agnostic; agent-specific paths, formats, tool names, hooks, and runtime generation belong to adapters.

## 8. Boundaries & Dependencies

- **Depends on:** Node.js/npm capable of running `npx`; user-installed and authenticated Codex CLI; user-installed Paseo CLI and reachable compatible daemon; filesystem support for safe user-global runtime management.
- **Does NOT own:** Canonical Codex home and credentials; installation or authentication of Codex; Paseo binaries, daemon lifecycle, application updates, identity, unrelated providers/workspaces/agents; project source repositories; operating-system sandboxing.
- **Compatibility baseline:** Paseo `>=0.8.0-beta.1` with native `paseoTools` provider policy. Compatibility is proven by capability and live behavior, not semver alone.

## 9. Roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| Phase 1 MVP | npm/npx CLI; user-global homogeneous Codex room; wizard + flags; plan/apply/verify/doctor/uninstall; manifest, transaction, rollback; compatible user-managed Paseo | Package acceptance suite passes; disposable install can be applied twice and safely uninstalled; live verification proves three providers and Supervisor/Lead/Peer Paseo-tool policy. |
| Phase 2 MVP | Homogeneous Claude Code adapter | Claude adapter passes shared lifecycle tests and Claude-specific instruction/config/tool-policy tests without changing canonical Claude state. |
| Phase 3 MVP | Homogeneous Pi adapter | Pi adapter passes shared lifecycle tests and verified RPC/extension integration without assuming unsupported core features. |
| Phase 4 MVP | Homogeneous OpenCode adapter | OpenCode adapter passes shared lifecycle and server/config integration tests. |
| Phase 5 | Optional mixed-agent rooms and optional Paseo plugin UI/observability | Mixed-role compatibility rules are explicit and tested; plugin remains optional and outside critical policy enforcement. |

## 10. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Should the first npm release be unscoped `paseo-room` or published under an owner scope if the unscoped name becomes unavailable? | Repository owner | answered — publish unscoped `paseo-room`; use an owner scope only if npm availability changes before publish |
| Q-002 | Which stable Paseo release will replace the beta compatibility floor? | Repository owner | deferred — adopt the first verified stable release containing native `paseoTools` policy |
| Q-003 | Should Phase 1 expose partial `disabledTools` policies or only the safer role defaults? | Repository owner | answered — Phase 1 exposes fixed all/none defaults only; Peer disables all Paseo tools |

## 11. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-09 | Bytes | Created Review draft from research and confirmed product decisions. |
| 2026-09-09 | Repository owner | Accepted PRD and authorized Technical Design. |
| 2026-09-09 | Repository owner | Confirmed unscoped npm package/CLI name `paseo-room`. |
