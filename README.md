# paseo-room

One CLI that seats a **Supervisor → Lead → Peer** room on your local [Paseo](https://paseo.sh) daemon,
using the Codex, Claude Code and/or Pi you already have installed.

It does three things:

1. Reads your existing Codex / Claude Code / Pi configuration.
2. Writes one isolated role home per seat under `~/.paseo-room`. Each role owns its mutable
   credentials; read-only skills and other supported resources may be symlinked, and Peer
   receives a narrower set than Supervisor and Lead.
3. Registers those role homes with your running Paseo daemon as providers — room tools on for Supervisor and Lead, off for Peer — and adds one agent profile per seat so opening one is a single pick.

Everything it manages lives in `$HOME`, under `~/.paseo-room`. Agent runtimes may later
create role-owned credentials there. The CLI reads `~/.codex`, `~/.claude` and
`~/.pi/agent`; it never writes to them.

## Install and run

Nothing to install — run it with `npx`:

```bash
npx paseo-room                                    # guided setup (interactive terminal)
npx paseo-room setup                              # dry run: show exactly what would change
npx paseo-room setup --apply                      # do it (Codex seats)
npx paseo-room setup --agent codex --agent claude --apply
npx paseo-room setup --agent pi --apply                 # Pi seats
npx paseo-room verify                             # is the room still intact and compatible?
npx paseo-room auth login codex lead               # interactive login for exactly one role
npx paseo-room auth login claude peer
npx paseo-room auth login pi supervisor            # minimal Pi login session; run /login, then exit
npx paseo-room remove --apply                     # delete ~/.paseo-room (including role credentials) and providers
```

`setup` and `remove` are dry runs unless you pass `--apply`. Running with no arguments in a
terminal starts a short wizard: pick an action, pick the agents, review the plan, confirm.
Setup and the wizard never start login. `auth login` is a separate explicit action, requires
interactive stdin/stdout/stderr, and targets exactly one selected agent and role; it has no
`--all`, `--apply`, or status form.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--agent <codex\|claude\|pi>` | `codex` | Which coding agent to seat. Repeat the flag to combine agents. |
| `--apply` | off | Actually write setup/remove changes; `auth login` does not use it. |
| `--json` | off | One machine-readable document instead of text. |
| `--no-claude-memory-contract` | off | Omit the role contract from Claude role `CLAUDE.md` files, leaving the room plugin as the only Claude carrier. Your global memory is still carried. `setup` only. |
| `--room-home <path>` | `~/.paseo-room` | Where role homes are written. |
| `--codex-home <path>` | `~/.codex` | Source Codex configuration. |
| `--claude-home <path>` | `~/.claude` | Source Claude Code configuration. |
| `--pi-home <path>` | `~/.pi/agent` | Source Pi configuration and global adapter package. |
| `--codex-bin`, `--claude-bin`, `--pi-bin`, `--paseo-bin` | found on `PATH` | Executable overrides. |

Environment equivalents: `PASEO_ROOM_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PASEO_HOME`,
`PI_CODING_AGENT_DIR`, `CODEX_BIN`, `CLAUDE_BIN`, `PI_BIN`, `PASEO_BIN`. Flags win over
the environment.

`PASEO_PASSWORD` is used if your daemon requires one, and is redacted from all output.

Exit codes: `0` success, `1` a paseo-room check failed, `2` bad usage. After a vendor login
starts, its exit code is preserved; a signal is returned using the conventional
`128 + signal number` mapping.

## Requirements

- Node 22 or newer, macOS or Linux.
- A running Paseo daemon with CLI and daemon on the same version. Codex requires
  **0.8.0-beta.1 or newer**; any selection containing Claude or Pi requires **0.8.0 or newer**.
  Claude also requires Paseo plugins to be enabled explicitly: the generated trusted server plugin
  is the strong contract carrier, and `paseo-room` never enables plugins for you. The plugin is
  version-bounded to `>=0.8.0 <0.9.0`. `paseo-room` checks compatibility before touching anything,
  and never installs or upgrades Paseo.
- An initialised Codex home (`~/.codex/config.toml`) and/or Claude Code home (`~/.claude`).
  Codex must be new enough for `codex debug models` to print its JSON model catalog: the room
  seats Codex only if it can generate the scrubbed catalog copy.
  Setup never copies mutable credential stores or runs login. Use supported environment/static
  auth, or log in once in each role after setup. For current Claude runtimes, paseo-room
  pins both `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR` per role. It does not
  query Keychain state, and reports older-runtime Keychain isolation as unverifiable. See
  Anthropic's [credential-management reference](https://code.claude.com/docs/en/authentication#credential-management).
- An initialised Pi home (`~/.pi/agent`) and an operator-installed global
  `pi-mcp-adapter` package under its `npm/node_modules`. The package version is diagnostic,
  not a compatibility constraint. The room never installs or upgrades Pi or the adapter.

## What gets created

```text
~/.paseo-room/
  room.json                       # what this CLI created; verify and remove read it
  AUTHENTICATION.md               # exact per-role login commands; contains no secrets
  room/WORKSPACE_PROTOCOL.md      # the default protocol Lead carries, as one readable file
  plugin/                         # Claude only: trusted creation-time system-prompt append carrier
    paseo-plugin.json             # accepts Paseo >=0.8.0 <0.9.0
    index.server.ts, server/      # exact provider map + generated role contracts
  roles/codex/<role>/
    config.toml                   # your config.toml + the room's overrides
    role-instructions.md          # readable copy of what this seat was told
    model-catalog.json            # generated copy of your catalog, native multi-agent metadata removed
    auth.json                       # created and owned by Codex after role login, if file-backed
    AGENTS.md, skills, plugins, hooks.json              → symlinks into ~/.codex when present (Peer: see below)
  roles/claude/<role>/
    CLAUDE.md                     # your global memory + role instructions (contract omitted with --no-claude-memory-contract)
    settings.json                 # your settings.json + PASEO_ROOM_ROLE
    .claude.json                  # seeded once from yours, then owned by Claude
    .credentials.json                # created and owned by Claude after role login, if file-backed
    skills, plugins, commands, hooks, rules, output-styles,
    keybindings.json, themes                          → symlinks into ~/.claude when present (Peer: see below)
  roles/pi/<role>/
    settings.json                 # your settings minus package/extension declarations
    APPEND_SYSTEM.md              # your append + style/runtime capsules + role instructions
    auth.json                         # created and owned by Pi after role login, if used
    models.json, AGENTS.md, skills, prompts, themes,
    keybindings.json, mcp.json                        → symlinks into ~/.pi/agent when present (Peer: see below)
```

Each seat gets its own file-backed credential path, sessions, history and projects inside its
role home. Current supported runtimes therefore do not share mutable file-backed authentication
or conversation state; older-runtime Claude Keychain isolation remains unverifiable. Credential
paths are never managed-entry symlinks: setup and update preserve whatever is already there.

A managed file or symlink only ever replaces an absent path or the same shape, and it is
written to a temporary sibling and renamed into place, so a seat never reads a half-written
file. Anything else at a managed path — a directory where a file belongs, an unexpected
symlink — makes setup stop and name the path for you to move aside. Nothing is deleted
recursively on your behalf.

### What Peer does not receive

Peer has no room tools, so the room also stops handing it orchestration surfaces:

- Resources whose contents execute are not shared with Peer at all — Codex `plugins` and
  `hooks.json`, Claude `plugins`, `commands` and `hooks`, Pi `prompts`. Supervisor and Lead
  still get them.
- Peer's `skills` is not one symlink to your skills directory. It is a room-owned directory
  of links to each of your skills whose name does not start with `paseo` (any capitalization),
  so orchestration skills are not advertised to the seat that cannot orchestrate. Adding or
  removing one of your skills is drift `verify` reports and `setup --apply` reconciles.

Your own skills directory is never modified: `paseo*` skills stay exactly where they are.
An existing room upgrades its one legacy Peer `skills` symlink to that projection on the next
`setup --apply`; setup only unlinks the alias, never your skills, and stops with an actionable
message if that path has become something it does not recognize.

This is capability hygiene, not a sandbox. Peer still has shell access.

### Paseo MCP servers are refused, never rewritten

Paseo is the room's only control plane, so setup and verify read the MCP declarations in your
Codex `config.toml`, your Claude state, Pi's `mcp.json`, and any already-seeded role
`.claude.json`, and **fail before applying anything** if a declaration looks Paseo-related.
Recognition is one bounded rule — `paseo` as a whole identifier or path token, in the server
name, `command`, `args` or a URL field — and the message quotes the file and the field that
matched. It is a heuristic, not a scanner: a renamed or obfuscated endpoint passes it. Remove
or rename the server yourself; `paseo-room` never edits, filters or deletes your MCP
configuration.

Pi role homes deliberately do not link `extensions`, `npm`, `git`, `trust.json`, runtime
caches or session state. Their copied `settings.json` removes `packages` and `extensions`,
so startup cannot install configured packages or discover unrelated configured extensions.
The intended adapter remains in the operator's Pi package store and is loaded by canonical
path. Every Pi provider pins `PI_MCP_CONFIG_MODE=exclusive`, making the role home's linked
`mcp.json` the adapter's only configuration source and excluding generic global and project
MCP config discovery.

### Role authentication diagnostics

`setup` and `verify` inspect only credential path metadata, generated configuration names,
and environment-variable names. They never read credential contents, query a keyring, validate
a token over the network, or claim OAuth freshness. Authentication findings are warnings and
do not turn an otherwise valid setup or verify into a failure:

- **configured structurally** — a regular role credential file or supported auth configuration
  name exists; validity and freshness were not checked;
- **login-required** — no role credential artifact or safely recognizable alternative exists;
- **legacy-shared-risk** — an older room has a credential symlink, including one whose target
  may now be missing; only its stored link text is read, it is preserved, and the output gives
  manual unlink/login steps;
- **diverged-file-preserve/manual-recovery** — a role file or unexpected path type exists and
  is preserved; the output does not claim it is valid;
- **native-keyring unverifiable** — Codex selected `keyring`/`auto`, or Claude may use a macOS
  Keychain entry. Claude's current secure-storage location is pinned to the role home, but no
  keyring query or token validation is made and older runtime behavior is not assumed.

`setup --apply` writes `~/.paseo-room/AUTHENTICATION.md` with shell-quoted commands using the
exact executables resolved during that setup. It covers every selected agent and role and is
regenerated by later setup/update runs. You can either copy a command from that guide or use
the equivalent helper:

```bash
paseo-room auth login codex <supervisor|lead|peer>
paseo-room auth login claude <supervisor|lead|peer>
paseo-room auth login pi <supervisor|lead|peer>
```

The helper validates the room marker and selected seat, resolves the current executable from
the matching `--codex-bin`, `--claude-bin`, or `--pi-bin` override (or `PATH`), and gives the
vendor process the terminal unchanged. Codex runs `login` under the role's `CODEX_HOME`;
Claude runs `auth login` with both role config and secure-storage directories pinned. Pi opens
a minimal interactive login session in that role's home, isolated from the caller repository, with
`--no-extensions --no-approve --append-system-prompt ''` and visibly asks you to run `/login`.
The explicit empty append override suppresses discovery of the generated role
`APPEND_SYSTEM.md`, including its runtime capsule and role instructions. This direct launch
does not load `pi-mcp-adapter`, Paseo's integration extension, or the room-equivalent provider
argv. No login path reads, copies, links, replaces, validates, or deletes a credential store.

Codex diagnostics recognize an explicit `cli_auth_credentials_store` of `file`, `ephemeral`,
`auto`, or `keyring`. An `OPENAI_API_KEY` name in the setup shell does not count as stored role
auth; Codex's API-key login must create that role's native store. Claude recognizes the
documented cloud selectors, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, and `apiKeyHelper` by name. Pi recognizes a bounded list of built-in
provider API-key environment names. Names found only in the setup process are ambient and
unverifiable because their values are not copied into Paseo providers; other ambient provider
authentication may exist but is not validated.

## What the room changes

For Codex, the generated `config.toml` is a copy of yours with only these keys overridden:

| Key | Value | Why |
|---|---|---|
| `sandbox_mode` | `danger-full-access` | A seat that stops to ask for permission cannot be driven headless. |
| `approval_policy` | `never` | Same. |
| `developer_instructions` | the role contract | This is the room's whole instruction payload. |
| `model_catalog_json` | generated catalog | Strips `multi_agent_version` so the seat is not offered native collaboration. Setup **fails** if your Codex cannot produce a catalog. |
| `[agents].enabled` | `false` | Paseo owns agent lifecycle. Top-level only: Codex profiles have no such key. |
| `features.multi_agent`, `features.multi_agent_v2` | `false` | Same, at the feature-flag level. |

If your config has an active `profile`, every one of those keys a profile can also carry —
sandbox, approval, the catalog path and both multi-agent features — is written into that
profile too, because a profile outranks the top-level keys. Your model, reasoning effort, MCP
servers, trusted projects and every other key are copied through untouched.

The catalog is a closure, not a nicety, so it fails closed: if `codex debug models` cannot
run, does not print JSON, or prints JSON that is not a catalog object, no Codex seat is
planned and the message quotes the exact command it tried. A Codex too old to print that JSON
catalog cannot be seated.

What lands in each role home is a **generated copy** captured at that setup, and it replaces
Codex's built-in catalog for that seat. New models from a later Codex release therefore do not
reach a seat until you run `setup --apply` again. `verify` says so explicitly when a drifted
file is a `model-catalog.json`, because that seat is missing the closure rather than only
holding older contract text.

**The room never replaces an agent's base prompt.** Codex's `model_instructions_file`,
Claude's `--system-prompt` and Pi's `SYSTEM.md` / `--system-prompt` all *replace* the vendor
system prompt; using them would mean vendoring a full copy of that prompt and re-vendoring it
on every agent release. The role contract is additive instead: `developer_instructions` for
Codex, a room-owned Paseo creation hook that writes `config.systemPrompt` for Claude, and the
generated Pi `APPEND_SYSTEM.md` passed with `--append-system-prompt` for Pi. Pi keeps normal
project `AGENTS.md` / `CLAUDE.md` context loading.

For Claude, Paseo maps `config.systemPrompt` to the Claude Code preset's SDK `append` field,
so the native prompt remains intact while the generated role contract enters the instruction
layer. The trusted plugin targets only exact `claude-supervisor`, `claude-lead`, and
`claude-peer` room providers and skips internal agents; existing caller prompt text is
preserved. `CLAUDE.md` remains unchanged as a degraded and resume fallback. `verify` fails if
the plugin is absent, disabled, failed, registered from another path, or drifted, because a
silently missing carrier is not a guarantee. The hook runs for newly created sessions;
recreate an existing Claude session after setup or an update.

`setup --no-claude-memory-contract` leaves the plugin as the only Claude carrier: each role
`CLAUDE.md` then holds your global memory alone, and the file is not written at all when you
have none. Only the contract is dropped, never your own memory, and an earlier generation of it
is removed rather than left behind. The choice is recorded in `room.json`, so `verify` compares
against it and rejects the flag itself; `setup` without the flag restores the fallback. Keep the
fallback unless you have a reason not to: the plugin hook is verified, but whether a *resumed*
session re-enters it is unproven, and `CLAUDE.md` is what covers that case.

Pi providers use a strict command tail:

```text
--no-extensions --extension <canonical pi-mcp-adapter entry> --no-approve
--append-system-prompt <role APPEND_SYSTEM.md>
```

This is Paseo's core `pi` provider, not an OMP provider or compatibility layer.
Paseo appends and owns its own generated temporary integration extension; `paseo-room` does
not resolve, create or include it. Before planning any writes, the room validates the exact
global package identity and canonical entry containment, then runs one bounded offline Pi RPC
`get_commands` probe with `PI_CODING_AGENT_DIR=/dev/null`,
`PI_MCP_CONFIG_MODE=exclusive`, and `HOME` set to a fresh temporary working directory that is
removed afterwards. This prevents adapter startup from selecting operator-global or caller
project MCP configs during the probe. The correlated response must
attribute `/mcp` to `source: "extension"` at that same canonical path. Missing, malformed,
path-escaped or wrongly attributed adapters fail closed. The probe and setup do not write the
operator or planned role homes.

Each seat is also pinned at the Paseo provider level, because a provider entry outranks the
agent's own configuration:

| Pin | Applies to | Why |
|---|---|---|
| `params: {sandbox_mode, approval_policy}` | Codex | Without it Paseo sends its own mode preset (default `auto-review`) to the Codex app-server, and that outranks the generated `config.toml`. |
| `disallowedTools` for `Task`, `Agent`, `Workflow`, coordination, task-list, cron and team tools | Claude | Blocks legacy/current subagents, dynamic workflows, cross-session coordination and agent teams. |
| `disableAgentView: true` + `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` | Claude | Disables Claude's separate background-agent control plane across settings scopes and at launch. |
| `disableWorkflows: true` + `CLAUDE_CODE_DISABLE_WORKFLOWS=1` | Claude | Disables dynamic workflows through every entry point, beyond denying the `Workflow` tool. |
| `crossSessionInbound: "refuse"` | Claude | Prevents another Claude session from injecting a turn into a room seat. |
| strict argv + `PI_MCP_CONFIG_MODE=exclusive` + additive runtime capsule | Pi | Disables extension discovery and project trust, and restricts adapter config to the role-home `mcp.json`; forbids a second agent control plane without claiming sandboxing. |
| `paseoTools: {enabled}` | all | Room tools for Supervisor and Lead, never for Peer. |

`verify` compares each provider's `command`, `env`, `paseoTools` and pins against what the
room would write, and fails if one has been dropped — a pin that can be silently removed is
not a guarantee. The `env` map is compared whole rather than as a subset, because an added key
can re-enable exactly what a pin closes. Unrelated top-level provider fields stay yours.

It also saves one **agent profile** per seat, which is what the Paseo picker lists under
Profiles. A profile is a preset, not a constraint: it decides where a seat *starts*.

| Profile field | Value | Owned by |
|---|---|---|
| `provider` | that seat's provider | the room — repaired on every `setup --apply` |
| `name` | e.g. `Codex Lead` | the room |
| `icon` | `eye` / `compass` / `code` for Supervisor / Lead / Peer | the room |
| `color` | `violet` / `blue` / `emerald` for Supervisor / Lead / Peer | the room |
| `modeId` | `full-access` for Codex, `bypassPermissions` for Claude, absent for Pi | the room |
| `notes` | who may open this seat, shown to orchestrating agents by Paseo's `list_profiles` | the room |
| `thinkingOptionId` | `low` for Supervisor, `high` for Lead and Peer | seeded once, then yours |
| `model` | never written | yours |

Supervisor starts low because it routes rather than reasons. No seat starts on the top
option — Codex's `ultra` and Claude's `ultracode` advertise automatic task delegation, which
is a second control plane. `setup` restores room-owned identity, appearance and mode fields,
but leaves your model and reasoning choice alone; profiles you created yourself are never
touched. If you do put a room seat on `ultra` or `ultracode`, setup and verify warn and name
the seats: the room has not verified whether its closed multi-agent paths actually prevent
that option from delegating, so it reports the selection rather than rejecting or changing it.
The warning does not fail the command.

Pi exposes no selectable Paseo mode, so its profiles omit `modeId`; setup also removes a
stale room-owned value from an existing Pi profile. Pi has no sandbox or approval boundary:
its permissive runtime is necessary for headless operation but grants no additional authority.

Claude starts in Paseo's `bypassPermissions` mode, while Codex starts in its equivalent
`full-access` mode. Claude deny rules still apply in bypass mode, so native orchestration
stays unavailable. The room does not write `permissions.defaultMode` to `settings.json`:
Paseo passes the profile's mode as a command-line session setting, which outranks that file.
The two Claude disable environment keys are pinned in both the provider and generated
`settings.json`, because Claude applies settings-file environment values after launch values.
The generated top-level `disableAgentView` and `disableWorkflows` settings are also forced to
`true`; their restrictive value cannot be weakened by another ordinary settings scope.

No default model is pinned. The profile schema supports `model`, but leaving it absent lets
each provider use its current default and avoids silently choosing a cost/capability tier for
the operator.

### Recognizing a live room seat

Names are not identity. A matching cwd, title, or provider label does not make an existing
agent a room Lead or Peer. The exact eligibility procedure is model-facing wording and lives
in the contract itself —
the shared [Room Seat Identity](src/room/prompts/contract/shared-seat-identity.md) evidence,
with the role-specific procedures in
[the Supervisor contract](src/room/prompts/contract/supervisor.md) and
[the Lead contract](src/room/prompts/contract/lead.md) — rather than being restated here. In
outline: the seat's evidence is the current live configuration. Both seats read the exact current
`room-<agent>-<role>` profile from `list_profiles`, materialize every field it defines (agent
creation takes no profile id), then inspect the live seat's provider, workspace and mode.
Supervisor additionally uses `list_agents(cwd)` for discovery and corroborates Lead ownership by
parentage or known Human-opened history. For `room-<agent>-peer`, Lead copies provider, mode and
features exactly, keeps the profile's model unless the workspace protocol in force routes models,
chooses the thinking effort under that protocol's policy, and requires the live seat's
daemon-added `paseo.parent-agent-id` to name itself. An ambiguous Lead candidate goes to
duplicate recovery and Human escalation instead of being adopted.

Current Paseo agent sessions do not retain `profileId`. A direct launch with the exact
profile provider, mode and workspace is therefore **profile-equivalent**, but literal picker
click provenance cannot be established. The room does not introduce generation-versioned
provider ids or claim that the daemon enforces this procedural eligibility check.

## Keeping the room current

Role homes are generated once, at `setup` time. After you edit `~/.codex/config.toml`,
`~/.claude/settings.json`, or Pi's `settings.json` / `APPEND_SYSTEM.md`, run setup again to
fold the change into every seat. The same applies after upgrading `paseo-room`; a release
that changes generated headings or prompt assets produces expected one-time managed-file
drift.

Use the upgraded version with the same repeated `--agent` selection as the installed room:

```bash
npx paseo-room@<new-version> setup --agent codex --agent claude --agent pi
npx paseo-room@<new-version> setup --agent codex --agent claude --agent pi --apply
npx paseo-room@<new-version> verify
```

First inspect the dry run, then apply it. The apply regenerates managed prompt carriers,
the Codex model catalogs and `AUTHENTICATION.md` from the newly resolved binaries, but
preserves role credential paths and the operator agent homes. Stop and restart every affected
seat after the apply; sending another turn to an already-running seat is not a restart.
`setup` and `verify` prove the files and live Paseo configuration, not that an existing model
context reloaded them. Only a newly launched seat context is expected to ingest the
regenerated instructions.

`room.json` records a short `contract` digest of the role documents and workspace protocol
this room was installed from. When it differs from what the installed package renders — or is
absent, because the room predates the field — setup and verify warn that the seats are holding
older text and ask for `setup --apply` plus a restart. It is provenance you compare by eye, not
a security claim. Rooms written before the field still parse.

One migration happens on the first upgraded apply: an existing Peer `skills` symlink becomes
the room-owned projection described above. Only the alias is unlinked, never your skills, and
setup stops with an actionable message rather than guessing if that path has become something
it does not recognize.

To roll back, run the prior package version with the same agent selection and `setup --apply`,
then restart the affected seats again:

```bash
npx paseo-room@<prior-version> setup --agent codex --agent claude --agent pi --apply
npx paseo-room@<prior-version> verify
```

No reverse data migration is needed; a prior package regenerates its own marker, including
dropping or restoring the contract digest as its own schema requires. Do not use `remove` for a
version rollback: it deletes the room home, including role-owned credential files. Re-running
setup is safe because it rewrites only managed configuration that differs and never replaces
role credential paths.

There are three separate evidence boundaries:

- `setup --apply` and `verify`, backed by regression tests, prove the generated/live
  configuration chain: each room profile points to its exact role provider and owned mode,
  each provider points to the exact role home, and each provider-selected role home carries
  the exact prompt input with the applicable role contract, plus the default workspace protocol
  for Lead.
- Delivery of those files and arguments into a newly launched model context relies on the
  documented Codex, Claude Code and Pi configuration contracts for
  `developer_instructions`, `CLAUDE.md`, and `--append-system-prompt`.
- Neither command proves that an already-running process loaded the latest generation, or
  that a model followed instructions after receiving them. Re-run setup after source-config
  changes and start the seat whose context must ingest the regenerated files.

Changing which agents you seat removes their providers and profiles but preserves deselected
role homes, because they may contain role-owned credentials or runtime state. Remove those
homes manually, or use the explicit whole-room removal after reviewing its warning.

`remove --apply` deletes `~/.paseo-room`, including role-owned credential files, and the
providers it registered. Its dry run warns before deletion. Native OS keyring entries are not
inspected or deleted and may remain; operator agent-home credentials are untouched. It refuses
to run if `--room-home` points at a directory containing your home directory, and it leaves
unrelated Paseo providers alone. If Paseo cleanup cannot start or complete, removal fails closed:
the room home and marker remain intact so you can restore Paseo connectivity and run the same
command again.

## The role contract

The exact model-facing wording every seat reads lives in the canonical Markdown under
[`src/room/prompts/`](src/room/prompts/), organised by who reads it: one shared authority body
for every role, shared room-seat identity evidence for Supervisor and Lead, the shared challenge
vocabulary for Lead and Peer, exactly one body per role, and the default workspace document for
Lead. TypeScript selects those layers with `instructionKeys()` and `protocolKeys()`; it does not
duplicate their prose. In short:

- **Supervisor** routes Human directives to Lead and observes. Before opening a seat it checks
  for and reuses the project's existing Lead, including an idle or resumable Lead. It observes
  the Lead–Peer process for named failures and advises with evidence, but advice carries no
  technical authority: it does not edit project work, run validation, direct Peer, or decide
  technical acceptance. Room tools: on.
- **Lead** is the durable owner of one project across turns. It owns framing, decomposition,
  routing, integration and technical acceptance. A brief states the outcome and the evidence
  that settles it rather than pre-solving the work; any plan or file list in it is provisional.
  One moving write scope has exactly one owner, and at most one Peer is writable at a time.
  Room tools: on.
- **Peer** owns one bounded assignment — writable inside an assigned scope, or read-only
  against a named candidate, question or area — under exactly one disposition Lead names in the
  brief (Engineer, Architect, Reviewer or Scout), forms its own technical position from the code
  and its own verification, may challenge a failed premise with
  `REOPEN_REQUEST` / `DEPENDENCY_REQUEST` / `BLOCKED`, hands back reproducible evidence either
  way, and never accepts its own difficult change. Room tools: off.

Human keeps product goals, priority, material cost, external effects and irreversible risk.

One rule has no runtime enforcement behind it and so is procedural and regression-tested in
the contract instead: **one Lead owns one project; Supervisor discovers, verifies and reuses
it, while Lead alone opens verified Peer seats.** The eligibility evidence is summarized
above and stated exactly in the contract sections linked there. A completed turn, idle state,
pending permission, or resumable closed session is not an
absent Lead. Fresh independent review means that existing Lead opens a fresh read-only Peer;
it never means Supervisor opens another Lead.

Paseo takes the seat to open as a plain provider id, so if two Leads nevertheless appear,
Supervisor stops parallel routing, preserves both histories, keeps the previously established
healthy owner, and closes the duplicate only after a stable handoff. Ambiguous ownership,
health, or concurrent writes go back to Human rather than being guessed or merged.

Two further limits are deliberately conservative. **One writable Peer per project**, not one
per moving scope: the room gives you no writer isolation, so separate scopes are not evidence
of separate working trees, and no workspace protocol relaxes the limit. Concurrent writable
Peers in isolated worktrees are a deferred decision, not an oversight. And a seat's **model and
reasoning effort are not one knob**: the model stays the profile's default unless the workspace
protocol in force explicitly supplies model routing, while the thinking effort is Lead's
per-brief choice on task risk, uncertainty, context size and verification burden — lowest that
reliably answers the task, higher for architecture-sensitive or weakly observable work, only an
option the live Paseo and provider context establishes as supported, and never up to a tier
advertising automatic delegation. Provider, mode, workspace, parent and feature values are
eligibility evidence and copied exactly.

The room also ships a **default workspace protocol** — topology by difficulty, the four
disposition mandates, model and effort routing principles, ownership and candidate rhythm,
review triggers, verification, escalation, repository conventions, project anti-patterns and
protocol evolution — so a project has that layer without doing anything. It goes to **Lead
alone**, because Lead is the only standing reader of workflow policy: Lead resolves the
repository root, reads `WORKSPACE_PROTOCOL.md` in full when the repository ships one, and quotes
what bears on an assignment into the brief, including the exact verification command. Supervisor
carries no copy and reads a repository's protocol only under an explicit Human audit, update or
maintenance mandate; ordinary routing and observation need none of it, and it may propose a
change with causal evidence but never impose one. Peer is never told the filename at all, so it
spends its attention on one brief rather than on deciding which repository rules apply — what it
needs unconditionally is in its own contract, including the floor that no repository or workspace
instruction can enlarge or weaken its authority, with conflicts routed to Lead.

A repository that needs different rules writes `WORKSPACE_PROTOCOL.md` at its root, which wins
wherever it speaks while the default holds wherever it is silent — the root, because it is
agent guidance rather than project documentation. `~/.paseo-room/room/WORKSPACE_PROTOCOL.md` is
the whole default as one file, so you can read what is in force and start from it. The CLI
never writes into a repository.

## Working the room

The whole point is that you do not orchestrate. Say the outcome and the boundaries; let Lead
decide the route.

1. **Talk to one seat.** Six providers is not six windows. One project: open **Lead**. Several
   projects at once, or you want an audit trail of directives: open **Supervisor** only, and
   let it discover and reuse one Lead per project. Opening both and then talking to Lead makes
   Supervisor an expensive ornament with an incomplete record.
2. **Say the outcome, not the plan.** You may direct the technical route, but every time you
   do you take the acceptance risk back from Lead — and an orchestrator who has already solved
   the problem leaves the worker able to be right about only one thing.
3. **Interrupt at four boundaries only:** product goals and priority, material cost, external
   effects, irreversible risk. Technical route and ownership are Lead's.
4. **Read anything, direct one thing.** Reading a Peer's timeline is how you get evidence
   without becoming a second channel; stopping a seat is yours by right. But answering a
   Peer's `REOPEN_REQUEST` yourself means Lead never learns its premise was wrong and writes
   the same premise into the next brief. If you do override a Peer, tell Lead — it waits on
   events, so it will wait a long time.
5. **Accept the product, not the diff.** Ask for the candidate and the gate result. "It's
   done" is not evidence.
6. **When the room gets confusing, recreate it deliberately.** Review `remove` first because
   it deletes role credential files, then use `remove --apply` and `setup --apply`. Native
   keyring entries may remain and each new role may require login again.

Using one Peer directly, with no Lead at all, is fine for small single-scope work — that is
not breaking the room, it is not using it. Just be clear that you are then the Lead: the brief
and the technical acceptance are yours.

With more than one agent family seated, the highest-value use of another family is not splitting
work at random — it is **independent review**. A read-only Peer from a different model family
reading a candidate is more independent than a fresh session of the family that wrote it. Run
one project on one family and keep the other for the review seat. Ask the existing Lead for
that review; Supervisor must route the request to Lead rather than opening a fresh Lead.

## Documentation

- [docs/demonthorn-agent-orchestration-deep-dive.md](docs/demonthorn-agent-orchestration-deep-dive.md)
  — the reference model this tool implements: roles, authority, instruction layers, invariants,
  anti-patterns and operating checklists. Tool-agnostic; useful on its own.
- [docs/design.md](docs/design.md) — how and why this tool implements that model, and what
  it deliberately does not do. Read this before changing an override.
- [AGENTS.md](AGENTS.md) — working rules for contributors and coding agents.
- [docs/product/paseo-room-prd.md](docs/product/paseo-room-prd.md) — the original PRD, kept
  for history; the transactional-installer requirements in it were deliberately dropped.

## Development

```bash
npm run verify   # typecheck, lint, test, build, packed-package test — the gate order
```

Releases are published to npm from a GitHub Release; see
[AGENTS.md](AGENTS.md#releasing).

## License

[MIT](LICENSE) © Invoker
