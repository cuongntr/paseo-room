# Paseo Room — Technical Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [Paseo Room PRD](../../product/paseo-room-prd.md) |
| Related ADRs | N/A — no project ADRs or engineering conventions exist yet |
| Routing decision | [PRD routing decision](../../product/paseo-room-prd.md#routing-decision): greenfield; PRD → Technical Design → Implementation Plan → Beads; no exception |

## 1. Boundaries

### This design owns

- The public `paseo-room` npm CLI and its human/JSON contracts.
- Phase 1 homogeneous Codex room planning, installation, update, verification, diagnosis, and uninstall.
- Three managed Paseo provider entries and their native `paseoTools` policies.
- Generated role-specific Codex homes, shared room instructions, ownership manifest, transaction journal, backups, and recovery behavior.
- A small adapter seam for later Claude Code, Pi, and OpenCode implementations.

### This design does not own

- Installation, upgrade, authentication, startup, shutdown, or repair of Paseo or Codex.
- Paseo's config schema, daemon implementation, session storage, provider implementation, or tool enforcement.
- Canonical `~/.codex` content, credentials, operator plugins/skills/hooks, or unrelated Paseo providers.
- Operating-system sandboxing. `paseoTools.enabled: false` prevents Paseo tool delivery; it does not prevent a shell-capable Peer from invoking a separately available `paseo` binary.
- Mixed-agent rooms and post-Phase-1 adapters.

## 2. Architecture

### 2.1 Runtime view

```text
                         operator / CI
                              │
                    npx paseo-room <command>
                              │
         ┌────────────────────┴────────────────────┐
         │                                         │
   Intent + Planner                         PaseoGateway
   wizard or flags                     CLI status + public SDK
         │                                         │
         ├── AgentAdapter ── CodexAdapter           ├── config.get/patch
         │       │                                  ├── providers snapshot
         │       ├── discover canonical home        └── agent/session checks
         │       ├── render role homes
         │       └── verify role runtime
         │
         └── TransactionEngine ── journal/manifest/backups
                    │
                    ├── managed filesystem artifacts
                    └── three daemon-owned provider entries

Paseo daemon ── provider profile ── Codex launch prefix + CODEX_HOME
                                      │
                                      └── <prefix> app-server
```

`npx` is only the lifecycle controller. Paseo profiles launch a validated Codex prefix that is independent of npm cache: either `[absoluteNativeCodex]` or `[absoluteNode, absoluteCodexScript]`. Paseo `v0.8.0-beta.1` resolves the configured prefix and appends `app-server` before spawning it (`codex-app-server-agent.ts`, `spawnAppServer`). The profile also supplies the stable role `CODEX_HOME`; no persistent copy of this CLI is needed.

Role configuration is regenerated during explicit apply, not on each agent launch. This intentionally removes the reference implementation's launch-time sync dependency. `doctor` detects canonical Codex/Codex-prefix drift and asks the operator to re-apply. The behavior is safer for an ephemeral `npx` package and keeps provider startup independent of npm cache and a GUI daemon's shell `PATH`.

### 2.2 Source modules

```text
src/
  cli/                    command parsing, wizard, renderers, exit mapping
  core/
    intent.ts             normalized wizard/flag input
    planner.ts            desired-vs-current operations
    transaction.ts        journaled apply and compensation
    manifest.ts           ownership and schema migration
    paths.ts              home resolution and path containment
  paseo/
    gateway.ts            public @getpaseo/client integration
    cli-probe.ts          `paseo daemon status --json`, CLI version
    provider-policy.ts    managed provider construction/verification
  adapters/
    contract.ts
    codex/
      discover.ts
      config-codec.ts
      runtime.ts
      verify.ts
  room/
    roles.ts              role IDs and authority matrix
    instructions/         shared protocol + role overlays
```

Core lifecycle modules consume `AgentAdapter`; they do not inspect `CODEX_HOME`, TOML, Codex model catalogs, or Codex tool names.

### 2.3 Adapter contract

```ts
export type RoomRole = "supervisor" | "lead" | "peer";

export interface AgentAdapter<Discovery> {
  readonly id: string;
  discover(context: DiscoveryContext): Promise<Discovery>;
  buildArtifacts(input: BuildArtifactsInput<Discovery>): Promise<ArtifactSpec[]>;
  buildProvider(role: RoomRole, input: ProviderInput<Discovery>): ManagedProvider;
  verifyRuntime(input: VerifyRuntimeInput<Discovery>): Promise<CheckResult[]>;
}
```

- `discover` is read-only and returns validated executable/home/capability facts.
- `buildArtifacts` returns declarations; it never writes files.
- `buildProvider` returns a complete owned Paseo provider entry.
- `verifyRuntime` inspects adapter-specific generated state.
- Transaction, manifest, prompts, provider IDs, and role policy remain in core.
- The contract is intentionally not a universal MCP/server abstraction; it will be extended only when a subsequent adapter demonstrates a need.

### 2.4 Implementation stack

- Node.js `>=22` and strict TypeScript ESM; npm is the package manager and publication format.
- `commander` for command parsing, `@clack/prompts` for the TTY wizard, `zod` for persisted/external boundary validation, `smol-toml` for generated Codex TOML, and `semver` for compatibility checks.
- `@getpaseo/client` is initially pinned to `0.8.0-beta.1`; upgrades require the Paseo contract suite. `tsup` emits the npm CLI artifact and Vitest runs tests.
- Production code is a clean-room behavioral implementation based on observed contracts. Reference code has no published license and is not copied or packaged.
- Role authority and exact Phase 1 Codex overlay values are pinned by the Active [Role Compatibility Contract](paseo-room-role-contract.md); generated instruction tests consume its numbered invariants.

## 3. Persistent Data Model

### 3.1 Managed layout

`PASEO_ROOM_HOME` overrides the root for tests/advanced use. Otherwise the root is `${XDG_DATA_HOME:-$HOME/.local/share}/paseo-room` on macOS and Linux.

```text
<paseo-room-home>/                       mode 0700
  manifest.json                         mode 0600, owned
  room/
    model-instructions.md               mode 0600, owned
    workspace-protocol.md               mode 0600, owned operator template
  roles/codex/
    supervisor/
      config.toml                       mode 0600, owned
      model-catalog.no-native-agents.json
      auth.json -> <canonical>/auth.json
      AGENTS.md -> <canonical>/AGENTS.md
      skills -> <canonical>/skills
      plugins -> <canonical>/plugins
      hooks.json -> <canonical>/hooks.json   # optional
      ... Codex-created mutable state        # preserved, not owned
    lead/
    peer/
  transactions/<transaction-id>/
    journal.json                        mode 0600
    before/                             mode 0700
```

Only paths declared in the manifest are owned. Role directories are containers shared with Codex-created mutable state; uninstall removes owned children and removes a directory only when empty. Symlinks are hashed as link declarations and are never dereferenced during backup or cleanup.

### 3.2 Installation manifest

```ts
interface InstallationManifestV1 {
  schemaVersion: 1;
  packageVersion: string;
  installationId: string;
  lastTransactionId: string;
  status: "committed" | "uninstall-incomplete";
  adapter: "codex";
  paseo: {
    localHome: string;
    listen: string;
    endpointIdentitySha256: string;
    cliVersion: string;
    daemonVersion: string;
    minimumVersion: "0.8.0-beta.1";
  };
  source: {
    canonicalHome: string;
    canonicalConfigSha256: string;
    codexLaunchArgv: [string, ...string[]];
    codexVersion: string;
  };
  artifacts: ManifestArtifact[];
  providers: Record<ManagedProviderId, {
    prior: null;
    applied: ProviderOverrideV1;
    appliedSha256: string;
  }>;
  committedAt: string;
}
```

`ManifestArtifact` stores path, kind (`file | symlink | directory`), mode, SHA-256 for owned regular-file content, and symlink target for links. It never stores credential contents or hashes. `prior` is `null` in Phase 1 because pre-existing unmanaged managed IDs are conflicts rather than adopted state.

Unknown future manifest versions fail read-only with an upgrade diagnostic. Schema migration is explicit and atomic; Phase 1 introduces schema version 1 and has no legacy migration.

### 3.3 Transaction journal

```ts
interface TransactionJournalV1 {
  schemaVersion: 1;
  transactionId: string;
  operation: "install" | "update" | "uninstall";
  state:
    | "staged"
    | "publishing-files"
    | "patching-paseo"
    | "verifying"
    | "rolling-back"
    | "recovery-required"
    | "committed"
    | "rolled-back";
  previousManifest: InstallationManifestV1 | null;
  fileMutations: FileMutationRecord[];
  providerBefore: Record<ManagedProviderId, ProviderOverrideV1 | null>;
  providerAfter: Record<ManagedProviderId, ProviderOverrideV1 | null>;
}
```

The journal is fsynced before the first mutation and after each completed mutation. Before-images are private regular files or symlink metadata. Install/update commits by atomically writing a manifest whose `lastTransactionId` matches the journal; uninstall commits by first marking the journal `committed`, then deleting a fully discharged manifest. A crash after either commit point is recognized as committed cleanup, not rolled back. Before the commit point, recovery conditionally compensates recorded mutations.

First-install root bootstrap uses a separate temporary ownership declaration because the transaction journal cannot exist before the managed root does. After acquiring the daemon/provider lock, Paseo Room anchors and validates the existing parent, durably creates a deterministic sibling `0600` bootstrap sidecar bound to the canonical room path, endpoint identity, transaction ID, expected-absent root, and intended `0700` directory, then creates the root without clobbering and fsyncs the parent. Once the matching internal journal, including the bootstrap endpoint-identity binding, is durable, authority transfers to that journal; the sidecar is removed and the parent is fsynced. Recovery locates the sidecar from the independently selected room path. It may remove only an exact empty bootstrapped root before journal transfer, resume only an exact matching endpoint-bound internal transaction afterward, and otherwise preserves all evidence as `recovery-required`. Before deleting a rolled-back first-install journal, recovery durably re-establishes a `discharge` form of the sibling sidecar; it then removes only the exact empty transaction containers and root before retiring that sidecar, so a crash at any cleanup boundary retains ownership authority. Pre-existing roots remain collisions and are never adopted. The same accepted same-UID interference limit as transaction-private capture names applies to the owner-only sidecar; symlink, foreign-owner, unsafe-parent, hard-link, and unknown-child states fail closed.

`paseo-room recover [--apply]` is the only mutating recovery entry point. Dry-run classifies an interrupted transaction as safely committable, safely reversible, or divergent. `--apply` completes post-commit cleanup, otherwise reconciles each mutation using before/after ownership checks and rolls back. Divergence is preserved and remains `recovery-required`. A normal apply/uninstall is blocked while an unfinished journal exists; plan, verify, doctor, and recovery dry-run remain read-only.

## 4. Public CLI Contract

### 4.1 Commands

| Command | Behavior | Mutation rule |
|---|---|---|
| `paseo-room` | Interactive Codex wizard; shows plan, then asks whether to apply | No mutation without explicit confirmation |
| `paseo-room plan --agent codex` | Detects prerequisites and prints desired changes | Never mutates or prompts |
| `paseo-room install --agent codex [--apply]` | Plans install/update; applies only with flag | Without `--apply`, dry-run |
| `paseo-room verify` | Verifies committed files, provider inventory, and live policy | Read-only |
| `paseo-room doctor` | Reports source drift, dependency mismatch, stale launch prefix, interrupted transaction, and remediation | Read-only |
| `paseo-room recover [--apply]` | Classifies or reconciles one interrupted journal | Without `--apply`, dry-run |
| `paseo-room uninstall [--apply]` | Plans safe removal; applies only with flag | Without `--apply`, dry-run |

Common automation options are `--json`, `--non-interactive`, `--room-home <path>`, `--codex-home <path>`, `--codex-bin <path>`, `--paseo-bin <path>`, and `--paseo-url <ws-url>`. Secrets are accepted only through Paseo's supported environment variable (`PASEO_PASSWORD`); no password flag is provided.

`--non-interactive` rejects missing required input and never falls back to prompts. Wizard answers and flags both produce the same `NormalizedIntent`, so planning/apply logic has one path.

### 4.2 JSON and exit contract

Stdout contains exactly one JSON document under `--json`; diagnostics go to stderr only in human mode.

```ts
interface CommandResult {
  schemaVersion: 1;
  command: "plan" | "install" | "verify" | "doctor" | "recover" | "uninstall";
  outcome: "ok" | "changes-planned" | "conflict" | "failed" | "recovery-required";
  changed: boolean;
  checks: Array<{
    id: string;
    status: "pass" | "warn" | "fail" | "not-checked";
    message: string;
    remediation?: string;
  }>;
  operations: PlannedOperation[];
}
```

Exit codes: `0` success/no failed checks; `1` validation, compatibility, verification, or operation failure; `2` invalid CLI usage; `3` ownership conflict; `4` recovery required. Cancellation before apply is a clean no-change exit `0`; cancellation after transaction start follows rollback outcome.

This is a public contract. Fields may be added within schema version 1; removals, semantic changes, or exit-code changes require a schema/version migration.

## 5. External Integration Contracts

### 5.1 Paseo

- Runtime dependency: `@getpaseo/client` public package API only. No import from `@getpaseo/client/internal/*`.
- Local admission probe: before execution, validate canonical home plus safe nonempty `server-id`/`cli-client-id`, parse the current-user `paseo.pid`, validate its host/PID and normalized loopback listen endpoint, and reject remote state without spawning. Then execute the selected `paseo daemon status --json` with a sanitized allowlisted environment and timeout; require its home/listen/PID/owner, CLI version, daemon version, and reachability to match preflight. The reported `serverId` is not trusted as connected-peer identity because Paseo `0.8.0-beta.1` derives it from local home.
- Connection: `PASEO_PASSWORD`, when present, is passed only in the selected Paseo status subprocess environment and to `createPaseoClient({ url, password })` on Node.js 22+; it is excluded from argv, diagnostics, persistence, and provider/Codex environments. SDK `connect()` is followed by `close()` in `finally`.
- Config mutation: one `client.config.patch({ providers: { ...threeEntries } })` call. The daemon validates, persists, applies, and rolls back its in-memory/file replacement if a live config owner rejects the patch.
- Removal: one `client.config.patch({ removeProviders: [threeIds] })` call only after ownership comparison.
- Registry activation: `client.providers.refresh(...)`, then `waitForReady(...)` and inspect all three managed entries.
- Effective policy proof: read back `client.config.get()` from the connected daemon and compare each complete managed provider entry, including `paseoTools`. A static file read is not accepted as live proof.

Paseo patches provider objects by deep merge, not replacement. `ProviderOverrideV1` therefore has one invariant key set—`extends`, `label`, `command`, `env`, and `paseoTools`—and every update supplies every key. Current state must exactly equal the prior manifest before update, so an extra or missing key is a conflict. Schema version 1 never removes a nested key. A future provider-shape migration that removes keys requires a new Paseo atomic-replacement API or an explicit quiesced remove/add migration design; it cannot reuse this update path. Rollback of a Phase 1 install removes the entries, while rollback of an update deep-merges the exact same invariant key set from `providerBefore`.

Expected Phase 1 profile shape:

```json
{
  "extends": "codex",
  "label": "Codex Supervisor",
  "command": ["/absolute/path/to/node", "/absolute/path/to/codex.js"],
  "env": { "CODEX_HOME": "/absolute/path/to/roles/codex/supervisor" },
  "paseoTools": { "enabled": true }
}
```

Lead is equivalent with its own label/home. Peer uses `{ "enabled": false }`. Phase 1 does not expose `disabledTools`; defaults are all Paseo tools for Supervisor/Lead and none for Peer.

Both CLI and daemon versions must parse as semver, be `>=0.8.0-beta.1`, and be exactly equal after normalization. The selected status must describe a running current-user local daemon, a canonical local Paseo home, and a loopback listen endpoint; `--paseo-url`, when supplied, must normalize to that reported endpoint. Remote targets remain rejected in Phase 1.

The ordinary Paseo executable policy remains canonical realpath, current-user/root-owned regular executable, executable, single-link, and safe directory-only parents. One exact exception is authorized by [change-001](../../plans/paseo-room-phase-1-change-001-macos-desktop-launcher.md): on `darwin` only, `/Applications/Paseo.app/Contents/Resources/bin/paseo` may tolerate mode-writable `/Applications` only when `lstat` identifies it as a root-owned directory and its real path is exactly `/Applications`. Every other parent must pass the ordinary rule; no Linux exception or other `.app` path is admitted. The Desktop shell launcher receives only `PATH=/usr/bin:/bin`, which excludes provider commands; password handling is unchanged.

Paseo `0.8.0-beta.1` does not expose the connected daemon's `serverId` through the public client. By explicit Repository-owner decision, Phase 1 therefore does **not** claim cryptographic or protocol-level WebSocket peer identity. It admits the local target from home/PID/UID/listen/version/reachability evidence and records `endpointIdentitySha256 = sha256(canonicalLocalHome, normalizedListen)`. A loopback process replacement between probes is residual risk; mutation re-runs admission after acquiring the lock and immediately verifies full provider state after each SDK mutation. A future public connected-identity API must replace this weaker admission without changing provider ownership semantics.

The provider snapshot proves that derived providers are active and ready, but does not expose policy. The connected daemon's config read-back is the policy evidence available through the supported SDK. Paseo's own daemon integration tests are the downstream contract evidence that this policy controls create/resume/refresh/import delivery paths. `paseo-room` does not infer policy from an agent's natural-language answer.

The SDK serializes a patch within the daemon and preserves unrelated top-level/provider entries. It has no revision/ETag. Paseo Room therefore owns each managed provider entry as one invariant object, refuses first-install entries already occupying the managed IDs, serializes its own writers by local admission identity and provider namespace, and documents that concurrent external edits to the same three IDs are unsupported. It reads immediately before patch and verifies immediately after patch; detected divergence triggers conflict/recovery rather than whole-file restore. It never directly writes `~/.paseo/config.json`.

### 5.2 Codex

- Resolve a launch prefix from explicit input or `PATH`. A native executable produces `[absoluteCodex]`; the supported npm launcher (`#!/usr/bin/env node`) produces `[absoluteNode, realpath(codexScript)]`. Other interpreter/shell launchers fail with remediation rather than depending on GUI `PATH`. Run `<prefix> --version` and `<prefix> debug models` with timeouts.
- Paseo `v0.8.0-beta.1` source contract appends `app-server` to this configured prefix before `spawnProcess`; the pinned integration fixture asserts exact argv and successful JSON-RPC initialization under a minimal daemon environment.
- Discover canonical home from explicit input, `CODEX_HOME`, or `$HOME/.codex`. After `realpath`, canonical home and managed root must be disjoint in both ancestor directions. Every shared-resource target must remain inside canonical home and outside the managed root.
- Parse canonical TOML with `smol-toml`; render a semantic copy for each role. Formatting/comments in the generated copy are not guaranteed; canonical bytes are untouched.
- Apply role overlay only to an allowlist of enforced scalar fields and insert the role developer-instructions block. Generic recursive merge is forbidden.
- Generate a model catalog from `<prefix> debug models`; set every `multi_agent_version` to `null`; point `model_catalog_json` at the generated catalog.
- Enforce `[agents].enabled = false`, `[features].multi_agent = false`, and either `[features.multi_agent_v2].enabled = false` or the compatible scalar representation detected from the source.
- Point `model_instructions_file` at the owned shared room instruction file.
- Link only approved resources that exist: required `auth.json`, `AGENTS.md`, `skills`, `plugins`; optional `hooks.json`. Link targets are realpath-validated and never dereferenced for backup/removal.

The installer guarantees it does not write canonical Codex paths. Because role homes link selected resources, a running Codex process may write through a link according to Codex behavior; this is explicitly not an OS-level read-only guarantee.

## 6. Security

- **Authentication:** Local Paseo CLI/SDK authentication uses `PASEO_PASSWORD` only. The value is passed in memory through the selected CLI environment and SDK config, redacted from errors, never included in argv/plan/manifest/journal, and never forwarded to Codex or provider environments.
- **Authorization:** The daemon remains the policy authority. Paseo Room requests native provider policy; it does not implement or claim an independent authorization layer.
- **Negative policy:** Verification fails unless Supervisor and Lead read back `enabled: true` and Peer reads back `enabled: false`. Missing/unknown policy is failure, not inheritance.
- **Filesystem:** Managed roots/backups are `0700`; regular files are `0600`; every destination and parent is checked with `lstat`/`realpath`. Symlink parents, path escape, hard-link alias risk for files being replaced, and non-owned collisions fail closed.
- **Process execution:** Executables are invoked with argv arrays and `shell: false`, a bounded timeout, sanitized output, and no interpolation. Provider profiles store an absolute native Codex executable or an absolute Node executable plus absolute Codex script; unsupported shebang launchers fail closed.
- **Secret handling:** Credential file contents and hashes are excluded from all artifacts. Backups record only symlink metadata for shared auth.
- **Review requirement:** Any future change that weakens Peer policy, adds partial `disabledTools`, follows links during mutation, accepts remote daemon targets, or adopts existing provider IDs requires explicit repository-owner security review.

## 7. Reliability and Consistency

### 7.1 Planning and ownership

Planner compares desired state with current state and the last committed manifest:

| State | Decision |
|---|---|
| First install; managed provider/path absent | Create |
| First install; managed provider/path already exists | Conflict; never adopt automatically |
| Update; current equals last applied | Replace with desired or no-op |
| Update; current equals desired | No-op and retain ownership |
| Update; current differs from both | Conflict; preserve current |
| Uninstall; current equals last applied | Remove |
| Uninstall; current customized | Preserve and report unresolved item |

Comparisons use canonical JSON for provider entries, SHA-256 for regular owned files, and literal link target/type for symlinks. Unrelated Paseo providers and non-manifest paths are ignored.

### 7.2 Apply and rollback flow

```text
preflight/read current state and local daemon admission
  → acquire global local-endpoint+provider-namespace lock; re-probe admission/current state
  → refuse active managed sessions or ownership conflicts
  → for first install, durably declare and create the absent managed root through the sibling bootstrap sidecar
  → render all desired artifacts into private transaction staging
  → validate TOML, catalog, links, modes, provider schema
  → persist journal + before-images
  → publish filesystem artifacts through journaled capture and no-clobber creation
  → patch all three Paseo entries in one daemon call
  → refresh/wait provider registry
  → verify files + live config + provider readiness
  → atomically commit manifest linked to transaction ID
  → mark journal committed and remove journal
```

On failure, compensation runs in reverse: restore/remove provider entries only if their current value still equals the transaction's `providerAfter`; restore files only if current content still equals the transaction's published value. If any value changed concurrently, it is preserved and the journal becomes `recovery-required`. After provider compensation, live config is read back. Rollback never replaces the whole Paseo config.

Each individual rename, hard-link publication, symlink creation, or directory creation is atomic, but an update/remove is intentionally a journaled sequence rather than one atomic replacement: the old destination is first moved to a transaction-declared unpredictable same-parent capture name and durably recorded, so the managed destination can be briefly absent; the desired value is then published without clobbering a concurrent winner. Recovery validates and preserves captures and destination values, restores only through no-clobber creation, and returns `recovery-required` whenever it cannot safely reclaim the original path. This is the Repository-owner-accepted portable Node 22 trade-off because Node exposes neither Linux `renameat2(RENAME_NOREPLACE)` nor macOS `renamex_np(RENAME_EXCL)`. Transaction-private names and captured inodes are owner-only integrity state; deliberate interference by another process running as the same UID, and concurrent writes through an already-open descriptor to the same inode, are outside the Phase 1 guarantee and must be serialized by the operator. Ordinary concurrent destination-name changes are preserved rather than overwritten. Filesystem, daemon config, and running sessions are not one ACID transaction. Apply/update/uninstall refuse while a non-terminal agent using one of the managed providers exists. Handled errors and `SIGINT`/`SIGTERM` trigger compensation; power loss and `SIGKILL` leave a journal for explicit recovery.

No automatic retry occurs for mutation calls because outcome may be ambiguous. Read-only probes may retry once for transient connection failure with bounded backoff. All subprocess and SDK waits have explicit timeouts.

### 7.3 Locking and idempotency

After local admission, mutating commands acquire one deterministic owner-only lock independent of `--room-home`, `--paseo-url`, `TMPDIR`, and `XDG_RUNTIME_DIR`: `/tmp/paseo-room-<uid>/daemon-<sha256(canonicalLocalHome,normalizedStatusListen,managed-provider-namespace)>.lock`. The status-reported canonical home and normalized loopback listen endpoint, not user-supplied endpoint spelling, form the stable lock key, so `localhost`/`127.0.0.1` aliases that target the selected status endpoint converge. Creation validates `/tmp`, creates the per-user directory as `0700`, rejects symlink/foreign-owner paths, and records PID/process-start evidence for stale-lock handling. Local admission and current providers are re-read after acquisition. This prevents different room roots or URL aliases admitted through the same local Paseo home/listen pair from claiming the same three provider IDs; the manifest is bound to the same endpoint identity hash. It does not lock Paseo UI/external SDK clients or prove WebSocket peer identity.

Root bootstrap serialization is additionally keyed by the canonical room path, so concurrent first installs cannot create the same root even if they target different admitted daemon namespaces. Bootstrap evidence is stored beside the root rather than under `/tmp`, survives daemon-lock cleanup or reboot, and is retired only after the internal transaction journal is durable.

One apply uses one complete fixed-shape provider patch, and post-write read-back catches visible same-ID races. Re-applying identical desired state generates no file or daemon mutation and leaves semantic state unchanged.

## 8. Critical Interaction and Failure Flows

### 8.1 Offline plan

`plan` discovers local files and CLI versions without connecting when the daemon is unavailable. Live checks are emitted as `not-checked`; no directory, lock, temp file, or cache is created. Such a plan is informative but not apply-ready.

### 8.2 Apply with incompatible daemon

Preflight validates local home/PID/UID/listen admission plus CLI/daemon version before staging. Missing capability, authentication failure, local-admission mismatch, or unreachability exits `1`; no managed path/provider is changed. Paseo Room prints operator-owned installation/upgrade/start instructions but performs none of them.

### 8.3 Verification failure after provider patch

The transaction restores provider entries conditionally, refreshes the registry, restores filesystem artifacts conditionally, and verifies the prior values. Successful compensation exits failed with the old installation intact. Ambiguous/concurrent divergence exits `4` with exact recovery evidence retained.

### 8.4 Recovery around the commit point

If the manifest exists with `lastTransactionId` equal to the interrupted install/update journal, recovery treats commit as complete and only marks/removes the journal. For uninstall, a `committed` journal is authority to finish manifest deletion and cleanup. Otherwise recovery conditionally rolls back recorded mutations. Tests inject crashes immediately before and after manifest replacement, journal commit marking, manifest deletion, and journal cleanup.

### 8.5 Uninstall with user customization

Unchanged owned artifacts/providers are removed. Customized items are preserved and listed as conflicts; mutable Codex runtime state is always preserved. A partial uninstall atomically writes a residual manifest with `status: "uninstall-incomplete"` and only unresolved ownership; it exits `3` but is transactionally complete. A later uninstall can discharge that residual manifest. No force-delete option exists in Phase 1.

## 9. Testing Strategy

Tooling: Vitest on Node.js 22, temporary homes, fake executables/SDK gateway for deterministic tests, and packed-package black-box tests. Linux runs in CI; macOS runs the same suite plus a documented local daemon smoke test.

| Layer | Evidence |
|---|---|
| Unit | Bidirectional canonical/managed-root separation; path containment/symlink rejection; canonical JSON/hash; semver and local-admission policy including prereleases; TOML overlay rules; native-agent disable; manifest schemas; ownership decision table; role instruction contract. |
| Property/fuzz | Random unrelated Paseo provider objects survive patch planning; arbitrary path components cannot escape managed root; repeated desired-state normalization is stable. |
| Integration with fakes | Failure injection before/after every file mutation, SDK patch, refresh, verify, manifest commit, and journal cleanup; reverse compensation; interrupted-journal recovery; same-ID races; timeouts; auth redaction. |
| Packed CLI | `npm pack`, execute package from clean temporary HOME, delete npm cache/package directory after apply, and prove managed provider specs do not reference it; compare wizard intent with flag intent. |
| Paseo `0.8.0-beta.1` contract | Start an isolated local daemon/home and fake Codex app-server; assert configured launch prefix becomes `<prefix> app-server` under minimal environment; patch three fixed-shape providers through public SDK; verify config read-back and ready snapshots; exercise create/resume/refresh/import policy paths where externally observable; then uninstall. |
| Real Codex smoke | Disposable role homes with real Codex: config parses, model catalog loads, app-server initializes, canonical home hashes are unchanged, native multi-agent metadata is disabled. Never use real auth in CI. |
| Platform | Linux CI for core lifecycle; macOS test from a minimal GUI-like environment verifies Node-script/native launch prefixes, local Desktop/daemon discovery, spaces in paths, and provider startup. Platform-injected unit tests prove the exact Desktop path invokes status directly while wrong platform/path, any other unsafe parent, and foreign/aliased/unresolvable `/Applications` fail before status. |

Acceptance fixtures include absent/corrupt config, existing unmanaged IDs, customized owned files, dangling/wrong links, either root nested inside the other, stale Codex prefix, unsupported shebang, CLI/daemon version mismatch, stopped/authenticated daemon, active managed sessions, write failures, `SIGINT`, incomplete journals, and crashes around every commit boundary. Concurrency tests start installs with distinct room roots, `localhost`/`127.0.0.1` endpoint aliases, and different runtime-directory environment variables against one daemon and prove exactly one can claim the provider namespace. A provider-shape test proves extra/missing keys conflict rather than being retained by deep merge.

## 10. Phase Scope Summary

- **Phase 1 MVP:** REQ-001 through REQ-016.
- **Deferred Phase 2:** REQ-017, homogeneous Claude Code adapter.
- **Deferred Phase 3:** REQ-018, homogeneous Pi adapter.
- **Deferred Phase 4:** REQ-019, homogeneous OpenCode adapter.
- **Later:** mixed-agent composition and optional plugin UI/observability; neither is on the policy enforcement path.

## 11. Backward Compatibility, Migration, and Rollback

- **Reference compatibility:** Preserve topology, role authority, canonical Codex ownership, isolated role homes, native-agent disable, fail-closed policy, idempotency, staging, conditional rollback, and modified-file preservation through characterization/contract tests.
- **Intentional differences:** Use native Paseo `paseoTools` instead of a fork/plugin; patch through the public daemon SDK instead of replacing Paseo config; sync generated Codex configuration on explicit apply instead of every provider launch; use manifest ownership instead of a hard-coded uninstall list.
- **Existing reference installation:** No automatic migration in Phase 1 because paths/ownership are not trustworthy across products. Detection reports a conflict and links to a manual side-by-side/removal procedure.
- **Manifest migration:** Version 1 is initial. Unknown versions are never rewritten. Future migrations must retain a pre-migration manifest and be idempotent.
- **Rollback:** Every apply has conditional before-images and provider values. Rollback restores only values still owned by the failed transaction; ordinary concurrent destination-name changes are contained as recovery-required rather than overwritten. Portable filesystem update/removal uses the accepted journaled-capture/no-clobber sequence from §7.2, including its temporary-absence and same-UID transaction-private interference limits.

### R3 decision

Risk owner: Repository owner. Destructive/weak-rollback risk is **contained**, not accepted as silent data loss: no force uninstall, no adoption of collisions, no full Paseo-config restore, and no overwrite after detected divergence. A disposable-home rehearsal with isolated Paseo/Codex fakes is required before release. A real macOS user-home rehearsal uses backups and checksum verification but no real credential copying. The alternative of editing `~/.paseo/config.json` directly is declined because it has weaker concurrency and daemon-activation guarantees.

## 12. Open Questions

| ID | Question | Owner | Status |
|---|---|---|---|
| Q-001 | Can all required create/resume/refresh/import tool-delivery paths be observed through supported external APIs, or must release evidence combine live config proof with pinned Paseo contract tests? | Repository owner | answered for planning: live config + ready inventory are CLI verification; pinned downstream contract tests provide lifecycle-path evidence |
| Q-002 | Should partial `disabledTools` be exposed in Phase 1? | Repository owner | answered: no; fixed all/none role defaults reduce policy ambiguity |
| Q-003 | Is launch-time regeneration required for behavioral compatibility? | Repository owner | answered: no; explicit apply plus doctor drift detection is the accepted safe difference |
| Q-004 | Which stable Paseo version replaces the beta floor? | Repository owner | deferred; non-blocking until a verified stable release contains the same policy/API |
| Q-005 | How should Phase 1 proceed when the pinned public Paseo client does not expose connected daemon identity? | Repository owner | answered — accept weaker local home/PID/UID/listen/version admission; retain local-only targets, re-probe under lock, verify after mutation, and record the limitation explicitly |

## 13. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-09 | Bytes | Created Draft from accepted PRD, reference characterization, and Paseo `v0.8.0-beta.1` source/API research. |
| 2026-09-09 | Bytes | Resolved review blockers: bidirectional path separation, global provider lock, fixed-shape deep-merge contract, explicit recovery/commit semantics, and verified Codex launch-prefix composition. |
| 2026-09-09 | Bytes | Canonicalized the cross-install writer lock by stable daemon ID and fixed per-user `/tmp` location so endpoint/environment aliases converge. |
| 2026-09-09 | Repository owner | Activated Technical Design and authorized the Phase 1 Implementation Plan. |
| 2026-09-09 | Bytes | Linked the Active clean-room role contract and added its managed workspace-protocol artifact. |
| 2026-09-09 | Repository owner / Bytes | Accepted and documented the local-admission delta after confirming `@getpaseo/client@0.8.0-beta.1` does not expose connected `serverId`; changed manifest/lock binding to canonical local home plus normalized listen endpoint. |
| 2026-09-10 | Repository owner / Implementation agent | Applied [change-001](../../plans/paseo-room-phase-1-change-001-macos-desktop-launcher.md), then simplified it per owner direction to the exact macOS Desktop path and `/Applications` metadata exception only. |
