# Markdown Role Contract — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [Role Contract Maintainability and Paseo Runtime Guard PRD](../product/role-contract-and-plugin-prd.md) |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Routing decision | [Accepted PRD routing decision](../product/role-contract-and-plugin-prd.md#routing-decision): brownfield, generated-contract and packaging compatibility risk; Technical Design → Implementation Plan → Beads; Phase 1 only |

## 1. Boundaries

This design owns Phase 1 of the accepted PRD:

- canonical Markdown sources for role documents, the default workspace protocol, and Pi-specific prompt capsules;
- typed, deterministic composition through semantic keys;
- synchronous rendering into the existing Codex, Claude Code, Pi, and room-copy carriers;
- prompt-asset packaging, validation, drift behavior, and packed-package evidence;
- migration traceability from the numeric contract identifiers to semantic sections; and
- active documentation changes required to cite semantic sections.

This design does not own:

- any wording, statement-order, authority, role-distribution, provider/profile, credential, or carrier change;
- `ROLE_NOTES`, general operator-facing CLI/authentication/diagnostic prose, or project-specific root `WORKSPACE_PROTOCOL.md` files; the only CLI diagnostic change is the actionable prompt-asset failure required by REQ-005;
- a public prompt-rendering API or a new CLI command;
- Paseo plugin feasibility or implementation; or
- Phase 2 through Phase 4 of the PRD.

There is no persistence, API, authentication, authorization, network, or external-service change. No ADR is required: the design changes the representation and packaging of an existing contract without introducing a new architectural dependency.

## 2. Architecture

### 2.1 Component and interaction model

```text
src/room/prompts/**/*.md
  canonical document heads, semantic sections, workspace sections, Pi capsules
                  │
                  ▼
src/room/prompts.ts
  typed manifest ─ lazy readFileSync(import.meta.url) ─ shape validation ─ memoization
                  │
         ┌────────┴─────────┐
         ▼                  ▼
src/room/instructions.ts   src/agents/pi.ts
semantic ordered maps      Pi capsule ordering
         │                  │
         └────────┬─────────┘
                  ▼
       existing generated carriers
  Codex developer_instructions + readable copy
  Claude operator memory + role document
  Pi operator append + capsules + role document
  room/WORKSPACE_PROTOCOL.md

npm run build
  tsup → dist/index.js
  Node cpSync → dist/prompts/**/*.md
                  │
                  ▼
       npm package publishes dist/
```

`renderInstructions()` remains synchronous and deterministic. The loader reads an asset only on first use and memoizes the validated result. Lazy loading is required so commands that do not render prompts, especially recovery-oriented commands such as `remove`, do not fail solely because a prompt asset is damaged or absent. `setup` and `verify` do render the desired state and therefore fail closed.

The source and built layouts deliberately preserve the same relative asset root:

- source loader: `src/room/prompts.ts` → `./prompts/...`;
- bundled loader: `dist/index.js` → `./prompts/...`.

This invariant depends on the current single root-level tsup entry with `splitting: false`. The packed-package test guards it; adding a nested entry or enabling splitting requires revisiting asset resolution.

### 2.2 Prompt asset layout and granularity

Each independently distributed semantic section is one Markdown file. This is the smallest granularity that preserves the existing composition rules: shared sections go to all seats, Challenge Signals goes to both Lead and Peer at different positions, and Peer omits Workspace Topology.

The layout and distribution below record the state at this migration. Both have since changed — the one-file-per-heading rule was replaced by one file per independently distributed review unit in [`workspace-protocol-prompt-simplification.md`](workspace-protocol-prompt-simplification.md); see the note under the traceability table in §7 — and `src/room/instructions.ts` with `src/room/prompts.ts` are current.

```text
src/room/prompts/
  documents/
    supervisor.md
    lead.md
    peer.md
    workspace.md
  contract/
    shared/
      human-authority.md
      workspace-protocol-precedence.md
      evidence-and-event-waiting.md
      scope-and-unrelated-work.md
    supervisor/
      directive-integrity.md
      technical-non-interference.md
      lead-discovery-and-recovery.md
      escalation-boundaries.md
    lead/
      project-technical-ownership.md
      moving-write-ownership.md
      complete-peer-brief.md
      technical-acceptance.md
      independent-review.md
      peer-seat-lifecycle.md
    shared-lead-peer/
      challenge-signals.md
    peer/
      bounded-outcome.md
      writing-and-review-scope.md
      no-orchestration.md
      reproducible-handoff.md
      no-self-acceptance.md
  workspace/
    topology.md
    verification.md
    review.md
    repository-conventions.md
  pi/
    communication-style.md
    runtime.md
```

