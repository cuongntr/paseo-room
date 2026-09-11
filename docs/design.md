# Design notes

Why the room is built the way it is. Read this before changing an override, an
overlay key, or a provider field — most of them exist because of a specific failure,
and several of them are not obvious from the code alone.

## 1. The model this implements

The room seats three roles — Supervisor, Lead, Peer — under one Human owner, with the
authority boundaries, delegation contract and invariants described in
[orchestration-model.md](orchestration-model.md). Read that first; this file only covers
what the model costs to implement here.

Three of its invariants drive almost every decision below:

- **One control plane.** Paseo owns agent lifecycle, so every native multi-agent path in
  the agent runtime must be closed.
- **Role separation needs isolated runtime state.** Three seats need three configurations;
  authentication is shared only through mechanisms the runtime officially supports.
- **Capability discipline.** Orchestration tools go to the seats that orchestrate.

## 2. Closing the runtime's own multi-agent paths

If a seat can spawn its own agents there are two ledgers and no way to say which agent owns
a task, a workspace or a correction. Every native path is therefore closed, per agent:

| Agent | Mechanism |
|---|---|
| Codex | `[agents].enabled = false`, `features.multi_agent = false`, `features.multi_agent_v2 = false`, **and** a model catalog with `multi_agent_version` nulled |
| Claude | provider-level `disallowedTools` blocks legacy `Task`, current `Agent`, `Workflow`, cross-session, shared task-list, cron and team tools; environment pins close background Agent View and dynamic workflows; `crossSessionInbound: "refuse"` rejects messages from other Claude sessions; the operator's `agents/` and `workflows/` directories are *not* linked into a seat |

The catalog scrub is not redundant with the feature flags: bundled model metadata can still
advertise native collaboration v1 or v2 even when both flags are off. That was found the
hard way in the reference implementation, and the same order is kept here.

Room tools are the mirror image of the same rule: `paseoTools.enabled` is on for Supervisor
and Lead, off for Peer. `ROLE_PASEO_TOOLS` in `src/roles.ts` is the single source of that
policy, applied at exactly one call site.

## 3. Where the instruction layers live

`paseo-room` owns the model's first instruction layer outright: the role contract, in
`src/room/clauses.ts`, delivered as `developer_instructions` (Codex) and `CLAUDE.md`
(Claude).

It also ships a **default** for the second layer, in `src/room/workspace.ts`, appended to
every role document. The layer is therefore never simply absent: a repository that says
nothing still gets rules for topology, verification, review and conventions. A repository
that needs different ones writes `docs/WORKSPACE_PROTOCOL.md`, and RC-002 gives that file
precedence point by point — it wins wherever it speaks, the default holds wherever it is
silent. Whole-file replacement was considered and rejected: it would mean a repository
that states one rule loses every other rule, which is worse than the gap this default was
added to close.

Each seat gets the part of the protocol that bears on its own work. Topology goes to Lead
and Supervisor only, because RC-303 forbids Peer to infer room topology and a document
that both forbids and teaches it is incoherent.

`room/WORKSPACE_PROTOCOL.md` is that default written out as one file: not linked into any
seat, since the seats already carry the text, but readable by the operator and usable as a
starting point. It carries the name RC-002 uses so a copy needs no rename. Nothing is ever
written into `AGENTS.md`, and task briefs are Lead's job at dispatch time rather than this
tool's concern.

## 4. Why a separate home per seat

Codex reads one `config.toml`, from `CODEX_HOME`. Claude Code reads one config
directory, from `CLAUDE_CONFIG_DIR`. Giving three seats three different contracts means
giving them three different homes — there is no per-invocation flag that does it.

Each role home is generated content plus symlinks back to the resources you own. This avoids
copying skills and file-backed credentials, but cannot merge credential stores the runtime
itself namespaces per config directory:

- generated: `config.toml` / `settings.json`, the role contract, the model catalog
- linked where applicable: credentials, `AGENTS.md`, skills, plugins, hooks, commands,
  rules, output styles, keybindings and themes
- private per seat: sessions, history, projects — the runtime state each seat accumulates

