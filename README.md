# paseo-room

`paseo-room` is an npm/npx CLI for creating a reproducible three-seat coding-agent room on a user-managed [Paseo](https://github.com/getpaseo/paseo) daemon.

```text
Human → Supervisor → Lead → Peer
```

> [!IMPORTANT]
> Phase 1 implementation acceptance complete on 2026-09-10; npm publication not performed and package remains `UNLICENSED`. The owner-approved macOS R3 rehearsal is complete. See the [operator guide](docs/operations/guide.md) and [acceptance/release record](docs/operations/phase-1-acceptance.md).

## Phase 1

Phase 1 creates a homogeneous Codex room with three managed Paseo providers:

| Role | Provider ID | Responsibility | Paseo tools |
|---|---|---|---|
| Supervisor | `codex-supervisor` | Preserve and route the Human's request | Enabled |
| Lead | `codex-lead` | Own architecture, decomposition, verification, and technical acceptance | Enabled |
| Peer | `codex-peer` | Deliver one bounded outcome and its evidence | Disabled |

All three roles use isolated generated Codex homes. Approved operator-owned resources such as authentication, global instructions, skills, and plugins are referenced without transferring ownership to Paseo Room.

Phase 1 targets macOS and Linux with:

- Node.js `>=22`
- Codex already installed and authenticated; compatibility is verified behaviorally because Phase 1 does not define a Codex version floor
- Paseo CLI and a reachable local daemon at `>=0.8.0-beta.1`; macOS also admits the exact standard Desktop launcher `/Applications/Paseo.app/Contents/Resources/bin/paseo` under the narrow parent exception described below
- The standard macOS `lockf` or Linux `flock` utility for recovery-only stale-lock serialization
- Native per-provider `paseoTools` policy

Paseo Room does not install, upgrade, authenticate, start, stop, or repair Paseo or Codex.

## Safety Model

Paseo Room is dry-run first:

- Planning is read-only.
- Install, recovery, and uninstall mutate only after wizard confirmation or explicit `--apply`.
- Managed ownership is recorded in a versioned manifest. On first install, a deterministic owner-only sibling bootstrap sidecar durably declares the absent root before creating it; authority transfers to the internal journal before that sidecar is removed. This closes the crash window without adopting a pre-existing root.
- Updates replace only state that still matches the previously applied value.
- Uninstall removes only unchanged manifest-owned state.
- Customized state and ordinary concurrent destination-name changes are preserved as a conflict or `recovery-required` condition. Portable update/removal uses a journaled capture followed by no-clobber publication, so a managed path may be briefly absent between durable atomic steps. Deliberate same-UID interference with transaction-private names/captured inodes and writes through an already-open descriptor are outside the Phase 1 guarantee and must be serialized.
- Paseo configuration is changed through the public daemon SDK, never by writing `~/.paseo/config.json` directly.
- Phase 1 admits only a running current-user local daemon whose canonical Paseo home, loopback listen endpoint, and CLI/daemon versions match. Executable parents remain fail-closed except that, on macOS only, mode-writable `/Applications` is tolerated for the exact canonical Paseo Desktop launcher when it is an `lstat`-confirmed root-owned directory whose real path is exactly `/Applications`; every other launcher and parent check is unchanged. The Desktop shell launcher receives only the provider-free system `PATH=/usr/bin:/bin`; password handling is unchanged. The pinned public SDK does not expose connected-peer identity, so Paseo Room does not claim cryptographic or protocol-level daemon identity; it rechecks local admission under the writer lock and verifies complete provider state immediately after mutation.
- Canonical Codex configuration is read, semantically rendered into isolated role overlays, and hashed for drift evidence, but is never modified. Credential contents are never read, copied, backed up, logged, or hashed by the installer; approved credential resources are shared only through validated links.
- Owned-file hashing on macOS/Linux runs in an empty-environment, bounded Node child anchored to the previously checked parent directory. The child checks cwd identity before opening a single basename with `O_NOFOLLOW`, checks the descriptor's exact metadata and forbidden identities before hashing, and returns only SHA-256. Parent/leaf replacements fail closed; renaming an already anchored parent cannot redirect the read. This is not a snapshot against concurrent writes to the same inode; callers must serialize content mutation. Symlinks are compared by metadata and literal target, never target bytes.
- Provider launch commands use stable absolute Codex/Node paths and do not depend on an npm cache or the GUI daemon's shell `PATH`.

The internal live-verification boundary refreshes exactly the managed IDs, waits with a bounded timeout, compares complete provider entries through connected daemon config read-back, and reads agent inventory on the same admitted connection. Missing, duplicate, non-ready, malformed, or incorrect-policy entries fail closed. Only closed or explicitly archived managed agents are safely terminal; initializing, idle, running, and error agents block mutation. An incomplete inventory also blocks mutation. Transaction verification never patches configuration or creates agents; refresh is its sole non-read action. Public read-only commands instead inspect snapshots without refreshing the registry.

The pinned SDK requires the public `appVersion: '0.8.0-beta.1'` compatibility declaration to expose derived providers and their agents; without it the daemon returns a legacy-filtered inventory. This is the supported client protocol baseline, not Paseo Room's package version or connected-peer identity. Agent pagination is not followed automatically: a partial response fails closed rather than claiming no active sessions.

Pinned isolated-daemon tests prove discovery readiness and live config policy read-back, not tool delivery on create/resume/refresh/import paths. Those lifecycle enforcement contracts remain release evidence; readiness and natural-language responses are not policy proof.

`paseoTools.enabled: false` prevents Paseo tools from being delivered to Peer. It is **not an operating-system sandbox** and cannot prevent a shell-capable process from invoking an independently installed `paseo` executable.

## CLI

### Interactive setup

The `npx` examples describe the intended published entry point; until publication, use an explicitly selected, reviewed packed artifact rather than assuming the registry package exists. Real-home rehearsal requires separate owner approval.

```bash
npx paseo-room
```

With terminal input and output, running without arguments starts the Codex setup wizard. It collects optional room-home, Codex-home, Codex-binary, Paseo-binary, and local Paseo-URL overrides; leave any answer blank to keep the same defaults as `install` flags. Paseo-URL input is masked so a malformed credential-bearing value is not echoed before validation rejects it.

The wizard displays the read-only install plan and prerequisite diagnostics before asking for explicit apply confirmation (default: no). Failed prerequisites, ownership conflicts, recovery-required state, and already-current rooms do not offer apply. Declining or cancelling before apply exits 0 with no changes. Confirmed apply uses the same lifecycle and transaction safety checks as `install --apply`.

Explicit commands and `--non-interactive` never prompt. Without a terminal, a missing command returns usage exit 2 without waiting for input. There is no password or Node-binary prompt; authenticated daemons use environment-only `PASEO_PASSWORD`.

### Automation

```bash
# Always read-only
npx paseo-room plan --agent codex

# Dry-run unless --apply is present
npx paseo-room install --agent codex
npx paseo-room install --agent codex --apply

# Read-only inspection
npx paseo-room verify
npx paseo-room doctor

# Dry-run unless --apply is present
npx paseo-room recover
npx paseo-room recover --apply
npx paseo-room uninstall
npx paseo-room uninstall --apply
```

Lifecycle options (`--agent` defaults to `codex`; no other agent is supported):

```text
--agent <agent>
--apply
--json
--non-interactive
--room-home <path>
--codex-home <path>
--codex-bin <path>
--paseo-bin <path>
--paseo-url <ws-url>
```

`--apply` is valid only for `install`, `recover`, and `uninstall`; using it with `plan`, `verify`, or `doctor` is usage exit 2. `-h, --help` and `-V, --version` are informational switches. There is no `--node-bin` option.

For authenticated local daemons, provide `PASEO_PASSWORD` through the environment. Paseo Room passes it only to the selected Paseo status process and public SDK connection, never in argv or provider/Codex environments. There is intentionally no password flag.

### Machine-readable results

With `--json`, stdout contains exactly one schema-v1 JSON document with `command`, `outcome`, `changed`, `checks`, and `operations`. Outcomes are `ok`, `changes-planned`, `failed`, `conflict`, and `recovery-required`. Usage errors use `failed` with exit 2; a failed check also causes exit 1 unless conflict/recovery takes precedence. See [result details](docs/operations/guide.md#results-and-exits). Exit codes are:

| Code | Meaning |
|---:|---|
| `0` | Success or clean no-change result |
| `1` | Validation, compatibility, verification, or operation failure |
| `2` | Invalid CLI usage |
| `3` | Ownership conflict |
| `4` | Recovery required |

## Managed State

The default managed root is:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/paseo-room
```

`PASEO_ROOM_HOME` or `--room-home` may override it. Its immediate parent must already exist with safe ownership and permissions; the CLI does not create arbitrary parent trees. The managed layout contains:

```text
<paseo-room-home>/
  manifest.json
  room/
    model-instructions.md
    workspace-protocol.md
  roles/codex/
    supervisor/
    lead/
    peer/
  transactions/
```

Only paths and provider entries recorded in the manifest are owned. Owned file hashing uses a no-follow read-only descriptor, validating its identity, owner, mode, and link count before reading any bytes. Symlink declarations record mode `0777` and the literal target; observation compares link metadata without reading the target. Codex-created mutable files inside role directories remain unowned and are preserved.

## Role Authority

The Room follows these boundaries:

- The **Human** owns product goals, priority, material cost, external effects, and irreversible-risk decisions.
- The **Supervisor** routes the Human's request faithfully and does not perform project work or technical acceptance while Lead is healthy.
- The **Lead** owns technical direction, decomposition, integration, verification, and acceptance. At most one writable Peer may own files or code that are actively changing; Lead does not edit that same scope concurrently.
- The **Peer** owns one delegated outcome, may challenge assumptions with evidence, and never orchestrates agents or self-accepts difficult work.

The normative RC-001–RC-305 semantics are defined in the [Role Compatibility Contract](docs/design/platform/paseo-room-role-contract.md).

## Out of Scope for Phase 1

- Claude Code, Pi, or OpenCode adapters
- Mixed-agent rooms
- Windows support
- Remote Paseo daemons
- Partial `disabledTools` policies
- A mandatory Paseo plugin
- OS-level sandboxing
- Force adoption or force deletion
- Automatic migration from `codex-room-setup`

Later phases add homogeneous Claude Code, Pi, and OpenCode adapters while retaining the shared lifecycle and authority contracts.

## Development Status

Implementation is tracked in the repository's Beads graph:

```bash
bd ready --json
bd show paseo-room-s7a --json
```

The graph contains seven work packages covering package contracts through release acceptance. Implemented lifecycle behavior passed the [hosted Linux/macOS gates](https://github.com/cuongntr/paseo-room/actions/runs/34426300649), and the completed real-macOS evidence is recorded in the [acceptance matrix and R3 record](docs/operations/phase-1-acceptance.md).

The required verification order is:

```text
typecheck → lint → unit/property tests → integration tests → build/pack → isolated contract/platform tests
```

Run the same ordered gates as the Linux/macOS Node 22 CI matrix:

```sh
npm ci
npm run typecheck
npm run lint
npm test                    # unit/property + integration/failure injection
npm run build
npm pack --dry-run
npm run test:package         # requires /usr/bin/expect; no TTY skip
npm run test:paseo           # isolated @getpaseo/cli@0.8.0-beta.1 contract
npm run test:macos           # macOS only: packed minimal GUI-like smoke
```

On Ubuntu, install the PTY prerequisite with `sudo apt-get update && sudo apt-get install -y expect`. On macOS, verify the system prerequisite with `test -x /usr/bin/expect && /usr/bin/expect -v`. Missing prerequisites fail the gate rather than skipping tests. `npm run verify` retains its local typecheck-through-packed-suite scope; CI explicitly runs the isolated contract afterward. The focused `test:macos` command builds and packs independently, and fails if invoked on another OS.

The macOS smoke uses paths containing spaces, a minimal explicit environment, a system-only daemon `PATH`, the packed CLI, and a disposable loopback daemon plus credential-free fake Codex. It proves three absolute Node-script provider launches and true/true/false policy read-back, not a real Desktop launch, real Codex behavior, native-binary launch coverage, or tool-delivery enforcement. See [platform and packed test evidence](test/PACKED-LIFECYCLE.md) for boundaries and results. CI requires registry access for isolated pinned daemon installs; it does not upload daemon logs, homes, or credential-bearing artifacts.

Automated development and acceptance tests must use disposable homes and isolated daemons. The completed macOS R3 real user-home risk-containment rehearsal used separate owner approval; the retained R3 controls govern any repeat rehearsal.

Contributor and coding-agent rules are in [AGENTS.md](AGENTS.md).

## Documentation

- [Operator guide: diagnosis, drift/reapply, recovery, residual uninstall and reference-install conflicts](docs/operations/guide.md)
- [Phase 1 acceptance matrix and owner-approved R3 procedure](docs/operations/phase-1-acceptance.md)
- [Product Requirements](docs/product/paseo-room-prd.md)
- [Technical Design](docs/design/platform/paseo-room.md)
- [Role Compatibility Contract](docs/design/platform/paseo-room-role-contract.md)
- [Phase 1 Implementation Plan](docs/plans/paseo-room-phase-1-implementation-plan.md)

## Clean-Room Notice

Paseo Room is a clean-room behavioral implementation. The project does not copy or package code, prose, templates, tests, or artifacts from the unlicensed `codex-room-setup` reference repository.

## License

No license has been selected yet. Until the repository owner adds one, no license is granted beyond rights provided by applicable law.

## Existing Reference Installations

There is no automatic migration/adoption from `codex-room-setup`. Overlapping managed IDs or paths are conflicts, not state Paseo Room may delete. Stop and manually uninstall the old product using its own procedure, or choose safe disjoint state before planning again. A different room root alone does not avoid fixed provider-ID collisions on the same daemon. See [manual handling and ownership limits](docs/operations/guide.md#existing-codex-room-setup-installations).

## Recovery and Uninstall Core

The CLI routes recovery and uninstall through the shared lifecycle core. Both default to read-only inspection. Explicit apply acquires the daemon namespace lock and rechecks local admission, provider state, and sessions. Normal mutation never removes stale lock evidence; explicit recovery alone may reclaim an exact stale owner record while an OS advisory guard serializes concurrent recoverers.

Recovery reconciles matching manifest transaction IDs as committed cleanup. A committed full-uninstall journal authorizes manifest deletion; other transactions are conditionally reversed. Unknown evidence, divergence, active sessions, or an unresolved provider RPC fence remain recovery-required without an automatic mutation retry. An unresolved RPC can complete late: an immediate config read is not proof that retry or rollback is safe.

Uninstall removes only unchanged ownership, refreshing and verifying provider removal before removing files. Customized providers retain potentially referenced files. Mutable children and customized files/links survive in a valid `uninstall-incomplete` residual manifest; after explicit user reconciliation, a later uninstall can discharge it. There is no force removal, recursive deletion, link-target traversal, or whole-config restore.