The four `documents/*.md` files contain the current H1 title and preface. Contract and workspace files contain one semantic H2 heading followed by the existing statement paragraphs. Pi files contain their current complete H1 capsule.

Contract/workspace prose stays wrapped for review. The loader preserves the existing normalizer: blank lines delimit statements and line breaks inside a statement collapse to one space. Rendering adds the existing `- ` list marker, separated from its H2 heading by exactly one newline. This keeps statement bytes, ordering, and within-section separators unchanged while allowing readable source wrapping. No general-purpose Markdown parser is introduced.

Document heads and Pi capsules load verbatim after `trimEnd()`: their body text is not statement-normalized, so the workspace preface's internal hard line breaks and both Pi capsule bodies remain exact. Source files keep a conventional trailing newline; the renderer's `\n\n` joins and single final newline remain the only separators between fragments.

### 2.3 Typed composition

Numeric identifiers are removed from active code. TypeScript retains only semantic implementation keys, for example:

```ts
type ContractKey =
  | 'humanAuthority'
  | 'workspaceProtocolPrecedence'
  | 'challengeSignals'
  | 'noOrchestration';
```

The actual union is inferred from a literal asset manifest rather than duplicated manually. Ordered maps define:

- the four shared contract sections;
- Supervisor, Lead, and Peer section sequences;
- the workspace sections each role receives; and
- the full workspace-document sequence.

Semantic keys are never rendered. The H2 heading in each Markdown file is the model-facing label and the citation name used by active documentation. The manifest contains paths and kind metadata only; no authoritative prose is duplicated in TypeScript.

The repository functions are renamed from `instructionIds()` / `protocolIds()` to `instructionKeys()` / `protocolKeys()`. They remain composition introspection for tests, not a published package API.

### 2.4 Loading and validation

The prompt loader uses only Node 22 built-ins:

```ts
readFileSync(new URL('./prompts/<path>.md', import.meta.url), 'utf8')
```

It performs bounded structural validation without interpreting arbitrary Markdown:

- every asset must be readable, UTF-8 text, and non-empty after trimming;
- document heads and Pi capsules must begin with exactly one H1 heading;
- contract and workspace sections must begin with exactly one H2 heading;
- a section must contain at least one non-empty statement;
- contract/workspace statements retain their declared order; and
- every manifest reference must resolve to one asset of the expected kind.

A missing, unreadable, empty, or malformed asset throws an actionable error naming the logical asset and advising package reinstallation. It never renders an empty section. Reads and parsed results are memoized after successful validation; failures are not cached.

A filesystem-bijection test ensures every source Markdown asset is registered and every registry path exists. Runtime production code does not scan directories, so output and package behavior are independent of filesystem enumeration order.

### 2.5 Build and package distribution

`package.json` continues publishing only `dist/`. The build remains tsup followed by a Node built-in copy step equivalent to:

```bash
node --input-type=module -e "import { cpSync } from 'node:fs'; cpSync('src/room/prompts', 'dist/prompts', { recursive: true })"
```

Using Node rather than `cp` preserves current macOS/Linux support without adding a shell-specific dependency. `tsup` cleans `dist/` first, then the copy creates `dist/prompts`. `prepack` already invokes `npm run build`, so the same asset copy runs for releases.

The chosen runtime-asset design is preferred over compile-time text imports because Vitest/Vite and tsup would otherwise need separate Markdown transforms plus an ambient TypeScript module declaration. A spike on 2026-09-16 proved all three required mechanics:

- Vitest can read a source-relative Markdown asset through `import.meta.url`;
- a root-level tsup ESM bundle can read the correspondingly copied asset; and
- `dist/prompts/*.md` is included by the package's existing `files: ["dist/"]` rule.

No source-checkout-relative fallback is permitted. Such a fallback would hide packaging defects and violate fail-closed behavior.

## 3. Interaction and Failure Flows

