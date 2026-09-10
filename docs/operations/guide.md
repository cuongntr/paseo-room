# Operator guide

Phase 1 supports homogeneous Codex rooms on **macOS and Linux**:
`Human → Supervisor → Lead → Peer`. The CLI and packed artifact are implemented;
the npm package is **not published**, is `UNLICENSED`, and is not release-approved.
**R3 is NOT YET EXECUTED and blocks release.** See the
[acceptance record](phase-1-acceptance.md) before any real-home use.
Examples use `paseo-room` from an explicitly selected, reviewed packed artifact;
`npx paseo-room` is the intended published entry point, not evidence of publication.

## Prerequisites and boundaries

The operator must already provide Node.js `>=22` and npm, an installed/authenticated
Codex with a usable canonical home, and Paseo CLI plus a running, reachable
current-user local daemon at `>=0.8.0-beta.1`. CLI/daemon versions must match and
native per-provider `paseoTools` policy must work; semver alone is insufficient.
Codex has no Phase 1 version floor: launch/config/catalog/app-server compatibility
is behavioral, not guaranteed by its version string. Recovery also needs the
standard macOS `lockf` or Linux `flock` utility.

Paseo Room **never installs, upgrades, authenticates, starts, stops, or repairs
Paseo or Codex**. Resolve prerequisite failures yourself using each dependency's
own documentation. Remote daemons, Windows, mixed agents and partial tool policies
are unsupported. Do not run automated tests against operator homes.

| Role | Managed provider ID | `paseoTools.enabled` |
|---|---|---|
| Supervisor | `codex-supervisor` | `true` |
| Lead | `codex-lead` | `true` |
| Peer | `codex-peer` | `false` |

Human retains product, priority, material cost, external effects and irreversible
risk. Lead owns technical acceptance and permits at most one writable Peer;
Supervisor routes rather than replacing a healthy Lead. Peer never orchestrates
or self-accepts difficult work. Generated overlays pin `gpt-5.6-sol`, `medium`,
`danger-full-access`, approval `never`, and disabled native multi-agent behavior.
**Peer policy is not an OS sandbox**: shell access can still invoke an independently
installed Paseo executable. Shared links may permit writes by Codex itself; the
installer does not own or mutate their targets. See the [role contract](../design/platform/paseo-room-role-contract.md).

## Public CLI

No arguments with terminal stdin/stdout starts the wizard. It displays the same
read-only install plan as flags and asks for explicit confirmation, default **no**.
Decline/cancel before apply exits 0 without changes. Failed prerequisites,
conflicts, recovery-required state and already-current rooms do not offer apply.
Explicit commands and `--non-interactive` never prompt; a missing command without
a terminal is usage exit 2.

| Command | Default behavior |
|---|---|
| `plan` | Read-only prerequisite discovery and install/update plan |
| `install` | Dry-run install/update; explicit apply publishes and verifies |
| `verify` | Read-only committed-artifact, inventory and policy verification |
| `doctor` | Read-only drift, dependency, launch and recovery diagnostics |
| `recover` | Dry-run interrupted-state classification; explicit apply reconciles |
| `uninstall` | Dry-run ownership-aware removal; explicit apply removes safe state |

| Option | Meaning |
|---|---|
| `--agent <agent>` | Only `codex`, also the default |
| `--apply` | Mutation authorization, **only valid for install/recover/uninstall** |
| `--json` | Exactly one schema-v1 JSON document on stdout |
| `--non-interactive` | Never prompt |
| `--room-home <path>` | Override managed root |
| `--codex-home <path>` | Override canonical Codex home |
| `--codex-bin <path>` | Select stable Codex executable/launcher |
| `--paseo-bin <path>` | Select installed Paseo CLI |
| `--paseo-url <ws-url>` | Local WebSocket endpoint matching admitted daemon |

`-h, --help` and `-V, --version` are informational switches. There is no
`--node-bin` or password option. Explicit selections override supported environment
defaults. Authenticated local daemons use environment-only `PASEO_PASSWORD`, passed
only to the selected status subprocess and public SDK, never argv or provider/Codex
environments. Do not put credentials in URLs; URL userinfo, queries and fragments
are rejected. Do not copy secret environment values into evidence.

```sh
paseo-room plan --agent codex --non-interactive
paseo-room install --agent codex                  # dry-run; inspect first
paseo-room install --agent codex --apply          # only after approval
paseo-room verify --json
paseo-room doctor --json
```

Using `--apply` with plan/verify/doctor is usage exit 2. Preserve the same explicitly
selected paths, binaries and endpoint on every command in an operation sequence.

### Results and exits

JSON fields are `schemaVersion: 1`, `command`, `outcome`, `changed`, `checks` and
`operations`. Checks have `id`, `status` (`pass`, `warn`, `fail`, `not-checked`),
`message` and optional `remediation`. Operations describe `create`, `update`,
`remove` or `noop` targets, never file contents. `changed: false` does not imply
success: inspect checks, outcome and process exit.

| Outcome | Meaning | Normal exit |
|---|---|---|
| `ok` | Success or clean no-change result | 0 |
| `changes-planned` | Read-only proposed changes, not an applied transaction | 0 |
| `failed` | Validation, compatibility, verification or operation failure | 1 |
| `conflict` | Ownership collision/customization, including residual uninstall | 3 |
| `recovery-required` | Interrupted, divergent or ambiguous state needs recovery | 4 |

Exit **2** means invalid usage (`failed` in JSON). A failed check also produces exit
1 unless conflict/recovery takes precedence. Exit **0** alone never proves release
acceptance or tool-delivery enforcement.

