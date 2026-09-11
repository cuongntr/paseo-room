# paseo-room

One CLI that seats a **Supervisor → Lead → Peer** room on your local [Paseo](https://paseo.sh) daemon,
using the Codex and/or Claude Code you already have installed.

It does three things:

1. Reads your existing Codex / Claude Code configuration.
2. Writes one isolated role home per seat under `~/.paseo-room`, sharing file-backed login
   where supported, plus skills and plugins, by symlink.
3. Registers those role homes with your running Paseo daemon as providers — room tools on for Supervisor and Lead, off for Peer — and adds one agent profile per seat so opening one is a single pick.

Everything it creates lives in `$HOME`, under one directory it owns outright. It reads
`~/.codex` and `~/.claude`; it never writes to them.

## Install and run

Nothing to install — run it with `npx`:

```bash
npx paseo-room                                    # guided setup (interactive terminal)
npx paseo-room setup                              # dry run: show exactly what would change
npx paseo-room setup --apply                      # do it (Codex seats)
npx paseo-room setup --agent codex --agent claude --apply
npx paseo-room verify                             # is the room still intact and compatible?
npx paseo-room remove --apply                     # delete ~/.paseo-room and its providers
```

`setup` and `remove` are dry runs unless you pass `--apply`. Running with no arguments in a
terminal starts a short wizard: pick an action, pick the agents, review the plan, confirm.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--agent <codex\|claude>` | `codex` | Which coding agent to seat. Repeat the flag for both. |
| `--apply` | off | Actually write the changes. |
| `--json` | off | One machine-readable document instead of text. |
| `--room-home <path>` | `~/.paseo-room` | Where role homes are written. |
| `--codex-home <path>` | `~/.codex` | Source Codex configuration. |
| `--claude-home <path>` | `~/.claude` | Source Claude Code configuration. |
| `--codex-bin`, `--claude-bin`, `--paseo-bin` | found on `PATH` | Executable overrides. |

Environment equivalents: `PASEO_ROOM_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PASEO_HOME`,
`CODEX_BIN`, `CLAUDE_BIN`, `PASEO_BIN`. Flags win over the environment.

`PASEO_PASSWORD` is used if your daemon requires one, and is redacted from all output.

Exit codes: `0` success, `1` a check failed, `2` bad usage.

## Requirements

- Node 22 or newer, macOS or Linux.
- A running Paseo daemon, version **0.8.0-beta.1 or newer**, with CLI and daemon on the same
  version. `paseo-room` checks this before touching anything, and never installs or upgrades
  Paseo for you.
- An initialised Codex home (`~/.codex/config.toml`) and/or Claude Code home (`~/.claude`).
  Log in to those tools yourself first; the room never creates credentials. Codex auth and
  Claude's file-backed `.credentials.json` are shared. On macOS, Claude's default Keychain
  login is scoped to `CLAUDE_CONFIG_DIR`, so use inherited environment auth or log in once
  in each Claude seat instead. See Anthropic's
  [credential-management reference](https://code.claude.com/docs/en/authentication#credential-management).

## What gets created

```text
~/.paseo-room/
  room.json                       # what this CLI created; verify and remove read it
  room/WORKSPACE_PROTOCOL.md      # the default protocol every seat carries, as one readable file
  roles/codex/<role>/
    config.toml                   # your config.toml + the room's overrides
    role-instructions.md          # readable copy of what this seat was told
    model-catalog.json            # your catalog with native multi-agent metadata removed
    auth.json, AGENTS.md, skills, plugins, hooks.json   → symlinks into ~/.codex
  roles/claude/<role>/
    CLAUDE.md                     # your global memory + role instructions
    settings.json                 # your settings.json + PASEO_ROOM_ROLE
    .claude.json                  # seeded once from yours, then owned by Claude
    .credentials.json, skills, plugins, commands, hooks, rules, output-styles,
    keybindings.json, themes                         → symlinks into ~/.claude
```

Each seat keeps its own sessions, history and projects inside its role home, so three seats
never share conversation state. Skills and file-backed credentials are shared by reference.
The filename is `.credentials.json` (plural); on macOS Claude normally uses Keychain instead,
and keys that entry to the configured directory rather than sharing it across role homes.

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

**The room never replaces an agent's base prompt.** Codex's `model_instructions_file` and
Claude's `--system-prompt` both *replace* the vendor's system prompt; using them would mean
vendoring a full copy of that prompt and re-vendoring it on every agent release. The role
contract is additive instead: `developer_instructions` for Codex, `CLAUDE.md` for Claude.

Each seat is also pinned at the Paseo provider level, because a provider entry outranks the
agent's own configuration:

| Pin | Applies to | Why |
|---|---|---|
| `params: {sandbox_mode, approval_policy}` | Codex | Without it Paseo sends its own mode preset (default `auto-review`) to the Codex app-server, and that outranks the generated `config.toml`. |
| `disallowedTools` for `Task`, `Agent`, `Workflow`, coordination, task-list, cron and team tools | Claude | Blocks legacy/current subagents, dynamic workflows, cross-session coordination and agent teams. |
| `disableAgentView: true` + `CLAUDE_CODE_DISABLE_AGENT_VIEW=1` | Claude | Disables Claude's separate background-agent control plane across settings scopes and at launch. |
| `disableWorkflows: true` + `CLAUDE_CODE_DISABLE_WORKFLOWS=1` | Claude | Disables dynamic workflows through every entry point, beyond denying the `Workflow` tool. |
| `crossSessionInbound: "refuse"` | Claude | Prevents another Claude session from injecting a turn into a room seat. |
| `paseoTools: {enabled}` | both | Room tools for Supervisor and Lead, never for Peer. |

It also saves one **agent profile** per seat, which is what the Paseo picker lists under
Profiles. A profile is a preset, not a constraint: it decides where a seat *starts*.

| Profile field | Value | Owned by |
|---|---|---|
| `provider` | that seat's provider | the room — repaired on every `setup --apply` |
| `name` | e.g. `Codex Lead` | the room |
| `icon` | `eye` / `compass` / `code` for Supervisor / Lead / Peer | the room |
| `color` | `violet` / `blue` / `emerald` for Supervisor / Lead / Peer | the room |
| `modeId` | `full-access` for Codex, `bypassPermissions` for Claude | the room |
| `notes` | who may open this seat, shown to orchestrating agents by Paseo's `list_profiles` | the room |
| `thinkingOptionId` | `low` for Supervisor, `high` for Lead and Peer | seeded once, then yours |
| `model` | never written | yours |

Supervisor starts low because it routes rather than reasons. Neither seat starts on the top
option — Codex's `ultra` and Claude's `ultracode` advertise automatic task delegation, which
is a second control plane. `setup` restores room-owned identity, appearance and mode fields,
but leaves your model and reasoning choice alone; profiles you created yourself are never
touched.

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

Role homes are generated once, at `setup` time. After you edit `~/.codex/config.toml` or
`~/.claude/settings.json`, run `setup --apply` again to fold the change into every seat.
`verify` reports the drift in the meantime, and re-running `setup` is always safe: it
rewrites only what differs.

Changing which agents you seat also cleans up: `setup --agent codex --apply` after having
seated both removes the Claude role homes and their providers, and says so in the plan.

`remove --apply` deletes `~/.paseo-room` and the providers it registered. It refuses to run
if `--room-home` points at a directory containing your home directory, and it leaves
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
6. **When the room gets confusing, throw it away.** `remove --apply`, then `setup --apply`.
   Role homes are generated; do not debug them.

Using one Peer directly, with no Lead at all, is fine for small single-scope work — that is
not breaking the room, it is not using it. Just be clear that you are then the Lead: the brief
and the technical acceptance are yours.

With both Codex and Claude seated, the highest-value use of the second family is not splitting
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