### 3.1 Successful render

1. A command builds desired room state.
2. The adapter requests a role document, or the room builder requests the workspace document.
3. The renderer obtains the ordered semantic keys for that document.
4. The loader reads and validates each not-yet-cached Markdown asset relative to `import.meta.url`.
5. The renderer joins document head, contract sections, workspace head/sections, and the final newline exactly once.
6. Existing adapter code writes or embeds that exact result without carrier changes.

Pi remains a separate outer composition:

```text
operator APPEND_SYSTEM.md
→ Pi communication capsule
→ Pi runtime capsule
→ rendered role document
```

### 3.2 Missing or malformed asset

1. The first render that references the asset fails before desired-state comparison or writes.
2. A dedicated prompt-asset error identifies the logical asset and expected package location.
3. Both command paths contain the failure: the zero-argument wizard runs inside the same error boundary as flag-driven commands, and `src/cli.ts` maps a prompt-asset error to reinstall guidance instead of the generic Paseo-connectivity fix.
4. `setup`/`verify` exits as failed with no unhandled rejection or incomplete generated document.
5. A non-rendering recovery command remains available because loading is lazy.

### 3.3 Drift after upgrade

Semantic headings intentionally change generated bytes. Existing exact-content comparison reports managed-file drift. Dry-run shows the repair; `setup --apply` rewrites managed carriers; the operator restarts affected seats so already-running model contexts do not retain the old prompt.

## 4. Testing Strategy

The existing Vitest stack remains authoritative. Tests separate composition policy from incidental wording.

### 4.1 Source and loader tests

- Assert manifest/filesystem bijection, expected asset kinds, non-empty fragments, and heading shape.
- Assert section normalization while document heads and Pi capsules preserve their existing internal hard line breaks.
- Assert a missing or malformed asset yields exit 1 with an asset-naming, reinstall-advising message on both flag-driven and wizard paths, with no unhandled rejection.
- Assert repeated reads and repeated renders are byte-identical.
- After the transitional fixture is removed, assert no production TypeScript or test fixture contains an authoritative duplicate of migrated prose.
- During migration only, keep the legacy prose under `test/fixtures/legacy-prompts/` and run a transitional characterization comparison between legacy and Markdown renderers after mapping old headings to their semantic replacements; require identical statement text, statement order, workspace-preface line breaks, Pi capsule bodies, carrier separators, and final newlines. Remove the fixture and comparison before Phase 1 closes.

### 4.2 Composition and behavioral tests

- Assert the exact semantic heading sequence for Supervisor, Lead, Peer, and workspace documents.
- Assert all seats receive shared authority; Supervisor/Lead/Peer receive only their intended sections.
- Retain focused authority-bearing phrase checks where they protect a real failure mode.
- Retain negative tests proving Peer receives neither Workspace Topology nor seat-creation/orchestration sections.
- Assert no rendered heading or active semantic key matches the retired `RC-*` / `WP-*` patterns.
- Assert Codex, Claude, Pi, and the room copy receive the exact `renderInstructions()` result in the existing order.
- Assert Pi's operator append and both capsules precede the role document.
- Retain exact-content drift, dry-run repair, idempotence, and operator-home/credential protection tests.

Phase 1 does not retain a second golden copy of the old contract. Byte preservation is established by the transitional characterization comparison, one-to-one traceability map, mechanical source move, migration-diff review, unchanged statement ordering, and behavioral/carrier tests. Removing the transitional duplicate prevents a second prompt source from becoming authoritative.

### 4.3 Built and packed-package tests

The `verify` script in `package.json` becomes:

```text
typecheck → lint → unit/integration tests → build → packed-package test
```

A dedicated `vitest.package.config.ts` includes only `test/**/*.package.test.ts`; the normal `vitest.config.ts` continues excluding those files to prevent pack/build recursion. The `test:package` invocation uses the dedicated config after build and first asserts `dist/index.js` exists, so an excluded test, stale output, or absent build cannot produce a false green.

The package test:

