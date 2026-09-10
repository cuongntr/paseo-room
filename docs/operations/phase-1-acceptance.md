# Phase 1 acceptance and release record

**Overall release gate: PENDING. R3: NOT YET EXECUTED; blocks release.**
Documentation completion is not permission to mutate an operator home or publish.
The package is not published and remains `UNLICENSED`.

Sources: [accepted PRD](../product/paseo-room-prd.md),
[Active design](../design/platform/paseo-room.md),
[role contract](../design/platform/paseo-room-role-contract.md), and
[WP-007 / R3 plan](../plans/paseo-room-phase-1-implementation-plan.md#wp-007-cross-component-acceptance-and-release-hardening).
Operator instructions: [guide](guide.md).

## Automated evidence

Hosted run [34426300649](https://github.com/cuongntr/paseo-room/actions/runs/34426300649)
is **green** after the final cleanup fix: Linux 12m41s, macOS 23m09s. Both Node 22
jobs passed the full ordered gates: typecheck → lint → 1,142 unit/integration tests
→ build/pack → both packed suites → isolated Paseo contracts. macOS also passed
the minimal GUI-like smoke. See [packed/platform evidence](../../test/PACKED-LIFECYCLE.md)
and [CI workflow](../../.github/workflows/ci.yml). These are results of that run,
not a claim that documentation changes were included in it.

The smoke uses disposable paths, an isolated daemon and credential-free fake
Codex. It proves absolute Node-script launches and true/true/false config read-back,
not real Desktop/launchd integration, real Codex/native launch compatibility or
create/resume/refresh/import tool-delivery enforcement. Those evidence boundaries
must remain explicit; mock coverage and ready inventory cannot substitute for
missing release contracts. R3 does not silently waive any other missing evidence.

## REQ-001–REQ-016 evidence matrix

“Automated green” means the linked tests ran in the hosted gate above, not that
all real-environment release obligations have been discharged. All rows remain
subject to the overall release gate; R3 particularly exercises REQ-004–006,
REQ-008, REQ-011–013 and REQ-016.

| Requirement | Specific evidence | Status / boundary |
|---|---|---|
| REQ-001 npm/npx package | [cli.package](../../test/cli.package.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: packed execution; npm publication not performed |
| REQ-002 wizard / flags | [cli-wizard](../../test/cli-wizard.test.ts), [wizard-prompts](../../test/wizard-prompts.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: equivalent plans, PTY and no-prompt behavior |
| REQ-003 read-only default / approval | [cli](../../test/cli.test.ts), [cli-lifecycle](../../test/cli-lifecycle.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: authorization and unchanged fixture bytes |
| REQ-004 usable operator Codex home | [codex-discover](../../test/codex-discover.test.ts), [codex-runtime](../../test/codex-runtime.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green with fixtures; real Codex/canonical-home R3 evidence pending |
| REQ-005 compatible local Paseo | [paseo-probe](../../test/paseo-probe.test.ts), [paseo-verification](../../test/paseo-verification.test.ts), [paseo-isolated](../../test/paseo-isolated.contract.ts) | Automated green: admission/negative cases and pinned daemon; user-managed R3 pending |
| REQ-006 exact three providers | [provider-policy](../../test/provider-policy.test.ts), [paseo-config](../../test/paseo-config.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: complete entries and live fixture inventory; R3 pending |
| REQ-007 authority / role instructions | [role-contract](../../test/role-contract.test.ts), [codex-runtime](../../test/codex-runtime.test.ts) | Automated green: RC clauses and overlays |
| REQ-008 native true/true/false policy | [provider-policy](../../test/provider-policy.test.ts), [paseo-verification](../../test/paseo-verification.test.ts), [paseo-isolated](../../test/paseo-isolated.contract.ts) | Automated green: config/readiness, fail-closed checks; not tool-delivery path proof; R3 pending |
| REQ-009 isolated runtimes / approved links | [codex-discover](../../test/codex-discover.test.ts), [codex-runtime](../../test/codex-runtime.test.ts), [guarded-read](../../test/guarded-read.test.ts) | Automated green: link safety and canonical preservation with fixtures |
| REQ-010 native-agent disable | [codex-runtime](../../test/codex-runtime.test.ts), [role-contract](../../test/role-contract.test.ts) | Automated green: config/catalog contracts; not a real Codex smoke |
| REQ-011 transactions / conditional rollback | [transaction](../../test/transaction.test.ts), [transaction-executor](../../test/transaction-executor.test.ts), [transaction-gateway](../../test/transaction-gateway.test.ts), [transaction-lock](../../test/transaction-lock.test.ts), [bootstrap](../../test/bootstrap.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: fault boundaries, ownership, SIGKILL and private state; R3 pending |
| REQ-012 idempotency / preservation | [planner](../../test/planner.test.ts), [recovery-uninstall](../../test/recovery-uninstall.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: second apply, collisions, customized/unrelated preservation; R3 pending |
| REQ-013 lifecycle results / safe removal | [cli](../../test/cli.test.ts), [contracts](../../test/contracts.test.ts), [recovery-uninstall](../../test/recovery-uninstall.test.ts), [lifecycle.package](../../test/lifecycle.package.test.ts) | Automated green: exits 0–4, JSON, recover and residual uninstall; R3 pending |
| REQ-014 versioned ownership | [manifest](../../test/manifest.test.ts), [contracts](../../test/contracts.test.ts), [planner](../../test/planner.test.ts) | Automated green: schema v1 and ownership reconstruction |
| REQ-015 adapter boundary | [contracts](../../test/contracts.test.ts), [planner](../../test/planner.test.ts), [transaction-executor](../../test/transaction-executor.test.ts), [codex-runtime](../../test/codex-runtime.test.ts) | Automated green: shared interfaces/fakes and Codex adapter; later agents deferred |
| REQ-016 macOS / Linux | [lifecycle.package](../../test/lifecycle.package.test.ts), [macos-gui](../../test/macos-gui.smoke.ts), [platform record](../../test/PACKED-LIFECYCLE.md) | Automated platform evidence green in run 34426300649; real user-managed macOS Desktop/daemon R3 portion pending; **overall pending** |

REQ-017–REQ-019 are deferred, not Phase 1 acceptance claims.

## R3 procedure

**NOT YET EXECUTED.** Risk owner: Repository owner. Execution belongs to
`paseo-room-czd`, not this documentation task. The
[Active R3 decision](../design/platform/paseo-room.md#r3-decision) requires this
rehearsal before release; there are no accepted irreversible points.

1. **Obtain separate, explicit owner approval at execution time.** Record the
   exact macOS target, canonical Codex home, managed root, local Paseo home/listen
   endpoint, executable selections, packed artifact version and checksum, proposed
   actions, start/end window and accountable operator in a private record. Approval
   of code, docs or disposable tests is not real-home approval. Public evidence uses
   stable aliases instead of private paths. Stop if the target/window changes or
   approval expires. Never infer permission to install/manage dependencies.
2. **Establish a quiescent baseline before mutation.** Confirm prerequisite and
   endpoint admission, inspect `doctor`/`plan`, and arrange owner-controlled
   serialization of managed sessions and external writers throughout the window.
   Record presence/absence, ownership, modes and file identity metadata for exact
   managed paths, canonical resources and relevant provider entries. Capture byte
   checksums only for explicitly reviewed **noncredential** regular files, including
   canonical configuration and other approved noncredential canonical resources;
   record link metadata/literal targets without traversal. Exclude auth files,
   credentials and any potentially secret-bearing content from reads, hashing,
   copies and logs—even if a filename looks harmless. Credential resources get
   metadata-only observations. If safe classification is uncertain, stop rather
   than hash. Do not recursively hash or archive a home. Baseline unrelated state
   with safe metadata/noncredential comparisons, not a full config dump.
3. **Prepare limited private backups.** In owner-only storage (`0700` directories,
   `0600` regular files), back up only already-owned, reviewed noncredential managed
   state: manifest, managed regular files and exact managed provider values where
   credential-free. Preserve link declarations, never their targets. Record absence
   for a first install. Do not back up canonical auth/config, credential stores,
   unknown reference state or the whole Paseo config. Validate backup identity,
   permissions and safe checksums; keep the private target mapping out of shared
   artifacts. A backup grants no authority to overwrite later state.
4. **Review the exact dry-run.** With the approved packed artifact and the same
   explicit target selections, run `plan`, `install` without apply and `doctor`.
   Compare all operations against the baseline: only the three managed IDs and
   approved paths may change. Stop before apply on prerequisite failure, unexpected
   operation, collision, drift, unknown ownership, interrupted evidence or active
   session. Existing reference state follows the [manual handling procedure](guide.md#existing-codex-room-setup-installations).
   Have the owner approve the reviewed plan, not a generic future apply.
5. **Apply, verify and prove no-op update.** Run `install --apply` once, then
   `verify` and `doctor`; record schema-v1 outcomes/exits, complete managed policy
   true/true/false and all three ready profiles. Check absolute durable launch
   prefixes and isolated homes. Record separately any approved real Codex/runtime
   smoke and its limits; do not equate fake tests or agent prose with tool delivery.
   Review a second `install` dry-run and run the identical `install --apply`:
   expect `ok`, `changed: false` and unchanged managed bytes/provider values.
   Do not introduce arbitrary canonical drift for this rehearsal without separate
   approval; the no-op reapply is the minimum update proof.
6. **Safely remove or conditionally reconcile.** Review `uninstall`, obtain the
   planned removal confirmation, then run `uninstall --apply` if safe. Only unchanged
   owned state may be removed. Preserve customized/mutable residual state and its
   `uninstall-incomplete` manifest. If interrupted, inspect `recover` first; use
   `recover --apply` only after confirming exact journal/endpoint/ownership evidence
   and no unresolved late RPC. Conditional rollback may restore a recorded
   before-value only while the current value still matches the recorded after-value.
   Restoring a prior managed installation likewise needs exact current-state checks,
   narrowly scoped owner authorization and the public SDK—not direct config writes.
   **No blind backup restore, full-config restore, forced cleanup or automatic retry.**
7. **Post-check and sign off.** Compare the same safe canonical noncredential byte
   checksums and resource metadata with baseline; never hash auth to complete a
   checklist. Confirm canonical bytes are unchanged except independently identified
   writes made by running Codex through approved shared links. Any such write must
   be attributed and reviewed, not silently accepted or restored. Check unrelated
   providers/state, absence or intentional residual ownership, bootstrap/journal/lock
   cleanup and removal of unchanged managed providers. Full uninstall should leave
   no claimed ownership; do not require deleted profiles to pass installed-room
   verification. Inspect `plan`/`doctor` and compare with the expected absent baseline.
   Preserve private evidence until the owner approves its safe disposal.
8. **Abort and preserve divergence.** At any mismatch, timeout ambiguity, unexpected
   writer, ownership change, unresolved RPC or failed verification, stop further
   mutation and preserve private journals/backups/current state. Report conflict or
   `recovery-required` and obtain owner direction; do not force the environment back
   to baseline. Unresolved divergence blocks release and sign-off.

## Required sanitized R3 record

No run is recorded yet. After execution, link a reviewed record here containing:
owner approval and window (with private target aliases), artifact identity,
prerequisite versions/platform, baseline/post comparison summary with credential
exclusions, dry-run approval, command/check IDs and exits, three-role policy and
readiness, second-apply no-op, uninstall/residual or conditional recovery result,
any independently attributed Codex writes, divergence disposition and owner sign-off.
Do not publish raw homes, config dumps, daemon logs, environment, credentials or
private paths. Record omissions honestly; no release approval while R3 or another
required contract is unproven.
