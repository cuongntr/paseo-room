# Design notes

Why the room is built the way it is. Read this before changing an override, an
overlay key, or a provider field — most of them exist because of a specific failure,
and several of them are not obvious from the code alone.

## 1. The operating model

The room implements a three-seat model with one human owner:

```text
                    Human
                      │
         ┌────────────┴────────────┐
    Supervisor                 Project Lead
  governance / observation   project authority
         │                         │
         └──── observes ───────────┤
                                   │
                                Peer(s)
```

It is **not** a strict hierarchy. Lead is the binding technical arbiter inside its
project; Supervisor observes across projects and can route the Human's decisions, but
does not own technical acceptance. Human keeps product goals, priority, material cost,
external effects and irreversible risk.

Two consequences shape the whole tool:

- **Peer is one profile, not one job.** A Peer becomes Engineer, Architect, Reviewer or
  Scout through its task brief. That is why there are three seats and not six, and why
  the Peer contract is the thinnest of the three.
- **Naming matters.** The seat is called Lead, not Root. Control-plane vocabulary
  ("you are a subagent of root") produces compliant, bot-like behavior; engineering
  vocabulary ("you own this bounded outcome") produces an independent co-worker.

## 2. Three layers of instruction

| Layer | Lifetime | Holds | Owned by |
|---|---|---|---|
| Role contract | Durable, across repos | Identity, authority, invariants | this tool (`src/room/clauses.ts`) |
| `docs/WORKSPACE_PROTOCOL.md` | Durable, one repo | Topology, model policy, review rhythm, escalation | the repository |
| Task brief | One assignment | Objective, scope, exclusions, verification, handoff | Lead, at dispatch time |

Mixing them is the failure this separation prevents: a Peer that has to spend attention
deciding which rules apply to its task is a Peer that follows none of them well.

`paseo-room` owns only the first layer. It ships `room/workspace-protocol.md` as an
operator **reference** — it is never linked into a seat, because each repository provides
its own. Nothing is ever written into `AGENTS.md`.

## 3. One control plane

Paseo owns agent identity, lifecycle, parentage, workspace placement and the timeline.
If a seat can also spawn its own agents, there are two ledgers and no way to know which
agent owns a task, a workspace, or a correction. Review and cleanup stop being trustworthy.

Every native multi-agent path is therefore closed, per agent:

| Agent | Mechanism |
|---|---|
| Codex | `[agents].enabled = false`, `features.multi_agent = false`, `features.multi_agent_v2 = false`, **and** a model catalog with `multi_agent_version` nulled |
| Claude | provider-level `disallowedTools: ["Task"]`, and the operator's `agents/` directory is *not* linked into a seat |

The catalog scrub is not redundant with the feature flags: bundled model metadata can
still advertise native collaboration v1 or v2 even when both flags are off. That was
found the hard way in the reference implementation, and the same order is kept here.

Room tools are the mirror image of the same rule: `paseoTools.enabled` is on for
Supervisor and Lead, off for Peer. A Peer with orchestration tools drifts into
coordinating, which is Lead's job. `ROLE_PASEO_TOOLS` in `src/roles.ts` is the single
source of that policy, applied at exactly one call site.

## 4. Why a separate home per seat

Codex reads one `config.toml`, from `CODEX_HOME`. Claude Code reads one config
directory, from `CLAUDE_CONFIG_DIR`. Giving three seats three different contracts means
giving them three different homes — there is no per-invocation flag that does it.

But three homes must not mean three logins or three copies of your skills. So each role
home is generated content plus symlinks back to the resources you own:

- generated: `config.toml` / `settings.json`, the role contract, the model catalog
- linked: credentials, `AGENTS.md`, skills, plugins, hooks, commands
- private per seat: sessions, history, projects — the runtime state each seat accumulates

`agents/` is pointedly absent from the Claude link list. Linking it would import your
subagent definitions into every seat and reopen §3.

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

Claude is different: its permission mode arrives as a command-line flag
(`--permission-mode`, one of `plan`, `default`, `acceptEdits`, `auto`,
`bypassPermissions`, default `auto`), and the Claude adapter does not read
`providerOptions` at all. A flag beats `settings.json`, so writing
`permissions.defaultMode` there would be dead configuration. The room does not set it;
the operator picks the mode in Paseo.

`providerMatches` in `src/paseo.ts` compares these pins, so `verify` fails if one is
removed from the live config. A pin that can be silently dropped is not a guarantee.

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

The design comes from Demonthorn's agent-orchestration model, by way of
`codex-room-setup` — a bash + Python implementation that generated the same runtime homes
and required a patched Paseo build to limit MCP injection per provider. The clause wording
in `src/room/clauses.ts` descends from that implementation's role overlays.

`paseo-room` differs in three ways worth stating:

1. It is an npm CLI with no launcher script and no patched daemon; per-provider room tools
   use Paseo's native `paseoTools` field.
2. It seats Claude Code as well as Codex, from one contract.
3. It generates once at `setup` instead of on every launch (see §7).

Where the deep-dive document and the reference implementation disagree, the implementation
wins, because it is what actually ran. Two such disagreements are live:

- The document reserves `WORKSPACE_PROTOCOL.md` for Lead and keeps it away from Peer; all
  three reference overlays tell every seat to read it. The room follows the overlays.
- The document's sample profiles put Supervisor and Lead in `read-only` sandboxes; every
  real config uses full access, and the Supervisor profile explicitly says to keep seats in
  full-access mode rather than accept a recurring permission ceremony. The room follows the
  real configs.
