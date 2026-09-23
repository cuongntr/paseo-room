# Claude Strong Contract Carrier — Implementation Plan

| Field | Value |
|---|---|
| Status | Archived |
| Plan-ready | PASS — 2026-09-18 — Repository owner |
| Owner | Repository owner |
| Routing decision | [Technical Design routing decision](../design/claude-strong-contract-carrier.md#routing-decision): brownfield; required preview-API dependency, trusted-plugin boundary, prompt-carrier change; plan → converter |
| Source PRD / requirements | [Accepted change: Strong Claude contract carrier](role-contract-markdown-change-001-strong-claude-carrier.md), narrowing the [Role Contract Maintainability and Paseo Runtime Guard PRD](../product/role-contract-and-plugin-prd.md) |
| Source Technical Design | [Claude Strong Contract Carrier](../design/claude-strong-contract-carrier.md) |
| Related ADRs | N/A — no ADR directory or governing ADR exists |
| Phase | Phase 1 — required Claude carrier |

## 1. MVP-Lock

- **In this phase:** the bundled dependency-free Paseo server plugin and its generated contract; the
  marker-delimited idempotent composition rule; the `before('agent.create')` hook scoped to exact room
  Claude provider ids; plugin files as managed entries under `~/.paseo-room`; the `pluginsEnabled`
  precondition read; install/reload/status/remove through the Paseo API; the `>= 0.8.0` compatibility
  floor for a Claude selection; fail-closed `verify` for plugin absence, disablement, failure, path
  drift, file drift, and contract-generation drift; and the documentation of what each Claude carrier
  proves.
- **Out of this phase:** any plugin client entry, UI, panel, RPC, slash command, timeline row, or
  theme; every runtime guard, duplicate-Lead or parentage check, and topology validation (PRD
  REQ-014/REQ-015, still behind the Phase 2 gate); changes to contract wording, composition, the
  Markdown asset tree, `CLAUDE.md`, Codex, Pi, providers, profiles, credentials, role homes, or CLI
  flags; writing `pluginsEnabled`; installing or upgrading Paseo, Claude, or anything outside the room
  home; replacing a vendor system prompt; a provider-level system-prompt pin; retroactive update of a
  running seat; and any transaction/rollback machinery.
- **Exit criteria:** every work-package exit condition holds; `npm run verify` passes the complete
  typecheck → lint → test → build → packed-package chain; the plugin manifest declares
  `>=0.8.0 <0.9.0`; the plugin's rendered contract equals `renderInstructions()` for the same role;
  no plugin source module imports any package or SDK; each degradation row in Technical Design §8.5 has
  automated evidence; no test or document claims observed model ingestion; and active docs state the
  required-plugin rule, the operator `pluginsEnabled` act, and the resume limitation.
- **Default checkpoint posture:** no irreversible state and no R3 action. A failed apply is fixed by
  running `setup` again. Contain a failure by reverting the owning package's edits, or by reinstalling
  the prior package version, running its `setup --apply`, and removing the stale plugin registration
  with `paseo plugin remove <id>`. Never discard role-owned credentials or operator homes, and never
  change `pluginsEnabled` as a containment step.

After activation this scope is frozen. A new vendor surface, a guard, or any UI requires a further
delta-change rather than an added bead.

## 2. Work Packages

### WP-001: Plugin source, composition rule, and generated contract

- **Outcome:** A bundled, dependency-free plugin whose `before('agent.create')` hook appends the
  rendered role contract to `config.systemPrompt` for exact room Claude provider ids only, using a
  marker-delimited idempotent composition rule, with the per-provider contract and generation
  generated from the existing renderer.
- **Requirement / AC coverage:** Change §3 "After" bullets 1, 3, and the idempotence/scoping
  guarantees; Technical Design §2, §2.1, §2.2.
- **Design refs:** Technical Design §2, §2.1, §2.2, §9 composition/hook/generated-file tests.
- **Prerequisites:** none.
- **Sequencing:** Land the composition rule and its unit tests first, then the hook entry, then
  generation of the per-provider contract from `renderInstructions()`. Do not introduce a second prose
  source: the generated contract is derived, never authored.
- **Risk boundaries / decomposition hints:** The composition rule is the only piece with subtle
  behaviour (append-not-replace, single marked block, same-generation idempotence) and is unit-testable
  in isolation; the hook is a thin selector over it. Any decomposition must keep "no import of any
  package or SDK in plugin source" as a closing assertion of this package, because the daemon compiles
  the directory as-is.
- **Exit condition:** Composition appends rather than replaces, always emits one marked block last, is
  byte-identical when composed twice at the same generation, and rewrites an older generation in place;
  the hook skips internal agents and every non-room provider id and returns its input unchanged on a
  no-op; the generated contract equals `renderInstructions()` for the same role; the manifest declares
  `>=0.8.0 <0.9.0`; no plugin module imports any package, SDK, or `node:` module; unit tests green.

### WP-002: Managed plugin files, daemon registration, and fail-closed verification

- **Outcome:** `setup`/`verify`/`remove` own the plugin end to end: files planned and written as
  managed entries under `~/.paseo-room`, registration and reload through the Paseo API in the existing
  session, `pluginsEnabled` read as an explicit precondition, the `>= 0.8.0` floor applied to a Claude
  selection, and every absence/drift condition failing `verify`.
- **Requirement / AC coverage:** Change §3 "After" bullets 2, 5, 6, 7; Technical Design §4, §6, §8.1–§8.5.
- **Design refs:** Technical Design §4, §6, §7, §8.
- **Prerequisites:** WP-001 — needs the final file set, manifest, and generated contract shape.
- **Sequencing:** Extend the compatibility floor and the `pluginsEnabled` read first so a dry run is
  honest before anything is written; then the managed entries; then install/reload/status; then the
  `verify` failure set; then `remove` deregistration ahead of room-home deletion. Keep the plugin out
  of a Codex/Pi-only selection at every step.
- **Risk boundaries / decomposition hints:** Filesystem ownership and daemon registration are one
  outcome because a registered plugin pointing at unwritten or drifted files is the failure mode this
  package exists to prevent. Ownership is by shape only — an ordinary managed `dir` with managed `file`
  children, never exact directory ownership, and never extended to role homes or credential paths.
  Registration reuses the one existing per-command session; no retry, reconnect, or background state.
- **Exit condition:** Dry run writes nothing and reports the full diff; `pluginsEnabled` false or
  absent fails with the trust warning and the operator action and is never written; first apply
  installs, a later apply reloads; a `failed` status surfaces the plugin's load error and fails; path
  drift, file drift, disabled state, version-range refusal, and contract-generation drift each fail
  `verify`; a Claude selection requires `>= 0.8.0`; `remove --apply` deregisters before deleting the
  room home and leaves `pluginsEnabled` alone; a Codex/Pi-only selection plans and registers nothing;
  `CLAUDE.md`, provider pins, `paseoTools`, profiles, role-home isolation, and credential preserve-only
  behaviour are unchanged with the plugin present, absent, and failed.

### WP-003: Documentation of the two carriers and their evidence boundary

- **Outcome:** `docs/design.md`, `README.md`, and `AGENTS.md` state the required-plugin rule for Claude
  rooms, the strong creation-time carrier alongside the retained `CLAUDE.md` fallback, the explicit
  operator `pluginsEnabled` act, the resume limitation, and the upgrade/rollback procedure including
  stale-registration cleanup.
- **Requirement / AC coverage:** Change §4 "Active documentation"; Technical Design §6, §8.5, §11.
- **Design refs:** Technical Design §2.1, §6, §8.5, §11; existing `docs/design.md` §5c, §6, §7.
- **Prerequisites:** WP-001 for the final manifest bound and carrier shape; WP-002 for the final
  diagnostics, commands, and verified behaviour.
- **Risk boundaries / decomposition hints:** Keep conceptual authority in the reference-model document
  (untouched here), implementation rationale in `docs/design.md`, contributor procedure in `AGENTS.md`,
  and operator guidance in `README.md`. Do not duplicate contract prose into documentation. `docs/design.md`
  §6 must be **amended, not replaced**: its refusal of every replace-the-prompt path still stands, and
  the provider-owned SDK append field remains the named upstream fix.
- **Exit condition:** Docs describe both Claude carriers and exactly what each proves; the
  §5c evidence boundary distinguishes generated/live configuration, vendor ingestion contracts, and
  model behaviour, and adds the creation-time hook without claiming observed ingestion; the plugin is
  described as trusted unsandboxed code and never as a sandbox; the resume limitation is stated as
  unproven; the required `pluginsEnabled` operator step, the `>= 0.8.0` Claude floor, the `<0.9.0`
  bound, and the rollback stale-registration cleanup are documented; `AGENTS.md` records the
  required-carrier design rule and the "never auto-enable plugins" rule; all links resolve.

## 3. Dependencies

| Edge | Reason |
|---|---|
| WP-002 depends on WP-001 | Managed entries, drift comparison, and registration need the final file set, manifest bound, and generated contract shape. |
| WP-003 depends on WP-001 | Docs must cite the final manifest version bound and carrier composition. |
| WP-003 depends on WP-002 | Operator guidance must state the implemented diagnostics, commands, failure set, and rollback steps. |

The graph is acyclic. WP-001 and WP-002 are not parallel: both own the plugin's on-disk shape.

## 4. Test Strategy

Vitest with real temporary `$HOME` fixtures, fake executables, and a fake daemon client — existing
repository patterns, no new framework and no new dependency. The detailed test inventory is Technical
Design §9; this plan does not restate it.

- Unit: composition rule and hook selection.
- Integration: generated file content, command behaviour across every §8.5 degradation row, and
  non-regression of `CLAUDE.md`, pins, profiles, role homes, and credentials with the plugin present,
  absent, and failed.
- Package: the existing packed-package asset inventory extends to the plugin source assets.

Minimum acceptable coverage is requirement-based, matching the repository's existing position: every
failure and degradation boundary has automated evidence. No percentage threshold is introduced, because
the repository has no coverage instrumentation or accepted numeric target. No test asserts model
ingestion of the injected prompt.

## 5. Risk Modules

- **Auth / security:** The plugin is trusted, unsandboxed daemon code. `pluginsEnabled` is read and
  refused, never written. Negative evidence is required: with the plugin absent, disabled, or failed,
  no seat gains a tool, authority, or a native multi-agent path, and no credential or operator home is
  read. The plugin must never be documented as a sandbox.
- **Rollout / containment:** Activation is `setup --apply` plus a restart of affected Claude seats;
  only newly created agents pass through the hook. Containment is re-running `setup`, or reinstalling
  the prior package version, running its `setup --apply`, and clearing the stale registration with
  `paseo plugin remove <id>`. Decision signal for a rollback: `verify` failing on plugin status or a
  daemon outside `>=0.8.0 <0.9.0`.
- **Public contract / consumers:** No `paseo-room` public API, CLI flag, provider field, or profile
  field changes. The consumed contracts are Paseo's preview plugin APIs, fenced by the manifest bound.
- **R3 decision:** N/A — no destructive, irreversible, weak-rollback, schema, credential, or
  coordinated-rollout action is introduced. Registration is reversible through the same API.

## 6. Risks & Open Questions

| ID | Risk / Question | Mitigation / Owner | Status |
|---|---|---|---|
| R-001 | The preview 0.8 plugin API changes and silently breaks the carrier. | `requirements.paseo = ">=0.8.0 <0.9.0"`; the daemon refuses an out-of-range plugin and `verify` fails naming the bound; `CLAUDE.md` still carries the contract. Repository owner. | mitigated in WP-001/WP-002 |
| R-002 | A required plugin becomes a silent single point of failure for the Claude contract. | Every absence/disablement/failure/drift condition fails `verify` rather than warning; `CLAUDE.md` is retained unchanged. Repository owner. | mitigated in WP-002 |
| R-003 | Repeated creation or resume produces a duplicated or stale contract block. | Marker-delimited, generation-stamped, idempotent composition that rewrites in place; unit evidence for double composition and older-generation rewrite. Repository owner. | mitigated in WP-001 |
| R-004 | The hook touches an operator's own Claude provider or a Paseo internal agent. | Exact room provider-id matching plus an `internal` skip, with negative tests for both. Repository owner. | mitigated in WP-001 |
| R-005 | The generated plugin contract drifts from the rendered role document, creating a second prose authority. | The contract is generated from `renderInstructions()`; an equality test binds them, and generation drift fails `verify`. Repository owner. | mitigated in WP-001/WP-002 |
| R-006 | Managed plugin-directory ownership is over-claimed and deletes something the room does not own. | Shape-only ownership as `dir` + `file` children, no exact directory ownership, never extended to role homes or credential paths. Repository owner. | mitigated in WP-002 |
| Q-001 | Does a resumed Claude session re-invoke the creation hook, or carry a previously injected prompt? | Repository owner. | open — not blocking. `CLAUDE.md` is retained for exactly this case and no claim is made either way. |

No open question blocks conversion. PRD Q-003 through Q-006 remain with the deferred plugin
guard/UI track and do not affect any work package here.

## 7. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | Bytes | Created Active with three work packages for the accepted strong Claude carrier: plugin source and composition rule, managed files with fail-closed registration and verification, and carrier documentation. |
| 2026-09-18 | Bytes | Phase 1 implementation completed: WP-001 through WP-003 delivered and the full `npm run verify` gate passed; plan remains Active pending repository-owner feature-done confirmation and archival. |
| 2026-09-23 | Repository owner | Confirmed feature-done and archived. WP-001 through WP-003 shipped in `v0.2.0` (commit `3ed2881`); the carrier has since been live-qualified on Paseo `0.8.0` and `0.9.1` under the [runtime coordination design](../design/runtime-coordination.md) §14. Design Q-001 (resume re-invocation) stays open and non-blocking in the [Technical Design](../design/claude-strong-contract-carrier.md). |
