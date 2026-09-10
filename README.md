# paseo-room

One CLI that seats a **Supervisor → Lead → Peer** room on your local [Paseo](https://paseo.sh) daemon,
using the Codex and/or Claude Code you already have installed.

It does three things:

1. Reads your existing Codex / Claude Code configuration.
2. Writes one isolated role home per seat under `~/.paseo-room`, sharing your login, skills and plugins by symlink.
3. Registers those role homes with your running Paseo daemon as providers — room tools on for Supervisor and Lead, off for Peer.

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
  Log in to those tools yourself first; the room shares that login, it does not create one.

## What gets created

```text
~/.paseo-room/
  room.json                       # what this CLI created; verify and remove read it
  room/workspace-protocol.md      # operator reference for a repo's docs/WORKSPACE_PROTOCOL.md
  roles/codex/<role>/
    config.toml                   # your config.toml + the room's overrides
    role-instructions.md          # readable copy of what this seat was told
    model-catalog.json            # your catalog with native multi-agent metadata removed
    auth.json, AGENTS.md, skills, plugins, hooks.json   → symlinks into ~/.codex
  roles/claude/<role>/
    CLAUDE.md                     # role instructions, as user memory
    settings.json                 # your settings.json + PASEO_ROOM_ROLE
    .claude.json                  # seeded once from yours, then owned by Claude
    .credentials.json, skills, plugins, commands, hooks → symlinks into ~/.claude
```

Each seat keeps its own sessions, history and projects inside its role home, so three seats
never share conversation state — but they do share one login and one set of skills.

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
| `disallowedTools: ["Task"]` | Claude | Claude's own subagents would be a second control plane. This is the counterpart of Codex's `[agents].enabled = false`. |
| `paseoTools: {enabled}` | both | Room tools for Supervisor and Lead, never for Peer. |

The Claude permission mode is deliberately **not** set here. Paseo passes `--permission-mode`
per agent (`plan`, `default`, `acceptEdits`, `auto`, `bypassPermissions`; default `auto`), and
a command-line flag beats anything in `settings.json`. Choose the mode in Paseo.

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

- **Supervisor** routes Human directives to Lead and observes. It does not edit project work,
  run validation, or decide technical acceptance. Room tools: on.
- **Lead** owns framing, decomposition, routing, integration and technical acceptance. One
  moving write scope has exactly one owner, and at most one Peer is writable at a time.
  Room tools: on.
- **Peer** owns one bounded outcome, may challenge a failed premise with
  `REOPEN_REQUEST` / `DEPENDENCY_REQUEST` / `BLOCKED`, hands back a reproducible candidate,
  and never accepts its own difficult change. Room tools: off.

Human keeps product goals, priority, material cost, external effects and irreversible risk.

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
