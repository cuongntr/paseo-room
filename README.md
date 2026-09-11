# paseo-room

One CLI that seats a **Supervisor → Lead → Peer** room on your local [Paseo](https://paseo.sh) daemon,
using the Codex, Claude Code and/or Pi you already have installed.

It does three things:

1. Reads your existing Codex / Claude Code / Pi configuration.
2. Writes one isolated role home per seat under `~/.paseo-room`. Each role owns its mutable
   credentials; read-only skills, plugins and other supported resources may be symlinked.
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
npx paseo-room remove --apply                     # delete ~/.paseo-room (including role credentials) and providers
```

`setup` and `remove` are dry runs unless you pass `--apply`. Running with no arguments in a
terminal starts a short wizard: pick an action, pick the agents, review the plan, confirm.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--agent <codex\|claude\|pi>` | `codex` | Which coding agent to seat. Repeat the flag to combine agents. |
| `--apply` | off | Actually write the changes. |
| `--json` | off | One machine-readable document instead of text. |
| `--room-home <path>` | `~/.paseo-room` | Where role homes are written. |
| `--codex-home <path>` | `~/.codex` | Source Codex configuration. |
| `--claude-home <path>` | `~/.claude` | Source Claude Code configuration. |
| `--pi-home <path>` | `~/.pi/agent` | Source Pi configuration and global adapter package. |
| `--codex-bin`, `--claude-bin`, `--pi-bin`, `--paseo-bin` | found on `PATH` | Executable overrides. |

Environment equivalents: `PASEO_ROOM_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PASEO_HOME`,
`PI_CODING_AGENT_DIR`, `CODEX_BIN`, `CLAUDE_BIN`, `PI_BIN`, `PASEO_BIN`. Flags win over
the environment.

`PASEO_PASSWORD` is used if your daemon requires one, and is redacted from all output.

Exit codes: `0` success, `1` a check failed, `2` bad usage.

## Requirements

- Node 22 or newer, macOS or Linux.
- A running Paseo daemon with CLI and daemon on the same version. Codex and Claude require
  **0.8.0-beta.1 or newer**; any selection containing Pi requires **0.8.0 or newer**.
  `paseo-room` checks this before touching anything, and never installs or upgrades Paseo.
- An initialised Codex home (`~/.codex/config.toml`) and/or Claude Code home (`~/.claude`).
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
  room/WORKSPACE_PROTOCOL.md      # the default protocol every seat carries, as one readable file
  roles/codex/<role>/
    config.toml                   # your config.toml + the room's overrides
    role-instructions.md          # readable copy of what this seat was told
    model-catalog.json            # your catalog with native multi-agent metadata removed
    auth.json                       # created and owned by Codex after role login, if file-backed
    AGENTS.md, skills, plugins, hooks.json              → symlinks into ~/.codex when present
  roles/claude/<role>/
    CLAUDE.md                     # your global memory + role instructions
    settings.json                 # your settings.json + PASEO_ROOM_ROLE
    .claude.json                  # seeded once from yours, then owned by Claude
    .credentials.json                # created and owned by Claude after role login, if file-backed
    skills, plugins, commands, hooks, rules, output-styles,
    keybindings.json, themes                          → symlinks into ~/.claude when present
  roles/pi/<role>/
    settings.json                 # your settings minus package/extension declarations
    APPEND_SYSTEM.md              # your append + style/runtime capsules + role instructions
    auth.json                         # created and owned by Pi after role login, if used
    models.json, AGENTS.md, skills, prompts, themes,
    keybindings.json, mcp.json                        → symlinks into ~/.pi/agent when present
```

Each seat gets its own file-backed credential path, sessions, history and projects inside its
role home. Current supported runtimes therefore do not share mutable file-backed authentication
or conversation state; older-runtime Claude Keychain isolation remains unverifiable. Credential
paths are never managed-entry symlinks: setup and update preserve whatever is already there.

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

Authenticate each role manually when its diagnostic asks:

```bash
CODEX_HOME=<role-home> codex login
CODEX_HOME=<role-home> codex login status

CLAUDE_CONFIG_DIR=<role-home> CLAUDE_SECURESTORAGE_CONFIG_DIR=<role-home> claude auth login
CLAUDE_CONFIG_DIR=<role-home> CLAUDE_SECURESTORAGE_CONFIG_DIR=<role-home> claude auth status
# If `claude auth login` is unavailable, launch Claude with both directories and run /login.

PI_CODING_AGENT_DIR=<role-home> pi
# Then run /login interactively; no noninteractive Pi login is assumed.
```

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
| `model_catalog_json` | generated catalog | Strips `multi_agent_version` so the seat is not offered native collaboration. Skipped, with a warning, if your Codex cannot produce a catalog. |
| `[agents].enabled` | `false` | Paseo owns agent lifecycle. |
| `features.multi_agent`, `features.multi_agent_v2` | `false` | Same, at the feature-flag level. |

If your config has an active `profile`, the same sandbox and approval overrides are written
into that profile too, because a profile outranks the top-level keys. Your model, reasoning
effort, MCP servers, trusted projects and every other key are copied through untouched.

**The room never replaces an agent's base prompt.** Codex's `model_instructions_file`,
Claude's `--system-prompt` and Pi's `SYSTEM.md` / `--system-prompt` all *replace* the vendor
system prompt; using them would mean
vendoring a full copy of that prompt and re-vendoring it on every agent release. The role
contract is additive instead: `developer_instructions` for Codex, `CLAUDE.md` for Claude,
and the generated Pi `APPEND_SYSTEM.md` passed with `--append-system-prompt` for Pi. Pi keeps
normal project `AGENTS.md` / `CLAUDE.md` context loading.

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
touched.

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

## Keeping the room current

Role homes are generated once, at `setup` time. After you edit `~/.codex/config.toml`,
`~/.claude/settings.json`, or Pi's `settings.json` / `APPEND_SYSTEM.md`, run `setup --apply`
again to fold the change into every seat.
`verify` reports the drift in the meantime, and re-running `setup` is safe: it rewrites only
managed configuration that differs and never replaces role credential paths.

Changing which agents you seat removes their providers and profiles but preserves deselected
role homes, because they may contain role-owned credentials or runtime state. Remove those
homes manually, or use the explicit whole-room removal after reviewing its warning.

`remove --apply` deletes `~/.paseo-room`, including role-owned credential files, and the
providers it registered. Its dry run warns before deletion. Native OS keyring entries are not
inspected or deleted and may remain; operator agent-home credentials are untouched. It refuses
to run if `--room-home` points at a directory containing your home directory, and it leaves
unrelated Paseo providers alone.

## The role contract

The exact wording every seat reads lives in [`src/room/clauses.ts`](src/room/clauses.ts).
In short:

- **Supervisor** routes Human directives to Lead and observes. Before opening a seat it checks
  for and reuses the project's existing Lead, including an idle or resumable Lead. It does
  not edit project work, run validation, direct Peer, or decide technical acceptance. Room
  tools: on.
- **Lead** is the durable owner of one project across turns. It owns framing, decomposition,
  routing, integration and technical acceptance. One moving write scope has exactly one
  owner, and at most one Peer is writable at a time. Room tools: on.
- **Peer** owns one bounded outcome, may challenge a failed premise with
  `REOPEN_REQUEST` / `DEPENDENCY_REQUEST` / `BLOCKED`, hands back a reproducible candidate,
  and never accepts its own difficult change. Room tools: off.

Human keeps product goals, priority, material cost, external effects and irreversible risk.

One rule has no runtime enforcement behind it and so is procedural and regression-tested in
the contract instead: **one Lead owns one project; Supervisor discovers and reuses it, while
Lead alone opens Peer seats.** A completed turn, idle state, pending permission, or resumable
closed session is not an absent Lead. Fresh independent review means that existing Lead opens
a fresh read-only Peer; it never means Supervisor opens another Lead.

Paseo takes the seat to open as a plain provider id, so if two Leads nevertheless appear,
Supervisor stops parallel routing, preserves both histories, keeps the previously established
healthy owner, and closes the duplicate only after a stable handoff. Ambiguous ownership,
health, or concurrent writes go back to Human rather than being guessed or merged.

Every seat also carries a **default workspace protocol** — topology by difficulty,
verification, review, repository conventions — so a project has that layer without doing
anything. Each seat gets the sections that bear on its own work; topology goes to Lead and
Supervisor, not to Peer. A repository that needs different rules writes
`docs/WORKSPACE_PROTOCOL.md`, which wins wherever it speaks while the default holds
wherever it is silent. `~/.paseo-room/room/WORKSPACE_PROTOCOL.md` is the whole default as
one file, so you can read what is in force and start from it.

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

- [docs/orchestration-model.md](docs/orchestration-model.md) — the reference model this
  tool implements: roles, authority, instruction layers, invariants, anti-patterns and
  operating checklists. Tool-agnostic; useful on its own.
- [docs/design.md](docs/design.md) — how and why this tool implements that model, and what
  it deliberately does not do. Read this before changing an override.
- [AGENTS.md](AGENTS.md) — working rules for contributors and coding agents.
- [docs/product/paseo-room-prd.md](docs/product/paseo-room-prd.md) — the original PRD, kept
  for history; the transactional-installer requirements in it were deliberately dropped.

## Development

```bash
npm run verify   # typecheck, lint, test, build — the gate order
```

Releases are published to npm from a GitHub Release; see
[AGENTS.md](AGENTS.md#releasing).

## License

[MIT](LICENSE) © Invoker