- packs with lifecycle scripts disabled because `verify` has just built the artifact;
- extracts the tarball to a temporary directory outside the checkout and symlinks only the repository's installed `node_modules`, giving the package no access to `src/` and adding no network dependency;
- verifies the complete registered prompt asset set exists under the extracted `dist/prompts`;
- runs the packed CLI as a dry-run `setup` against an isolated `$HOME`, a fake `paseo daemon status --json` that reports a version-matched daemon on a deliberately closed loopback port, a fake Codex executable, and valid operator Codex config; Codex constructs the workspace and all three role documents before the expected Paseo client connection failure;
- distinguishes outcomes by message rather than exit code: the complete package reaches the expected connection failure, while an asset-loading failure does not; and
- removes one asset in a second extracted fixture and verifies the earlier failure names that logical asset and advises reinstallation.

Unit/integration tests continue proving exact rendered content and carrier equality; the packed test proves the distribution boundary rather than duplicating every semantic assertion. It never uses `--apply` or contacts the operator's configured daemon.

## 5. Phase Scope Summary

### In Phase 1 MVP

REQ-001 through REQ-010 and REQ-016:

- Markdown canonical sources and semantic headings;
- semantic typed composition;
- behavior-preserving carriers and drift repair;
- package assets and package-boundary evidence;
- traceability and active documentation updates; and
- operator migration/restart guidance.

### Deferred

REQ-011 through REQ-015 and every plugin artifact, API investigation, UI surface, and runtime guard remain outside this design. Phase 2 cannot begin until Phase 1 passes `feature-done`, is released, and receives separate owner approval.

## 6. Compatibility, Migration, and Containment

### Preserved contracts

- `renderInstructions()` remains synchronous and deterministic.
- Existing CLI flags, paths, provider/profile identities, role homes, credential ownership, and Paseo tool policy remain unchanged.
- Codex continues using `developer_instructions` plus its readable copy.
- Claude continues placing operator memory before the role document.
- Pi continues placing operator append, communication capsule, runtime capsule, then role document in its pinned append file.
- The room continues writing the complete default protocol to `room/WORKSPACE_PROTOCOL.md`.
- Statement text, statement order, the workspace preface's internal line breaks, both Pi capsule bodies, and carrier separators remain byte-identical; only document/section headings and their structural Markdown representation change.

### Migration and rollback

There is no persisted-data migration and no coordinated rollout. Upgrading creates expected managed-file drift; applying setup and restarting seats is the forward migration.

Rollback is package-level: reinstall the prior `paseo-room` version and run its `setup --apply`, then restart affected seats. Role-owned credentials and operator homes are untouched. Because generated prompts are desired state rather than durable user data, no reverse data transformation is needed.

R3 destructive/weak-rollback review is not applicable: the change writes only the same managed carriers already owned by setup, and the prior package deterministically restores the prior bytes.

## 7. Migration Traceability Map

This table is the sole retained use of the retired numeric identifiers. Every existing contract/protocol section maps one-to-one; there are no merges, splits, wording changes, or order changes.

| Legacy ID | Semantic key | Model-facing heading | Distribution |
|---|---|---|---|
| RC-001 | `humanAuthority` | Human Authority | All roles |
| RC-002 | `workspaceProtocolPrecedence` | Workspace Protocol Precedence | All roles |
| RC-003 | `evidenceAndEventWaiting` | Evidence and Event-Driven Waiting | All roles |
| RC-004 | `scopeAndUnrelatedWork` | Scope and Unrelated Work | All roles |
| RC-101 | `directiveIntegrity` | Directive Integrity | Supervisor |
| RC-102 | `technicalNonInterference` | Technical Non-Interference | Supervisor |
| RC-103 | `leadDiscoveryAndRecovery` | Lead Discovery and Recovery | Supervisor |
| RC-104 | `escalationBoundaries` | Escalation Boundaries | Supervisor |
| RC-201 | `projectTechnicalOwnership` | Project Technical Ownership | Lead |
| RC-202 | `movingWriteOwnership` | Moving Write Ownership | Lead |
| RC-203 | `completePeerBrief` | Complete Peer Brief | Lead |
| RC-204 | `challengeSignals` | Challenge Signals | Lead and Peer |
| RC-205 | `technicalAcceptance` | Technical Acceptance | Lead |
| RC-206 | `independentReview` | Independent Review | Lead |
| RC-207 | `peerSeatLifecycle` | Peer Seat Lifecycle | Lead |
| RC-301 | `boundedOutcome` | Bounded Outcome | Peer |
| RC-302 | `writingAndReviewScope` | Writing and Review Scope | Peer |
| RC-303 | `noOrchestration` | No Orchestration | Peer |
| RC-304 | `reproducibleHandoff` | Reproducible Handoff | Peer |
| RC-305 | `noSelfAcceptance` | No Self-Acceptance | Peer |
| WP-01 | `topology` | Topology | Supervisor, Lead, and workspace copy |
| WP-02 | `verification` | Verification | All roles and workspace copy |
| WP-03 | `review` | Review | All roles and workspace copy |
| WP-04 | `repositoryConventions` | Repository Conventions | All roles and workspace copy |