## Paths and ownership

Default managed root: `${XDG_DATA_HOME:-$HOME/.local/share}/paseo-room`, overridden
by `PASEO_ROOM_HOME` or `--room-home`. Its immediate parent must already exist with
safe ownership/permissions; no arbitrary parent tree is created. Canonical Codex
home defaults to `$HOME/.codex` (`CODEX_HOME` or `--codex-home` overrides). Paseo home
is `$HOME/.paseo` or `PASEO_HOME`. Managed and canonical Codex roots must be disjoint
in **both** ancestor directions.

```text
<room-home>/                             0700
  manifest.json                          0600
  room/model-instructions.md
  room/workspace-protocol.md             operator template, not a project edit
  roles/codex/{supervisor,lead,peer}/
    config.toml
    model-catalog.no-native-agents.json
    auth.json, AGENTS.md, skills, plugins  validated links to approved resources
    hooks.json                            optional link
    ...                                   unowned Codex mutable state
  transactions/<transaction-id>/
    journal.json                          0600
    before/                               0700
```

Owned regular files are `0600`; symlink declarations use mode `0777` and literal
targets. Manifest schema v1 records installation/package/transaction identity,
adapter, local endpoint binding, source compatibility/drift metadata, artifact
paths/kinds/modes/checksums/link targets and complete applied provider values.
Status is `committed` or `uninstall-incomplete`. Unknown schema versions fail closed.
Before-images belong to private transaction storage, never credential backups.
A first-install sibling bootstrap sidecar (`0600`) durably declares the absent
root before creation; it transfers authority to the internal journal. Do not
remove sidecars, journals, captures or locks manually.

Only manifest-declared state is owned. Canonical configuration/credentials,
unrelated providers and Codex-created mutable children remain unowned. No adoption,
force deletion, recursive cleanup, whole-Paseo-config restore or link-target
traversal is supported. Credential content must never be copied, logged, backed up
or hashed. No-follow owned-file hashing checks metadata and forbidden identities;
links are compared by metadata/literal target, not target bytes.

Provider updates use the public SDK, never direct Paseo config-file writes. Local
home/PID/UID/listen/version admission is **not cryptographic connected-peer identity**;
the pinned SDK cannot provide that proof. Apply rechecks under the namespace lock
and verifies complete provider values after mutation. Active/nonterminal managed
sessions (including idle/error), or incomplete inventory, block mutation. The
operator must serialize external same-ID edits and content writes. Journaled
capture/no-clobber replacement can briefly leave a destination absent; deliberate
same-UID interference with private transaction names or same-inode writes through
open descriptors is outside the guarantee.

## Diagnosis, drift and reapply

1. Run `doctor` and `plan` with the original selections; read check IDs and remediation.
   Missing/stopped/old/mismatched dependencies require operator action, not installer repair.
2. Canonical config or a moved stable Node/Codex launch prefix may require regeneration.
   Launches do not regenerate configuration and never depend on package/npm cache paths.
3. Review `install` dry-run. If ownership is unchanged, explicitly apply and run
   `verify`; a second identical apply must be a no-op. Semantic source changes can
   update artifacts; comment-only drift need not change rendered semantics.
4. Customized owned artifacts/providers are conflicts, not permission to overwrite.
   Preserve them and have the owner reconcile the exact difference before replanning.
   Do not edit the manifest to manufacture ownership.

Read-only verification inspects snapshots without registry refresh. Authorized
transactions refresh managed IDs and check readiness/config read-back. Neither
ready inventory nor a natural-language agent reply proves downstream tool delivery.

## Recovery and residual uninstall

Run `recover` first without apply. Only `recover --apply` may mutate unfinished
recovery state or reclaim a proven exact stale lock. Matching manifest transaction
IDs mean committed cleanup; committed full-uninstall journals authorize manifest
deletion. Otherwise compensation restores only values still equal to the recorded
after-value. Divergence, unknown children/evidence, active sessions or unresolved
provider RPC fences remain `recovery-required`. An ambiguous RPC can complete late:
an immediate read-back is not permission to retry or roll back blindly.

For removal, review `uninstall`, then use `uninstall --apply` only with approval.
Unchanged owned providers are removed/refreshed/verified before safe file removal.
Customized providers retain potentially referenced files. Customized files/links
and mutable children survive with a valid `uninstall-incomplete` residual manifest
and exit 3. This is a completed partial uninstall, not necessarily an interrupted
transaction. After explicit owner reconciliation, repeat uninstall to discharge
remaining ownership. Never recursively delete the root to bypass residual state.
Stop and preserve evidence on exit 4; there is no force/retry shortcut.

## Existing codex-room-setup installations

There is **no automatic migration or adoption** from `codex-room-setup` and no
reliable cross-product ownership import. Overlapping managed provider IDs or paths
are conflicts; this is not a promise of a special reference-product detector.
Stop and manually uninstall the old product using **its own procedure**, or choose
safe disjoint state before planning again. A different room root alone does not
avoid the fixed provider-ID collision on the same daemon. Any side-by-side state
must also have a disjoint, supported local daemon/provider namespace.

Paseo Room must never delete unknown reference state. Do not borrow its manifest,
copy its artifacts into a managed root, rename conflicting ownership into place,
or ask Paseo Room uninstall to clean it up. Preserve unresolved state and obtain
owner direction. See the [design's migration limits](../design/platform/paseo-room.md#11-backward-compatibility-migration-and-rollback)
and the [R3 controls](phase-1-acceptance.md#r3-procedure).
