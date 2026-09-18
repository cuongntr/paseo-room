# Markdown Role Contract — Phase 1 Implementation Plan

| Field | Value |
|---|---|
| Status | Active |
| Plan-ready | PASS — 2026-09-16 — Repository owner |
| Owner | Repository owner |
| Routing decision | [Accepted PRD routing decision](../product/role-contract-and-plugin-prd.md#routing-decision): brownfield; generated-contract, packaging, multi-session, and phased-delivery risks; plan → converter; Phase 1 only |
| Source PRD / requirements | [Role Contract Maintainability and Paseo Runtime Guard PRD](../product/role-contract-and-plugin-prd.md) |
| Source Technical Design | [Markdown Role Contract Technical Design](../design/role-contract-markdown.md) |
| Related ADRs | N/A — the active design found no governing ADR and introduces no architectural dependency |
| Phase | Phase 1 MVP — Markdown contract foundation |

## 1. MVP-Lock

- **In this phase:** REQ-001 through REQ-010 and REQ-016. Deliver canonical Markdown prompt assets, semantic composition and headings, preserved statement bytes/order and carrier behavior, actionable missing-asset failure, managed-file drift repair, npm package distribution evidence, migration traceability, active documentation updates, and operator migration/restart guidance.
- **Out of this phase:** REQ-011 through REQ-015; all Paseo plugin feasibility, plugin packaging, hooks, UI/RPC, and runtime guards; `ROLE_NOTES`; the generated operator authentication guide in `src/auth.ts`; the `room.json` marker; changes to authority, wording, role distribution, providers/profiles, credentials, CLI flags, or vendor carriers; and any public prompt-rendering API or new CLI command. The closed prompt-migration inventory is Technical Design §7.
- **Exit criteria:** All Phase 1 acceptance criteria in the PRD pass; the design's one-to-one traceability map matches the final semantic manifest; no active code, test, README, contributor guidance, orchestration model, or design rationale uses retired numeric identifiers or deleted prose-map paths; `npm run verify` passes the expanded typecheck → lint → test → build → packed-package chain; packed output renders every role/workspace document without `src/`; expected drift/repair and seat-restart guidance are documented; no transitional duplicate prompt source remains.
- **Default checkpoint posture:** This phase has no irreversible state or R3 action. Keep each work package independently reviewable and contain a failure by reverting only that package's owned edits or reinstalling the prior npm version and rerunning `setup --apply`; never discard unrelated work or role-owned credentials. Do not release until the complete expanded verification gate passes.

After activation, this scope is frozen. Any change to contract wording, authority, role distribution, carrier semantics, or plugin scope requires an accepted delta-change or new PRD/design decision rather than an added bead.

## 2. Work Packages

### WP-001: Canonical Markdown assets and semantic renderer

- **Outcome:** All room-owned role/workspace prose and Pi capsules have one canonical Markdown source. A lazy, validated, synchronous loader and typed semantic manifest replace numeric prose maps while preserving statement text, order, separators, role distribution, and deterministic output.
- **Requirement / AC coverage:** REQ-001, REQ-002, REQ-003, REQ-004, REQ-005 (loader fail-closed portion), REQ-006, REQ-010.
- **Design refs:** Technical Design §§2.1–2.4, §3.1, §4.1–4.2, §6, §7.
- **Prerequisites:** none.
- **Sequencing:** Establish and verify the transitional legacy-vs-Markdown characterization evidence within this package; remove `src/room/clauses.ts`, `src/room/workspace.ts`, migrated Pi literals, and the temporary legacy fixture only after the semantic renderer satisfies that comparison. WP-001 also lands the mechanical assertion/import updates forced by semantic headings and the `instructionIds()` / `protocolIds()` → `instructionKeys()` / `protocolKeys()` rename in `test/instructions.test.ts`, `test/cli.test.ts`, `test/codex.test.ts`, `test/claude.test.ts`, and `test/pi.test.ts`, so `npm test` is green when the package closes.
- **Risk boundaries / decomposition hints:** The Markdown asset tree, loader/manifest, renderer composition, and temporary characterization evidence are one compatibility boundary. If decomposed, no child may delete the legacy source before another child has established byte-preservation evidence, and the package cannot close while a duplicate authoritative prose copy remains.
- **Exit condition:** The final source tree and tests prove manifest/filesystem bijection, fragment shape, semantic heading sequences, deterministic renders, exact statement/order/separator preservation, correct role/workspace distribution, Pi capsule ordering, and no numeric `RC-*`/`WP-*` composition key or rendered heading in production code or tests. Stale numeric citations and deleted-path references in comments and active documentation are WP-004's outcome; the Technical Design traceability table is the permanent legacy-ID inventory.

### WP-002: CLI containment and managed-carrier compatibility

- **Outcome:** Prompt-asset failures are actionable and contained on both scripted and wizard paths, while every existing carrier, setup/verify drift comparison, dry-run repair, and operator/credential boundary continues to behave as before.
- **Requirement / AC coverage:** REQ-005, REQ-006, REQ-007.
- **Design refs:** Technical Design §3.2–3.3, §4.1–4.2, §6.
- **Prerequisites:** WP-001 — requires the prompt-asset error type and semantic renderer.
- **Sequencing:** Exercise the existing adapter and CLI fixtures against the semantic renderer; keep `remove` and other non-rendering recovery paths independent of prompt asset reads.
- **Risk boundaries / decomposition hints:** CLI error mapping and carrier/drift regression evidence are distinct test seams but share the same outcome. Any split must leave the wizard and flag-driven paths behind the same error policy and must not broaden generic CLI diagnostic changes. WP-002 adds containment, carrier, and drift evidence on top of WP-001's green suite; it does not repair WP-001's mechanical heading/key assertion updates.
- **Exit condition:** Missing/malformed assets yield exit 1 with logical-asset and reinstall guidance on both command paths without an unhandled rejection; Codex, Claude, Pi, and room carriers receive the intended exact document; drift is detected and repaired; operator homes and credential contents remain untouched.

### WP-003: Build, npm package, and mandatory package-boundary gate

- **Outcome:** `npm run build` copies the complete canonical Markdown tree beside `dist/index.js`; `npm run verify` runs a dedicated offline packed-package test after build; the installed artifact loads every role/workspace asset without source-checkout fallback and fails clearly when an asset is missing.
- **Requirement / AC coverage:** REQ-005 (installed-package failure), REQ-008; supports REQ-001 and REQ-007 package operation.
- **Design refs:** Technical Design §2.5, §4.3, §6.
- **Prerequisites:** WP-001 for the final asset manifest/layout; WP-002 for actionable packaged CLI failure messages.
- **Sequencing:** The package test consumes a completed build, disables npm lifecycle scripts while packing, uses its dedicated Vitest config, and remains excluded from the ordinary test invocation. It reserves an ephemeral loopback port and closes it before execution rather than relying on a hard-coded port. No workflow edit is required because `.github/workflows/ci.yml` and `.github/workflows/release.yml` already invoke `npm run verify`.
- **Risk boundaries / decomposition hints:** Build-copy behavior and packed execution are one distribution boundary. The package test must run outside the checkout with only `node_modules` linked, use isolated `$HOME` and fixture binaries, target a deliberately closed loopback port, never pass `--apply`, and distinguish connection failure from asset failure by message.
- **Exit condition:** The expanded `npm run verify` chain executes the package test; tarball contents exactly cover the registered prompt assets; the complete extracted package reaches the expected post-render connection failure; deleting one extracted asset produces the earlier named-asset/reinstall failure; no network install or operator daemon/config is used. The expanded gate passes on the existing `ubuntu-latest` and `macos-latest` CI matrix, and CI's post-gate `node dist/index.js --version` check remains green.

### WP-004: Semantic documentation and operator migration guidance

- **Outcome:** All active contributor, conceptual, rationale, README, code-comment, and verification-gate references use canonical Markdown paths and semantic section names. Operators receive accurate one-time drift, apply, restart, running-context, and rollback guidance.
- **Requirement / AC coverage:** REQ-009, REQ-016; documentation evidence for REQ-003, REQ-010.
- **Design refs:** Technical Design §3.3, §6–§8.
- **Prerequisites:** WP-001 for final semantic names/paths; WP-003 for the final verification command and package behavior.
- **Sequencing:** Documentation reflects implemented names and commands rather than anticipated ones. The Technical Design traceability table remains the sole legacy-ID inventory.
- **Risk boundaries / decomposition hints:** Keep conceptual authority in `docs/orchestration-model.md`, implementation rationale in `docs/design.md`, contributor procedure in `AGENTS.md`, and operator/release guidance in README; do not duplicate the contract prose into documentation.
- **Exit condition:** A reviewed repository sweep finds no active citation/use of any exact legacy identifier enumerated in Technical Design §7, no old composite headings such as `WP-01 Topology`, and no references to deleted prose maps or symbols (`src/room/clauses.ts`, `src/room/workspace.ts`, `instructionIds`, `protocolIds`). The Technical Design traceability table is the sole exact-ID inventory; generic pattern descriptions in the accepted PRD/plan and plan work-package labels are not legacy citations. Active docs describe the expanded verification chain and exact upgrade/rollback procedure; links resolve.

## 3. Dependencies

| Edge | Reason |
|---|---|
| WP-002 depends on WP-001 | CLI containment and carrier regression tests need the final prompt error type and semantic renderer. |
| WP-003 depends on WP-001 | Build and package evidence need the final asset manifest, paths, and renderer. |
| WP-003 depends on WP-002 | The negative packed-package case must observe the implemented named-asset/reinstall error policy. |
| WP-004 depends on WP-001 | Active docs must cite the final semantic names and canonical paths. |
| WP-004 depends on WP-003 | Contributor and operator docs must state the final verified build/package command and behavior. |

The graph is acyclic. WP-002 and the WP-001-dependent portion of WP-003 are not treated as parallel execution because both touch prompt failure semantics and shared CLI/package evidence; the converter may only parallelize leaves after checking file ownership.

## 4. Test Strategy

Vitest remains the unit/integration framework, with real temporary `$HOME` fixtures and fake executables/daemon clients following current repository patterns.

- **Loader/source tests:** manifest/filesystem bijection, H1/H2 shape, non-empty statements, semantic key coverage, lazy successful caching, retry after failure, normalization, hard-line preservation, and actionable malformed/missing errors.
- **Composition tests:** exact semantic heading order, shared/role distribution, Peer topology/orchestration negatives, focused authority invariants, deterministic repeated renders, no numeric keys/headings, workspace full-copy behavior, and Pi outer ordering.
- **Carrier/integration tests:** exact `renderInstructions()` equality for Codex, suffix/order guarantees for Claude and Pi, managed drift detection, dry-run repair, idempotence, role-home isolation, and credential preservation.
- **CLI error tests:** flag-driven and wizard paths both contain prompt-asset errors and emit reinstall guidance; non-rendering recovery remains usable.
- **Package test:** separate `vitest.package.config.ts`, executed only after build, proves tarball asset completeness and packed positive/negative render boundaries without source or network access.
- **Migration evidence:** a temporary legacy fixture/characterization comparison is used only while moving prose, then removed before the final full gate; final tests enforce that no duplicate authoritative prose remains.
- **Documentation sweep (reviewed, not a new lint rule):** search for every exact legacy ID from Technical Design §7, old composite workspace headings, deleted prose-map paths, and retired exported symbols; record the clean result while excluding only the traceability table and generic pattern/plan labels.

No percentage coverage threshold is introduced because the repository has no coverage instrumentation or accepted numeric target. Minimum acceptable coverage is requirement-based: every automated failure/compatibility boundary listed above has automated evidence; REQ-009's documentation/path retirement and the mechanical prose move additionally require explicit repository-search and migration-diff review.

## 5. Rollout and Containment

- **Activation:** Publish the Phase 1 package only after `npm run verify` passes, including the packed-package test.
- **Operator migration:** Upgrade, run dry-run setup to inspect expected heading drift, run `setup --apply`, then restart affected seats. Already-running model contexts are not updated retroactively.
- **Rollback:** Reinstall the prior package version, run its `setup --apply`, and restart affected seats. No data backfill, credential migration, or provider/profile identity migration exists.
- **Containment:** A missing package asset fails before managed writes; package verification blocks release. The package test uses a closed loopback target and never the operator's daemon.
- **R3 decision:** N/A — no destructive, irreversible, weak-rollback, schema, credential, or coordinated rollout action is introduced.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | A mechanical prose move changes whitespace, statement order, or Pi/workspace hard line breaks. | Transitional characterization comparison, traceability review, separator-specific tests; Repository owner. | mitigated in WP-001 |
| R-002 | `import.meta.url` resolves differently after bundling or assets are omitted from npm. | Proven spike, fixed root-level bundle invariant, explicit copy step, tarball inventory, packed execution; Repository owner. | mitigated in WP-003 |
| R-003 | Package testing accidentally reaches an operator daemon or network dependency. | Isolated `$HOME`, fake status binary, closed loopback port, linked installed dependencies, lifecycle scripts disabled, never `--apply`; Repository owner. | mitigated in WP-003 |
| R-004 | Removing numeric maps leaves stale citations or a second prose authority. | Repository-wide search, final duplicate-source assertion, semantic documentation WP; Repository owner. | mitigated in WP-004 |

No open question blocks conversion. PRD Q-003 through Q-006 remain deferred to the separately approved Phase 2 plugin track and do not affect any Phase 1 work package.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-16 | Bytes | Created Draft with four Phase 1 work packages, acyclic dependencies, compatibility evidence, package-boundary verification, and rollback containment. |
| 2026-09-16 | Bytes | Clarified WP ownership for forced test updates versus documentation cleanup, closed the non-prompt inventory, pinned reviewed documentation evidence, and added CI inheritance requirements after plan review. |
| 2026-09-16 | Repository owner | Activated and froze Phase 1 scope after `plan-ready-for-beads` passed with no blocking question. |
| 2026-09-18 | Bytes | Reference only, frozen scope unchanged: see [change-001 — Strong Claude contract carrier](role-contract-markdown-change-001-strong-claude-carrier.md), which supersedes the optional Phase-2 plugin feasibility gate for the Claude system-prompt carrier alone. |