`agents/` is pointedly absent from the Claude link list. Linking it would import your
subagent definitions into every seat and reopen §2. `workflows/` is absent for the same
reason. Claude's current built-in tool name is `Agent`, while older releases used `Task`;
both names stay denied. Current Claude also exposes `Workflow` for scripts that orchestrate
many subagents; cross-session and agent-team tools are denied too, including every shared
task-list and cron tool that teammates retain. Agent View and dynamic workflows also have
entry points beyond model tool calls, so the room pins the documented
`CLAUDE_CODE_DISABLE_AGENT_VIEW=1` and `CLAUDE_CODE_DISABLE_WORKFLOWS=1` environment controls
in both the provider launch environment and generated `settings.env`. The duplication is
intentional: Claude applies settings-file environment values after inherited launch values,
so an operator value of `0` would otherwise undo the provider pin. Generated settings also
force `disableAgentView: true` and `disableWorkflows: true`. Anthropic defines these disable
values as restrictive: another ordinary settings scope or paired enable value cannot turn
the feature back on. That closes the higher-precedence project/local-settings case too.
Bare-name deny entries remove tools from Claude's context and still apply under
`bypassPermissions`.

Cross-session messaging is bidirectional. Denying `ListAgents` and `SendMessage` stops a room
seat sending, but does not stop another Claude session delivering a message to it; in bypass
mode that message can start a turn without an approval prompt. Each generated `settings.json`
therefore overrides the operator's receiving policy with `crossSessionInbound: "refuse"`.
Together these pins close Claude's documented
[parallel-agent surfaces](https://code.claude.com/docs/en/agents) and
[cross-session inbound channel](https://code.claude.com/docs/en/cross-session-messaging).

Claude authentication has one platform-specific limit. The exact fallback filename is
`.credentials.json` (plural), and linking it shares file-backed login on Linux, Windows and
the macOS fallback path. Normal macOS login lives in Keychain, however, and Claude keys that
entry to `CLAUDE_CONFIG_DIR`; three role homes therefore mean three Keychain namespaces.
The room cannot copy or re-key a secret without violating its ownership boundary. Operators
must use inherited environment authentication or log in once per Claude seat on macOS. This
follows Anthropic's documented
[credential storage](https://code.claude.com/docs/en/authentication#credential-management), plus the
observed result of running `claude auth status` under an isolated config directory.

Claude's global `CLAUDE.md` is operator-authored configuration, so it is folded into each
generated role memory before the room contract. Top-level personal `mcpServers` from the
source `.claude.json` are seeded with stable UI state, while `oauthAccount` and project
history are excluded and subsequent role state remains private. The legacy default source is
`~/.claude.json`; when `--claude-home` / `CLAUDE_CONFIG_DIR` is set, the source is
`<CLAUDE_CONFIG_DIR>/.claude.json`.

## 5. Provider entries outrank agent configuration

This is the least obvious part, and getting it wrong makes the generated configs look
correct while having no effect.

When Paseo launches a Codex seat it applies the *agent mode* selected in the UI. Each
mode is a preset:

```js
"full-access": { approvalPolicy: "never", sandbox: "danger-full-access" }
```

and it is sent to the app-server **unless the provider entry already pins that key**:

```js
if (approvalPolicy && this.providerOptions.approval_policy === undefined) {
    params.approvalPolicy = approvalPolicy;
}
```

`providerOptions` is the provider entry's `params`. The default Codex mode is
`auto-review`, not `full-access` — so with no `params`, a seat runs under
`auto-review` and asks for approval, no matter what the generated `config.toml` says.
Hence:

```json
"params": { "sandbox_mode": "danger-full-access", "approval_policy": "never" }
```

Claude is different: its permission mode arrives as a command-line session setting
(`--permission-mode`, including `bypassPermissions`), and the Claude adapter does not read
`providerOptions` at all. A flag beats `settings.json`, so writing
`permissions.defaultMode` there would be dead configuration. The room profile owns
`modeId: "bypassPermissions"`; Codex uses the equivalent `full-access` profile mode in
addition to its provider pins.

`providerMatches` in `src/paseo.ts` compares these pins, so `verify` fails if one is
removed from the live config. A pin that can be silently dropped is not a guarantee.

### 5a. Agent profiles: the seat as one pick

A provider is a way to launch an agent; an **agent profile** is a saved preset in the
picker. They are different things in Paseo, in different parts of the config
(`providers` is a map, `agentProfiles` a top-level array), and a room made only of
providers leaves the Profiles screen empty.

The room writes one profile per seat. Two consequences follow from `agentProfiles`
being one array for the whole host rather than a keyed map:

- There is no remove-one call, so every write replaces the array. `mergeProfiles` reads
  the live array, passes operator profiles through untouched, overlays only the fields
  the room owns onto its own entries, and appends what is missing. An operator editing
  profiles in the UI at the same moment as `setup --apply` would lose that edit; the
  window is one round trip on a local socket, and setup is a deliberate act.
- Identity has to be exact. Room profile ids are `room-<agent>-<role>`, computed from
  the closed sets in `roles.ts`, so nothing is matched by prefix and a profile of the
  operator's cannot be mistaken for one of the room's.

`provider`, `name`, `notes`, `modeId`, `icon` and `color` are owned and repaired. The
appearance encodes role rather than runtime: eye/violet for Supervisor, compass/blue for
Lead, and code/emerald for Peer. These are stable keys from Paseo's profile registries; the
fields themselves are optional in Paseo's current
[`AgentProfileSchema`](https://github.com/getpaseo/paseo/blob/main/packages/protocol/src/messages.ts).
`thinkingOptionId` is **seeded on create and then left alone**, which is the same bargain as
Claude's `.claude.json`: the room wants a sensible starting point, not the last word on how
you tune a seat. `model` is deliberately never written — pinning it would mean carrying
model ids like `gpt-5.6-sol` in this repository and re-vendoring them as they age, the
same debt §6 refuses for base prompts.

The starting efforts (`low` for Supervisor, `high` for Lead and Peer) stop short of
`ultra` / `ultracode`. Paseo describes that top option as *maximum reasoning with
automatic task delegation* — a second control plane arriving through the model picker,
after §2 closed the three obvious doors. A profile cannot prevent someone choosing it
per session; it only decides where a seat starts. Whether `features.multi_agent = false`
also neuters that option is **unverified**.

`notes` is not decoration: Paseo surfaces it to orchestrating agents through
`list_profiles`, so it is where each seat says who may open it — the same rule §5b
states, arriving where an agent choosing a seat will actually read it.

### 5b. One project Lead: procedural enforcement

`create_agent_request.config.provider` is `z.ZodString` — a free-form id chosen by the
caller. Paseo has no way to say *this seat may only create those seats*. So with six
seats registered, a Codex Lead can name `codex-peer`, `claude-peer`, `codex-lead` or
`codex-supervisor`, and the last two are a second orchestrator and an inverted hierarchy
respectively.

The only lever below the contract is the one already used: Peer has
`paseoTools.enabled: false` and so cannot create anything at all. The middle of the
hierarchy is open, and there is nothing to close it with at the configuration layer.

There is likewise no project-scoped uniqueness constraint for Lead providers. Paseo's
agent-scoped create operation always creates a new child; putting that child in an existing
workspace does not reuse an agent or change its parentage. Lifecycle status is not identity:
an idle Lead has merely completed a turn, and a closed unarchived Lead remains resumable
under the same agent id. A pending creation or permission is unresolved state, not evidence
that the seat is absent.

RC-103 therefore gives Supervisor an explicit discovery-and-reuse procedure. Before create,
it inspects current and recent project agents; if an established Lead is initializing,
running, idle, waiting for permission, or closed but resumable, Supervisor routes to that
agent. It opens exactly one child Lead only when none owns the project. Fresh-session review
is routed to that Lead, which opens a fresh read-only Peer under RC-206; freshness never
creates a second Lead or gives Supervisor a channel to Peer.

Duplicate recovery is intentionally bounded rather than magical. Supervisor stops new
parallel routing, preserves both histories and artifacts, keeps the previously established
healthy owner, and closes a duplicate only after moving work stops and a stable handoff
exists. Ambiguous prior ownership, health, or concurrent writes are escalated to Human.
Supervisor never merges work, accepts a candidate, or directs Peer during recovery.

RC-207 still says Lead opens Peer seats only, and `ROLE_NOTES` surfaces the sole-Lead rule at
the `list_profiles` decision point. Focused tests assert the exact generated instructions.
This is stronger and less ambiguous guidance, but remains procedural rather than runtime
enforcement; a contradictory or non-compliant caller can still supply any provider id.

## 6. Add to a base prompt, never replace it

Both agents expose a replace-the-system-prompt knob: `model_instructions_file` for Codex,
`--system-prompt` for Claude. Both are traps for a tool like this one. Using them means
shipping a full copy of the vendor's system prompt — and re-shipping it on every agent
release, or silently degrading every seat when the vendor's prompt moves on.

The role contract is additive by nature, so it goes in the additive channel:
`developer_instructions` for Codex, `CLAUDE.md` (user memory) for Claude.

Pinning the base prompt for stability is a legitimate thing to want, but it is the
operator's decision about their own installation, not the room's. If you set
`model_instructions_file` yourself, the room copies it through untouched.

The Claude side is weaker than the Codex side, and it is worth knowing why:
`developer_instructions` is an instruction field, while `CLAUDE.md` is user memory that a
project-level `CLAUDE.md` can dilute. Paseo's `AgentSessionConfig.systemPrompt` would be
the strong equivalent, but it is set per agent at creation time and cannot be pinned from
a provider entry.

## 7. Deliberate non-goals

- **No transactional installer.** An earlier version had a journal, rollback, a versioned
  ownership manifest, lock files and inode-level identity guards — about 10k lines to
  protect a directory the tool creates itself. The room home is disposable: a half-finished
  `setup` is fixed by running `setup` again, and `remove` deletes the lot. That is the
  entire recovery story.
- **No installing or upgrading Paseo, Codex or Claude.** The room checks compatibility and
  explains a mismatch; it never repairs someone else's installation.
- **No launcher script.** The reference implementation wraps each seat in a shell script
  that regenerates the runtime on every launch. That buys automatic pickup of config
  changes, and costs a wrapper process whose stdout can corrupt the app-server's JSONL
  stream. Generating at `setup` time avoids the wrapper; the price is that changing your
  own config needs `setup --apply` again, which `verify` reports.
- **No per-seat model or skill routing.** Model tier belongs to task risk, and that is a
  Workspace Protocol and Lead decision, not a room decision. The room preserves whatever
  model and reasoning effort you configured.
- **No security sandbox.** The room delivers tool policy and role authority. A Peer with
  shell access is not contained by it.

## 8. Lineage

The model's own provenance is in [orchestration-model.md](orchestration-model.md) §11.
This tool reaches it by way of `codex-room-setup` — a bash + Python implementation that
generated the same runtime homes and required a patched Paseo build to limit MCP injection
per provider. The clause wording in `src/room/clauses.ts` descends from that
implementation's role overlays.

`paseo-room` differs in three ways worth stating:

1. It is an npm CLI with no launcher script and no patched daemon; per-provider room tools
   use Paseo's native `paseoTools` field.
2. It seats Claude Code as well as Codex, from one contract.
3. It generates once at `setup` instead of on every launch (see §7).

Where the written model and the reference implementation disagree, this tool follows the
implementation, because it is what actually ran. Three such disagreements are live:

- The document reserves `WORKSPACE_PROTOCOL.md` for Lead and keeps it away from Peer; all
  three reference overlays tell every seat to read it. The room follows the overlays.
- The document's sample profiles put Supervisor and Lead in `read-only` sandboxes; every
  real config uses full access, and the Supervisor profile explicitly says to keep seats in
  full-access mode rather than accept a recurring permission ceremony. The room follows the
  real configs.
- [orchestration-model.md](orchestration-model.md) §3 says the workspace protocol does not
  belong in the file every agent already reads, because that is a broadcast. The room ships
  a default in every role document anyway (§3 above). The alternative on offer was not a
  narrower protocol but no protocol: a repository with no `docs/WORKSPACE_PROTOCOL.md` had
  none of that layer at all. The broadcast is narrowed rather than accepted whole — each
  seat receives only the sections that bear on its own work — and Lead can still quote
  rather than broadcast from a repository's own file.
