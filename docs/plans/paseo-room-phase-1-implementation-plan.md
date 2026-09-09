# Paseo Room Phase 1 — Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-09 — Repository owner |
| Owner | Repository owner |
| Routing decision | [PRD routing decision](../product/paseo-room-prd.md#routing-decision): greenfield; plan → converter; no exception |
| Source PRD / requirements | [Paseo Room PRD](../product/paseo-room-prd.md) |
| Source Technical Design | [Paseo Room Technical Design](../design/platform/paseo-room.md) and [Role Compatibility Contract](../design/platform/paseo-room-role-contract.md) |
| Related ADRs | N/A — the Active Technical Design owns the initial decisions |
| Phase | Phase 1 MVP |

## 1. MVP-Lock

- **In this phase:** REQ-001 through REQ-016: npm/npx Codex-only CLI; wizard and automation; dry-run/apply; Codex/Paseo probes; three homogeneous roles; role authority and native Paseo policy; isolated Codex homes; native-agent disable; manifest ownership; transaction/rollback/recovery; verify/doctor/uninstall; macOS and Linux.
- **Out of this phase:** REQ-017 through REQ-019; Claude Code, Pi, and OpenCode adapters; mixed-agent rooms; Windows; remote Paseo daemons; partial `disabledTools`; force adoption/deletion; Paseo installation/upgrade/daemon ownership; plugin UI; OS sandboxing; automatic migration from `codex-room-setup`.
- **Exit criteria:** A packed package executes from a clean fixture, plans without mutation, installs a verified room through a compatible isolated Paseo daemon, remains equivalent on second apply, survives package-cache deletion, recovers injected interruption, preserves customized/unrelated state, and safely uninstalls. Linux and macOS automated gates are green; the macOS GUI-like smoke and approved user-home R3 rehearsal are recorded. All REQ-001–REQ-016 acceptance criteria have traceable passing evidence.
- **Default checkpoint posture:** Automated tests and normal development use private temporary homes and the design's conditional compensation; they never target the operator's real Codex/Paseo home. The final owner-approved macOS R3 rehearsal is the sole exception and uses checksums/backups without copying credentials. There are no intentionally irreversible steps. Any divergence is contained as conflict or `recovery-required` under the [R3 decision](../design/platform/paseo-room.md#r3-decision), never force-overwritten.

> Phase scope is frozen after plan activation. Additions require an accepted delta-change.

## 2. Work Packages

### WP-001: Package foundation and stable contracts

- **Outcome:** A publishable strict-TypeScript npm package runs through npm exec with a minimal CLI entry, normalized intent model, typed result/check/operation envelopes, role constants, adapter interface, and deterministic human/JSON rendering. Test and fixture infrastructure is available for later packages without touching real user state.
- **Requirement / AC coverage:** REQ-001, REQ-002, REQ-003, REQ-015, REQ-016.
- **Design refs:** [Architecture and adapter contract](../design/platform/paseo-room.md#2-architecture), [Public CLI contract](../design/platform/paseo-room.md#4-public-cli-contract), [Implementation stack](../design/platform/paseo-room.md#24-implementation-stack).
- **Prerequisites:** none.
- **Sequencing:** Establish public types/schemas and injection seams before adapter, gateway, or transaction implementations. Do not implement mutating command behavior in this package.
- **Risk boundaries / decomposition hints:** Keep package/build setup, public output contract, and reusable fake interfaces separable; the public JSON schema is a consumer contract and needs golden proof.
- **Exit condition:** `npm pack` produces an executable package; typecheck/lint/unit tests pass; default and `--json` placeholder plans are read-only and conform to schema; fake adapter/gateway/filesystem can be injected without `any` or internal Paseo imports.

### WP-002: Codex discovery and role-runtime adapter

- **Outcome:** The Codex adapter safely discovers native or Node-script launch prefixes and a canonical home, renders all three role artifacts/instructions plus the operator-facing `workspace-protocol.md` template from the Active Role Compatibility Contract, shares only approved resources, disables native multi-agent behavior, and verifies its declared runtime without writing canonical Codex state.
- **Requirement / AC coverage:** REQ-004, REQ-007, REQ-009, REQ-010, REQ-015, REQ-016.
- **Design refs:** [Adapter contract](../design/platform/paseo-room.md#23-adapter-contract), [Managed layout](../design/platform/paseo-room.md#31-managed-layout), [Codex integration](../design/platform/paseo-room.md#52-codex), [Security](../design/platform/paseo-room.md#6-security), and the [Role Compatibility Contract](../design/platform/paseo-room-role-contract.md).
- **Prerequisites:** WP-001.
- **Sequencing:** Can proceed in parallel with WP-003 after shared contracts exist. Runtime building returns artifact declarations only; publishing remains deferred to WP-005.
- **Risk boundaries / decomposition hints:** Treat launch-prefix discovery, TOML/overlay generation, model-catalog transformation, path/link safety, and role instruction content as independently testable adapter concerns. The Role Compatibility Contract supplies the RC-001–RC-305 assertions and exact overlay values; no bead may infer role authority from reference prose. Preserve the clean-room boundary from reference source.
- **Exit condition:** Disposable native and npm-launcher fixtures produce valid role artifacts, workspace-protocol template, and provider inputs; unsupported shebangs/nested roots/link escapes fail closed; RC-001–RC-305 and native-agent-disable tests pass; canonical fixture bytes remain unchanged.

### WP-003: Paseo compatibility gateway and provider policy

- **Outcome:** A public-SDK-only gateway proves local CLI/daemon admission and compatibility, authenticates without persisting secrets, reads and patches provider configuration, checks active managed sessions, refreshes/waits for provider readiness, and verifies the fixed Supervisor/Lead/Peer policy. Admission uses canonical local home, current-user PID/owner evidence, normalized loopback listen endpoint, exact CLI/daemon version, and reachability; it does not claim connected-peer identity unavailable from the pinned public SDK.
- **Requirement / AC coverage:** REQ-005, REQ-006, REQ-008, REQ-016.
- **Design refs:** [Paseo integration contract](../design/platform/paseo-room.md#51-paseo), [Security](../design/platform/paseo-room.md#6-security), [Incompatible-daemon flow](../design/platform/paseo-room.md#82-apply-with-incompatible-daemon).
- **Prerequisites:** WP-001.
- **Sequencing:** Can proceed in parallel with WP-002. Implement read-only local-admission/config/snapshot behavior before mutation methods so planner and tests can consume stable facts.
- **Risk boundaries / decomposition hints:** Separate CLI status parsing, local home/PID/UID/listen admission, SDK connection lifecycle, version/capability policy, fixed-shape provider construction, mutation, and live verification. Contract tests must pin `@getpaseo/client` and Paseo `0.8.0-beta.1`; mocks alone are insufficient. The Repository owner accepted residual loopback peer-replacement risk because the pinned public client does not expose connected `serverId`; mutation must re-probe under the canonical home/listen lock and verify immediately afterward.
- **Exit condition:** Fake and isolated-daemon tests distinguish missing/stopped/auth-required/old/mismatched/remote daemons; one patch manages exactly the three fixed-shape entries while preserving unrelated providers; live read-back proves Supervisor/Lead enabled and Peer disabled; no secret appears in output.

### WP-004: Desired-state planner and ownership manifest

- **Outcome:** A read-only planner combines normalized intent, adapter declarations, daemon state, and manifest state into deterministic operations for first install, update, no-op, conflict, recovery requirement, and uninstall. Manifest v1 and ownership comparisons cover files, links, directories, providers, source drift, and residual uninstall state.
- **Requirement / AC coverage:** REQ-003, REQ-012, REQ-014, REQ-015.
- **Design refs:** [Persistent data model](../design/platform/paseo-room.md#3-persistent-data-model), [Planning and ownership](../design/platform/paseo-room.md#71-planning-and-ownership), [Offline plan](../design/platform/paseo-room.md#81-offline-plan).
- **Prerequisites:** WP-002 and WP-003.
- **Sequencing:** Freeze canonical operation ordering and ownership decisions before transaction execution. Planner must remain side-effect free, including when daemon checks are unavailable.
- **Risk boundaries / decomposition hints:** Manifest schema/validation, canonical comparison, source drift, provider fixed-key invariant, uninstall residuals, and plan rendering have distinct persistence/consumer boundaries. Unknown manifest versions and unmanaged collisions always fail closed.
- **Exit condition:** Decision-table and property tests cover every ownership state; repeated planning is byte-stable; offline plans emit `not-checked` without creating files/locks; unrelated providers and mutable Codex runtime paths never become owned operations.

### WP-005: Transaction, global lock, rollback, and recovery

- **Outcome:** Planned operations execute through one journaled transaction with private staging/backups, portable journaled capture plus no-clobber per-file publication, daemon-namespace locking, one provider patch, conditional reverse compensation, explicit commit points, and recoverable interruption. First-install root creation is preceded by a durable deterministic sibling bootstrap sidecar and transfers authority to the internal journal before sidecar retirement, so pre-existing roots remain non-adoptable collisions. Update/removal may briefly leave a managed destination absent between durable atomic steps; ordinary concurrent destination-name changes are preserved as recovery evidence. Partial uninstall commits a residual manifest rather than deleting customized state.
- **Requirement / AC coverage:** REQ-003, REQ-006, REQ-011, REQ-012, REQ-013, REQ-014, REQ-016.
- **Design refs:** [Transaction journal](../design/platform/paseo-room.md#33-transaction-journal), [Apply and rollback](../design/platform/paseo-room.md#72-apply-and-rollback-flow), [Locking](../design/platform/paseo-room.md#73-locking-and-idempotency), [Recovery flow](../design/platform/paseo-room.md#84-recovery-around-the-commit-point), [R3 decision](../design/platform/paseo-room.md#r3-decision).
- **Prerequisites:** WP-003 and WP-004.
- **Sequencing:** Implement mutation against fakes/temp homes first; no live-home execution until failure injection covers every journal state and commit boundary. Recovery is part of the same persistence contract, not deferred cleanup.
- **Risk boundaries / decomposition hints:** Keep root bootstrap, filesystem publish, Paseo patch compensation, lock security/staleness, commit reconciliation, and residual uninstall as explicit evidence/rollback domains. The global lock key must converge across room roots and endpoint aliases. By Repository-owner decision, first-install bootstrap uses a deterministic sibling owner-only sidecar before root creation, and portable Node 22 filesystem replacement uses transaction-declared unpredictable capture names followed by no-clobber publication; deliberate same-UID interference with bootstrap/transaction-private names or captured inodes and same-inode writes through existing descriptors are outside Phase 1 and must be serialized.
- **Exit condition:** Fault injection before/after every mutation reaches old committed state, new committed state, or preserved `recovery-required`—never silent loss; two-root/URL-alias concurrency admits one writer; repeated apply is a no-op; modes are `0700/0600`; handled signals compensate.

### WP-006: Complete CLI lifecycle and guided UX

- **Outcome:** The wizard and automation flags drive the same planner/executor for `plan`, `install`, `verify`, `doctor`, `recover`, and `uninstall`; dry-run remains default and only confirmation/`--apply` mutates. Human diagnostics and stable JSON/exit codes provide actionable dependency, conflict, verification, and recovery results.
- **Requirement / AC coverage:** REQ-001, REQ-002, REQ-003, REQ-005, REQ-013.
- **Design refs:** [Public CLI contract](../design/platform/paseo-room.md#4-public-cli-contract), [Critical flows](../design/platform/paseo-room.md#8-critical-interaction-and-failure-flows), [Observability and reliability](../design/platform/paseo-room.md#7-reliability-and-consistency).
- **Prerequisites:** WP-002, WP-003, WP-004, and WP-005.
- **Sequencing:** Wire commands only after lifecycle services have deterministic contracts. Wizard is a thin intent collector; it must not gain a separate apply path.
- **Risk boundaries / decomposition hints:** Command routing, TTY cancellation, non-interactive validation, human renderer, JSON renderer, and exit mapping are distinct public-consumer seams; keep mutation authorization centralized.
- **Exit condition:** Golden/black-box tests prove wizard/flags produce equivalent plans, non-interactive mode never prompts, default invocations do not mutate, only confirmation/`--apply` reaches transaction code, and every documented outcome maps to the specified JSON/exit contract.

### WP-007: Cross-component acceptance and release hardening

- **Outcome:** Phase 1 is proven as a packed npx-style artifact across disposable homes, an isolated compatible Paseo daemon, fake and real Codex smoke paths, failure/recovery cases, Linux CI, and the macOS GUI-like environment. User documentation states prerequisites, ownership/security limits, lifecycle commands, recovery, and safe removal.
- **Requirement / AC coverage:** REQ-001 through REQ-016 and all Phase 1 exit criteria.
- **Design refs:** [Testing strategy](../design/platform/paseo-room.md#9-testing-strategy), [Backward compatibility](../design/platform/paseo-room.md#11-backward-compatibility-migration-and-rollback), [Phase scope](../design/platform/paseo-room.md#10-phase-scope-summary).
- **Prerequisites:** WP-006.
- **Sequencing:** Acceptance fixtures may be built earlier, but release evidence runs only against the packed artifact after all lifecycle commands exist. Automated runs use disposable room/Codex homes and an isolated daemon. The final macOS owner-approved user-home rehearsal follows the Active Design's R3 controls: capture canonical checksums and managed-state backups, use the user-managed local daemon, never copy credential content, verify, then safely uninstall/restore managed state.
- **Risk boundaries / decomposition hints:** Isolated Paseo contract tests, real Codex smoke, packed-cache-deletion test, platform verification, security review, and operator documentation are separate evidence domains. Any failed critical contract blocks release rather than being waived by mock coverage.
- **Exit condition:** Phase exit criteria and every REQ-001–REQ-016 acceptance criterion link to passing evidence; package contents contain no credentials/reference code/cache links; Linux and macOS automated gates pass; GUI-like smoke and the owner-approved macOS user-home R3 rehearsal are recorded; install/update/recover/uninstall documentation matches observed behavior.

## 3. Dependencies

```text
WP-001 ──┬──> WP-002 ──┐
         └──> WP-003 ──┼──> WP-004 ──> WP-005 ──> WP-006 ──> WP-007
                       └──────────────> WP-005
```

| Edge | Reason |
|---|---|
| WP-002 depends on WP-001 | Codex implements the adapter/artifact/result contracts and uses the test seams. |
| WP-003 depends on WP-001 | Gateway implements shared result schemas and injectable process/SDK boundaries. |
| WP-004 depends on WP-002 | Planner needs concrete Codex discovery, artifact, and provider declarations. |
| WP-004 depends on WP-003 | Planner needs normalized live daemon/provider facts. |
| WP-005 depends on WP-003 | Transaction needs the proven mutation/read-back/session interfaces. |
| WP-005 depends on WP-004 | Executor consumes frozen operations and ownership decisions. |
| WP-006 depends on WP-002–WP-005 | Commands compose all adapter, gateway, planning, transaction, and recovery behavior. |
| WP-007 depends on WP-006 | Packed end-to-end evidence requires the complete public lifecycle. |

The graph is acyclic. WP-002 and WP-003 are the only intended parallel implementation branches after WP-001.

## 4. Test Strategy

- **Unit:** Vitest tests for schemas, intent normalization, renderers, path/link safety, Codex codec/catalog/roles, semver/local-admission policy, ownership decisions, lock keys, journal reconciliation, and exit mapping.
- **Property/fuzz:** Unrelated provider preservation, path escape resistance, operation ordering stability, and idempotent normalization.
- **Integration with fakes:** Temporary homes plus fake process, filesystem-fault, clock/PID, adapter, and Paseo gateway boundaries. Inject failure at every mutation and commit edge; assert conditional compensation and redaction.
- **Paseo contract:** Isolated Paseo `0.8.0-beta.1` daemon/home and fake Codex app-server validate public SDK patch/read-back/snapshot behavior, exact `<prefix> app-server` argv, policy, active-session refusal, and provider removal.
- **Packed black box:** Execute `npm pack` output through npm exec semantics, compare wizard/flags, apply twice, remove package cache, verify profiles remain launchable, recover interruptions, preserve customized files, and uninstall.
- **Real Codex/platform:** Credential-free disposable Codex home for app-server/config smoke. The full automated suite runs on Linux and macOS. macOS also runs a minimal GUI-like environment smoke, followed before release by the owner-approved user-home R3 rehearsal with pre/post canonical checksums, managed backups, no credential copying, and cleanup verification.
- **Coverage floor:** At least 85% branch coverage for `src/core`, `src/paseo/provider-policy`, and `src/adapters/codex` safety logic. More importantly, every ownership row, journal state, public exit code, and PRD acceptance criterion must have explicit test evidence; aggregate coverage cannot substitute for these cases.
- **Gate order:** typecheck → lint → unit/property tests → integration tests → package build/pack → isolated live-contract and platform smoke tests.

## 5. Risk Modules

- **Data / migration:** Manifest/journal schema v1 is initial and unknown versions fail closed. No user data backfill occurs. Partial uninstall writes a residual manifest; full uninstall deletes the manifest only after a committed journal. Future schema/provider-key removal requires a separate migration design.
- **Public contract / consumers:** Human operators and CI scripts consume commands, JSON schema v1, and exit codes; Paseo daemon consumes fixed provider entries; Codex provider consumes launch prefix and role homes. Golden CLI tests and pinned Paseo contract tests are provider-first evidence. Breaking JSON/exit semantics require a schema/version migration; additive fields remain compatible.
- **Auth / security:** `PASEO_PASSWORD` is memory-only; canonical credentials are linked, never copied/backed up/hashed. Peer denial is fail-closed and verified from live daemon config. Negative tests cover missing policy, secret redaction, path/link escape, foreign lock ownership, unsupported launchers, collision adoption, and modified-file deletion. Weakening these boundaries requires repository-owner review.
- **Rollout / containment:** The package remains dry-run until explicit apply. Files publish before provider activation; verification precedes manifest commit. Failure conditionally rolls back; divergence stops at `recovery-required`. No automatic mutation retry, daemon management, force deletion, or real-home CI occurs; only the separately approved macOS R3 rehearsal may target the operator environment.
- **R3 decision:** Repository owner owns risk. Disposable-home rehearsal with injected failures, full Linux/macOS automated gates, macOS GUI-like smoke, and one owner-approved macOS user-home rehearsal are mandatory before release. The user-home rehearsal captures checksums/backups, does not copy credentials, and verifies cleanup/rollback. There are no accepted irreversible points. Direct Paseo-file replacement and blind backup restore remain declined alternatives.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | Paseo public SDK has no revision/ETag for external same-ID writers. | Fixed managed IDs/key set, global own-writer lock, immediate read-back, conditional rollback; Repository owner. | contained — external concurrent edits to managed IDs unsupported |
| R-002 | Version-managed Node/Codex paths can disappear after apply. | Store absolute launch prefix; `doctor` detects drift; re-apply updates it; no npm-cache path; Repository owner. | contained |
| R-003 | Shared auth/plugins can be written through by Codex. | State truthful boundary; installer never writes/dereferences canonical targets; real Codex smoke; Repository owner. | contained, not sandboxed |
| R-004 | Beta Paseo contract can change before stable. | Pin SDK/daemon contract fixture to `0.8.0-beta.1`; upgrade only with suite; Repository owner. | contained; stable floor deferred |
| R-005 | The pinned public client does not expose connected daemon identity, so a loopback peer could be replaced between status and SDK probes. | Local-only home/PID/UID/listen/version admission; canonical home+listen lock key; re-probe after lock; immediate post-mutation full read-back; Repository owner. | accepted as contained residual risk — 2026-09-09 |
| Q-001 | Which stable Paseo release replaces the beta floor? | Repository owner; no Phase 1 implementation depends on this answer. | deferred, non-blocking |

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-09 | Bytes | Created Draft with seven dependency-aware work packages for Phase 1 MVP. |
| 2026-09-09 | Bytes | Review pass pinned WP-002 to the Active role contract and reconciled macOS release/R3 evidence with the Active Technical Design. |
| 2026-09-09 | Bytes | Clarified workspace-protocol/provider-creation ownership; plan-ready-for-beads passed and Phase 1 scope was activated/frozen. |
| 2026-09-09 | Repository owner / Bytes | Applied accepted local-admission delta: replace unavailable connected-server-ID proof with canonical home/PID/UID/listen/version evidence and bind locking/manifest to canonical home plus normalized listen. |