The table records the state at this package's migration. Distribution, keys and file
boundaries have since changed twice. First, the workspace layer and Workspace Protocol
Precedence narrowed to Supervisor and Lead, and `writingAndReviewScope` became
`assignmentScope`. Then
[`workspace-protocol-prompt-simplification.md`](workspace-protocol-prompt-simplification.md)
consolidated the tree into review units — `contract/shared-authority.md`,
`contract/shared-seat-identity.md`, `contract/challenge-signals.md`, one
`contract/<role>.md` body per role, and one complete `workspace/default.md` — gave the
workspace layer to Lead alone, made Supervisor's protocol reading mandate-bound, and moved
repository workflow policy out of Lead's durable contract into the workspace default. Only
`src/room/instructions.ts` and `src/room/prompts.ts` are current.

The non-numbered inventory also migrates one-to-one:

| Current source | Canonical Markdown asset |
|---|---|
| Supervisor title and preface | `documents/supervisor.md` |
| Lead title and preface | `documents/lead.md` |
| Peer title and preface | `documents/peer.md` |
| Workspace title and preface | `documents/workspace.md`, since merged into `workspace/default.md` |
| Pi communication capsule | `pi/communication-style.md` |
| Pi runtime capsule | `pi/runtime.md` |

## 8. Active Documentation References

Active documentation replaces numeric citations and deleted prose-map paths with the semantic names and canonical Markdown location above:

- `AGENTS.md` updates its layout and role-contract guidance to `src/room/prompts/`, `instructionKeys()`, and `protocolKeys()`, while retaining the authority-vs-workflow layer rule; its verification chain includes the packed-package test.
- `README.md` and the reference-model document replace links to `src/room/clauses.ts` with the canonical Markdown tree; README's verification description includes the packed-package test.
- `docs/design.md` replaces references to `src/room/clauses.ts` and `src/room/workspace.ts`, and cites the contract sections it relies on by name. (Workspace Protocol Precedence has since been replaced by Lead's Workspace Protocol section and Supervisor's Workspace Protocol Mandate.)
- Code and test comments use semantic names; numeric identifiers remain only in the traceability table in this document.

Release guidance states that changed headings cause one-time expected drift, requires `setup --apply`, and requires restarting affected seats. It distinguishes generated configuration from already-running model context.

## 9. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | What Markdown fragment granularity should be used? | Repository owner | answered — one file per independently distributed semantic section, plus one file per document head and Pi capsule |
| Q-002 | Should installed prompt assets be embedded or copied beside the bundle? | Repository owner | answered — copy real Markdown assets under `dist/prompts`; runtime resolves them through `import.meta.url`; spike passed |
| D-001 | How should the package test avoid recursively invoking `prepack`? | Repository owner | answered — build first, then pack with npm lifecycle scripts disabled in the dedicated package-test process |
| PRD Q-003 | What Paseo version range is eligible for plugin feasibility? | Repository owner | deferred — remains open for Phase 2 and does not affect this design |

No blocking Phase 1 design question remains.

## 10. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-16 | Bytes | Created Draft for Phase 1 Markdown assets, semantic composition, package loading, compatibility, and migration traceability. |
| 2026-09-16 | Bytes | Added exact fragment-newline semantics, CLI error containment, an executable offline packed-package test, explicit verify integration, and complete active-document migration scope after design review. |
| 2026-09-16 | Bytes | Closed final review comments for section separators, transitional fixture lifetime, package-test discovery, CLI diagnostic scope, and stale documentation paths/gate descriptions. |
| 2026-09-16 | Repository owner | Activated after `design-ready` passed with no blocking Phase 1 question. |
