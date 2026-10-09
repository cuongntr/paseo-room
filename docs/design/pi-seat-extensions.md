# Pi Seats — Operator-Selected Extensions and the Seat Role Variable

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | Owner decision 2026-10-07 (in session: let setup keep chosen Pi plugins per role; keep role-owned Pi auth; keep `pi-mcp-adapter`; warn, never install) |
| Related ADRs | N/A — no ADR directory exists. Governing: [design.md](../design.md) §4 (role homes), §5 (Pi provider argv, adapter, probe) |
| Routing decision | See below |

## Routing Decision
- Variant preset: brownfield
- Triggered risks: changed provider argv and environment (a provider pin); new executable code in seats; new setup flag and marker field
- Required artifacts/gates: this delta → implementation → `npm run verify`
- Execution path: implement directly; one adapter, one flag, one marker field, one probe change
- Exceptions: none
- Approved: 2026-10-07 — Repository owner

## 1. Problem

A Pi role's `settings.json` drops the operator's `packages` and `extensions`, and the provider
launches with `--no-extensions` plus exactly one `--extension`, the MCP adapter. That keeps a
seat from installing packages into its home or loading an extension nobody chose, but it also
removes extensions a seat needs to be useful: a provider package (without `pi-provider-kiro` a
seat cannot use a Kiro model at all) or a tool package such as `pi-blackbytes`.

Two rejected alternatives, recorded so they are not re-proposed:

- **Keep the operator's `packages` in role settings.** Pi resolves `npm:` packages against the
  agent directory, so a seat would install them into its role home on start. Rejected for the
  same reason as before.
- **Link role `auth.json` to the operator's.** Checked on Pi 1.0.4: Pi locks `<auth path>.lock`
  with `realpath: false`, so a linked file is locked at a different path by each process, and
  OAuth refresh tokens rotate. Two processes refreshing together can invalidate the operator's
  own login. Role auth stays role-owned (design.md §4); this delta does not touch it.

## 2. Decisions

**PX-D1 — Selection is an explicit setup choice.** `setup --pi-extension <package>[=<roles>]`,
repeatable. `<package>` is an npm package name (scoped names allowed). `<roles>` is a
comma-separated subset of `supervisor,lead,peer`; omitted, it means `supervisor,lead`. Peer
receives an extension only when named, because an extension is executable code and Peer's
resource set is deliberately narrower (design.md §2b). `pi-mcp-adapter` cannot be selected: it
is already loaded. The choice is recorded in `room.json` as `piExtensions`, so `verify` compares
against it, and like `--no-claude-memory-contract` it is a per-run choice: a later `setup`
without the flag removes the extensions and says so with a warning naming what was removed.

**PX-D2 — Loaded from the operator's install, never installed.** Each package resolves only
from `<pi home>/npm/node_modules/<package>`, the same place and the same containment rules as
the adapter: the manifest name must match, every `pi.extensions` entry must be relative, resolve
inside the canonical package root and be a regular file. Each entry becomes one more
`--extension <canonical entry>` after the adapter in that role's argv. Package `prompts`,
`skills` and `themes` are not loaded. Role settings still drop `packages` and `extensions`.

**PX-D3 — Missing is a warning; unsafe is a failure.** A selected package that is not installed
gives a warning with the exact `pi install npm:<package>` command, and the seat is generated
without it; the selection stays recorded, so `verify` keeps warning until it is installed or
deselected. A package that exists but is malformed, misnamed or declares an entry outside its
root fails setup, as the adapter does. The room never installs or upgrades a Pi package.

**PX-D4 — Every Pi seat knows its role.** Every Pi provider pins `PASEO_ROOM_ROLE=<role>` in its
environment, whether or not anything is selected. It is a provider pin, compared whole by
`providerMatches`. An extension may use it to switch off
behaviour that does not belong in a seat; `pi-blackbytes` 3.1.0 does (any non-empty value
disables its sub-agents, leaves the system prompt untouched and keeps its files in the role
home).

**PX-D5 — Paseo stays the only control plane, and the Human attests it.** The room cannot prove
that an extension opens no second multi-agent path. Selecting one is the Human's statement that
it does not, or that it closes that path under `PASEO_ROOM_ROLE`. Setup shows every loaded
package per role as a pass line, and adds a warning for each package given to Peer.

**PX-D6 — The probe loads what the seats load.** The offline capability probe passes the union
of selected entries after the adapter, sets `PASEO_ROOM_ROLE=lead`, and points
`PI_CODING_AGENT_DIR` at an empty directory inside its own temporary directory instead of
`/dev/null`, because an extension may write its log under the agent directory. `HOME` is still
that temporary directory, which is removed afterwards. The probe still passes only on exactly one
`/mcp` from the adapter entry; a selected extension that breaks Pi's start therefore fails setup.

## 3. Amendment 2026-10-09 — Pi's built-in MCP replaces the adapter

Owner decision 2026-10-09, after Pi 1.1.0 and Paseo 0.11.1. Paseo 0.11.1 registers a Pi seat's
servers with `pi.registerMcpServer` when `/mcp` comes from `builtin:mcp`, so the adapter is no
longer needed ([design.md](../design.md) §5 has the mechanism and the offline check). It
changes three decisions:

- PX-D1: `pi-mcp-adapter` still cannot be selected, now because Paseo would switch to it.
- PX-D2: selected entries follow `--extension builtin:mcp --extension builtin:codemode` instead
  of the adapter; codemode loads because registered tools default to `codemode` exposure.
- PX-D6: the probe loads the same built-ins and passes only on exactly one `/mcp` from
  `builtin:mcp`. It no longer sets `PI_MCP_CONFIG_MODE`, which the providers no longer pin.

Any selection containing Pi now requires Paseo `>=0.11.1`.

## 4. Not changed

Role auth (§3 amends the adapter requirement and the probe criterion), Peer's `ROLE_PASEO_TOOLS`, the
Claude and Codex adapters, and the rule that the room never writes an operator home.
