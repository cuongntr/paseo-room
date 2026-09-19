# Design notes

Why the room is built the way it is. Read this before changing an override, an
overlay key, or a provider field — most of them exist because of a specific failure,
and several of them are not obvious from the code alone.

## 1. The model this implements

The room seats three roles — Supervisor, Lead, Peer — under one Human owner, with the
authority boundaries, delegation contract and invariants described in
[demonthorn-agent-orchestration-deep-dive.md](demonthorn-agent-orchestration-deep-dive.md).
Read that first; this file only covers what the model costs to implement here.

Three of its invariants drive almost every decision below:

- **One control plane.** Paseo owns agent lifecycle, so every native multi-agent path in
  the agent runtime must be closed.
- **Role separation needs isolated runtime state.** Three seats need three configurations and
  three ownership boundaries for runtime-mutable credentials.
- **Capability discipline.** Orchestration tools go to the seats that orchestrate.

## 2. Closing the runtime's own multi-agent paths

If a seat can spawn its own agents there are two ledgers and no way to say which agent owns
a task, a workspace or a correction. Every native path is therefore closed, per agent:

| Agent | Mechanism |
|---|---|
| Codex | `[agents].enabled = false`, `features.multi_agent = false`, `features.multi_agent_v2 = false` — in the top-level table **and** in an active profile, which outranks it — **and** a generated model catalog with `multi_agent_version` nulled |
| Claude | provider-level `disallowedTools` blocks legacy `Task`, current `Agent`, `Workflow`, cross-session, shared task-list, cron and team tools; environment pins close background Agent View and dynamic workflows; `crossSessionInbound: "refuse"` rejects messages from other Claude sessions; the operator's `agents/` and `workflows/` directories are *not* linked into a seat |
| Pi | `--no-extensions` disables extension discovery, `--extension` loads only the canonical operator-installed MCP adapter in addition to Paseo's own temporary integration extension, and `--no-approve` suppresses project-local executable resources; the appended runtime capsule forbids spawning or managing agents through Pi, shell or extensions |

The catalog scrub is not redundant with the feature flags: bundled model metadata can still
advertise native collaboration v1 or v2 even when both flags are off. That was found the
hard way in the reference implementation, and the same order is kept here.

Because that scrub is a closure layer rather than a nicety, Codex **fails closed** on it. If
`codex debug models` cannot run, does not print JSON, or prints JSON that is not a catalog
object, no Codex plan is produced at all; the failure quotes the exact
`CODEX_HOME=<home> codex debug models` command it ran. The earlier behaviour — warn and let
the seats keep Codex's built-in catalog — silently dropped one of three closures, which is
the opposite of what a check is for. The consequence is deliberate: a Codex too old to print
the JSON catalog cannot be seated. What the room writes into each role home is a *generated
copy* of the catalog captured at that setup, and it replaces Codex's built-in catalog for
that seat. A new Codex release that ships new models therefore does not reach a seat until
`setup --apply` recaptures it, and `verify` names a drifted `model-catalog.json`
specifically, because that seat is missing the closure rather than only older contract text.

Room tools are the mirror image of the same rule: `paseoTools.enabled` is on for Supervisor
and Lead, off for Peer. `ROLE_PASEO_TOOLS` in `src/roles.ts` is the single source of that
policy, applied at exactly one call site.

### 2a. Three kinds of guarantee, not one

The room's controls are not equally strong, and reading them as one class is how a reader
ends up believing the room contains a seat. They are:

**Enforced pins.** Generated configuration keys, provider `params`, `env`, `disallowedTools`
and `paseoTools`. Each one is part of the desired state that `setup` writes and `verify`
recomputes: `planEntries` compares the files and `providerMatches` compares the provider
entry field by field, including the whole `env` map, so an added or removed key is drift and
`verify` fails. These are the room's actual guarantees, and they are only guarantees because
their removal is detectable.

**A bounded heuristic guardrail.** Paseo is the room's only control plane, so an MCP server
the seats can see that reaches Paseo would be a second one. Setup and verify therefore read
the MCP declarations in your Codex `config.toml`, your Claude state, an already-seeded role
`.claude.json`, and Pi's `mcp.json`, and fail *before* anything is applied if a declaration
is recognizably Paseo-related. Recognition is one rule — the token `paseo` at an identifier
or path boundary, in the server name, `command`, `args`, or a URL field — and the diagnostic
quotes which field matched, because a heuristic that cannot show its evidence cannot be
argued with. It is not a scanner: an obfuscated or renamed endpoint passes, so a clean result
proves nothing. The room never deletes, filters or rewrites your MCP configuration; the fix
names your file and leaves the decision with you.

**Capability hygiene.** What §2b withholds from Peer. This closes known configuration paths
by which a seat is handed an orchestration surface. It is not containment, and it is not
related to sandboxing: Peer keeps a shell.

### 2b. Role resource projection and Peer capability hygiene

Supervisor keeps exactly the operator resources it always received, one symlink each. Lead keeps
those too, except its `skills` symlink now points to a room-owned projection so the onboarding
skill (§3) can join the operator's own skills without writing anything into the operator home.
Peer is narrowed twice.

Resources whose contents *execute* are not shared with Peer at all: Codex `plugins` and
`hooks.json`, Claude `plugins`, `commands` and `hooks`, and Pi `prompts` (Pi's slash
commands). A plugin does not only add a command — it can contribute subagents, MCP servers
and hooks — and whether every plugin-contributed subagent path is stopped by Claude's
`disallowedTools` is unproven. The resource is withheld rather than the question answered,
because Peer has no room tools and no use for any of it.

`skills` is the one resource projected child by child instead of aliased, for two different
reasons. For **Peer**, the projection is a filter: its children are symlinks to each operator
skill whose name does not start with `paseo`, case-insensitively. Those are orchestration
skills; advertising them to the one seat that has no room tools would only teach it to try. For
**Lead**, the projection is an addition: every operator skill is linked into an exact room-owned
aggregate, plus one link to the `paseo-project-onboarding` source under
`~/.paseo-room/room/skills/`. The role home's `skills` path aliases that aggregate. An alias to
the operator directory could not carry the extra child without writing into the operator's own
home, which the room never does.

The single exception in Lead's projection is an exact name collision: an operator skill also
called `paseo-project-onboarding` is not linked, because the room-owned copy owns that name
inside the aggregate. The operator's own skill is untouched where it lives.

Exactness is the point of making each projection directory a path the room owns by name — adding
or deleting an operator skill is drift `verify` reports and `setup --apply` reconciles, instead
of a projection that quietly ages. Peer's role-home projection declares the one legacy shape it
may migrate from: the whole-directory symlink an earlier version wrote. Lead instead retains
that symlink shape and only retargets it to the aggregate. This lets a prior package retarget the
same path back to the operator directory during rollback. §4a covers what directory ownership
permits on disk, which is deliberately very little.

One class of name inside that directory is reserved rather than projected: a name the agent's
own runtime writes there. Claude downloads its skill bucket into `skills/synced` of whichever
home it runs with, so in every projected directory, Lead's as well as Peer's, the room both
skips it when projecting — a link would alias the role's state onto the operator's — and
excludes it from reconciliation, because an exactly owned
directory would otherwise see the agent's own state as a stale child. The room refuses to
delete a child directory it did not generate, so before this was reserved a seat that had run
Claude once made every later `setup --apply` fail on that path.

None of this filters or rewrites your configuration. Skills you keep are linked, `paseo*`
skills stay in your own home untouched, and a withheld resource is simply absent from one
role home.

## 3. Where the instruction layers live

`paseo-room` owns the model's first instruction layer outright: the role contract, in the
canonical Markdown under `src/room/prompts/contract/`, delivered as
`developer_instructions` (Codex), a creation-time `config.systemPrompt` append plus a
`CLAUDE.md` degraded fallback (Claude), and additive `APPEND_SYSTEM.md` content (Pi). Document heads and Pi-specific capsules live alongside it under
`src/room/prompts/`; `src/room/prompts.ts` is the typed registry and loader rather than a
second prose source.

Those files are cut by **independent distribution**, not one file per heading. A layer that
always reaches the same set of seats is one file, so a review unit is one diff:
`contract/shared-authority.md` for every role, `contract/shared-seat-identity.md` for the two
seat-opening seats, `contract/challenge-signals.md` for the two seats that use the vocabulary,
and one body per role. The earlier per-heading tree made the composition a long key list in
TypeScript and made a role document impossible to read as a document; a role body may now hold
several H2 sections, and the loader validates that shape.

It ships **no default** for the second layer. Repository workflow policy is a repository's own
optional root `WORKSPACE_PROTOCOL.md`, and when it exists it is that repository's complete
policy: Lead's **Workspace Protocol** section says so explicitly, so there is no second hidden
document to reconcile against point by point. The earlier design did ship such a default and
merged it point by point with a repository's file. That was removed because the always-on
document cost every Lead turn a long generic protocol the repository had never asked for, and
the merge rule made the effective policy impossible to read from either file alone. The path is
the repository root rather than `docs/` because the file is agent guidance, not project
documentation.

What replaces it is deliberately small and visible. Lead's contract keeps an **assignment
vocabulary and operating baseline** that applies in every repository: compact Engineer/Architect/
Reviewer/Scout meanings, because every brief must name one; the exact profile model and thinking
defaults unless a repository protocol explicitly routes them; naming and running the repository's
own verification gate, since an unrun gate cannot support acceptance; and a fresh read-only review
when Human or a repository protocol requires one, or when Lead identifies material technical
risk. A protocol may add routing, review, or verification requirements where the contract permits,
but its silence does not erase the baseline. No generic topology matrix, anti-pattern catalog,
repository convention list, or protocol-evolution policy survives in any prompt.

Reading the file reaches **Lead alone**, which is what
[demonthorn-agent-orchestration-deep-dive.md](demonthorn-agent-orchestration-deep-dive.md) §6.2
asks for: Lead is the standing reader and reads the repository file in full before
orchestration. Supervisor's **Workspace Protocol Mandate** reads a repository's file only under
an explicit Human audit, update or maintenance mandate, and lets it propose a change with causal
evidence rather than impose one. Peer receives no workspace
document and is never told the filename — **Complete Peer Brief** carries the quoting
obligation, including naming the exact verification command, and Peer's own contract keeps what
it needs unconditionally: the shared **Authority Floor** states that repository and workspace
instructions cannot enlarge or weaken contract authority and routes a conflict to Lead,
**Bounded Outcome** keeps house style in scope and no unrequested top-level file, dependency or
tooling, and **Reproducible Handoff** keeps faithful reporting and the bar that an unrun gate is
not a candidate. The floor is worded without the filename so Peer never learns a path it has no
use for. Withholding topology in particular is also a coherence requirement, since **No
Orchestration** forbids Peer to infer room topology and a document that both forbids and teaches
it is incoherent.

Writing a protocol is a procedure, not a prompt layer, so it ships as one room-owned **Agent
Skill**: `src/room/skills/paseo-project-onboarding/`, composed by `src/room/skills.ts` into
`~/.paseo-room/room/skills/` and linked into Lead's room-owned skill aggregate (§2b) and nowhere
else. Supervisor holds no standing protocol mandate and Peer reads one brief, so neither
receives it. The skill resolves the repository root, reads the repository's own evidence, and
returns an evidence map, a standalone complete draft, and the decisions Human still owns —
separating observed fact from proposal rather than filling gaps. It writes nothing by default,
and writes the root `WORKSPACE_PROTOCOL.md` only under an explicit Human apply instruction,
refusing a non-regular shape at that path. Its bundled template is a scaffold loaded while the
skill runs; it is never a runtime default appended to a session, which is the whole distinction
the removed default failed to keep.

The skill source is managed by exact file and directory shape rather than a recursive copy, so a
stray file in the package cannot become a managed path, and it is declared once from
`commands.ts` rather than per adapter, so three seated agents do not claim the same paths three
times. The loader validates the Agent Skill name, non-empty description, scaffold heading and
text integrity. A missing, unreadable or malformed asset raises the same actionable reinstall
failure as a missing prompt asset, reported as `<command>.skill-asset` rather than as a
filesystem or daemon error.

Skill files are live managed entries, not part of the contract digest: the digest covers the
three rendered role documents only, so a skill update does not falsely claim that an
already-running seat holds different startup instructions. `verify` compares the skill bytes
directly instead.

The old generated `~/.paseo-room/room/WORKSPACE_PROTOCOL.md` is declared **absent**, so an
upgrade removes it — and only when it is the regular file the room formerly wrote. Anything else
at that path is refused rather than deleted (§4a). Nothing is ever written into a repository,
`AGENTS.md` included, and task briefs are Lead's job at dispatch time rather than this tool's
concern.

## 4. Why a separate home per seat

Codex reads one `config.toml`, from `CODEX_HOME`. Claude Code reads one config
directory, from `CLAUDE_CONFIG_DIR`. Pi reads one agent directory from
`PI_CODING_AGENT_DIR`. Giving three seats three different contracts means
giving them three different homes — there is no per-invocation flag that does it.

Each role home is generated content plus symlinks back to read-only resources you own.
Runtime-mutable credential stores are not copied or linked:

- generated: `config.toml` / `settings.json`, the role contract or additive prompt, the model catalog
- linked where applicable: `AGENTS.md`, skills, plugins, hooks, commands,
  rules, output styles, keybindings and themes — minus what §2b withholds from Peer; both
  Lead's and Peer's `skills` are room-owned projections rather than one link
- private per seat: credentials, sessions, history, projects — the runtime state each seat accumulates

Credentials are a separate diagnostic plan, never an `Entry`. That distinction is load-bearing:
generic managed-entry apply repairs files and links only after confirming the existing path has
the expected shape, while a credential path is preserve-only under every setup/update state.
`lstat` classifies the path and `readlink` records a legacy link target; no credential content
is opened, hashed, parsed, copied or followed. Environment alternatives are detected from names/presence booleans only.
Keyrings and providers are never queried, and setup never runs login or network token
validation.

`AUTHENTICATION.md` is different from a credential path: it is a managed, secret-free guide
at the room root. Setup renders it from the binaries it already resolved and the deterministic
role homes it is about to manage, so custom binary and room-home paths are exact and
POSIX-shell quoted without storing them in `room.json`. Dry-run previews the guide through the
ordinary entry diff, and only `setup --apply` writes or regenerates it. Setup and verify point
to the guide while stating that authentication was not validated.

Interactive login is deliberately a separate command,
`paseo-room auth login <agent> <role>`. It reads only the room marker and path metadata needed
to prove that the selected role home is a real installed directory, resolves the current
per-agent binary override or `PATH` entry, and spawns the vendor CLI with an argv array,
`shell: false`, and inherited stdin/stdout/stderr. It neither invokes setup nor accepts
`--apply`; there is no all-roles or status operation. A vendor exit code passes through, while
a terminating signal maps to the conventional `128 + signal number` process status.

The migration policy is warn-only. A missing path is `login-required` unless a safely
recognizable static/environment method exists. A regular credential file is
`configured structurally (diverged-file-preserve)`: it may be runtime-owned divergence, so
the diagnostic explicitly does not claim validity or freshness. Any symlink, including one
whose target is now missing, is `legacy-shared-risk` and gets exact manual unlink and role-login
commands; only the stored link text is read, and its target is never probed. Setup does not
perform the recovery. Directories and other unexpected types are
`diverged-file-preserve/manual-recovery`. An explicit native keyring/automatic store is
`native-keyring unverifiable`. These warnings never mask structural/provider failures and do
not change the command exit status by themselves.

Codex reads `cli_auth_credentials_store` from the generated role config when it is explicitly
`file`, `ephemeral`, `auto`, or `keyring`. File presence is structural only; `auto` and
`keyring` remain unverifiable because the room does not query the native store, and
`ephemeral` has no persistent artifact to prove. An `OPENAI_API_KEY` name in the setup
process is not treated as configured role auth: Codex's built-in API-key flow stores it through
`codex login --with-api-key`, and the room does not copy it into Paseo's provider. The
generated guide uses `CODEX_HOME=<role-home> codex login`. Setup and verify never run it; the
explicit `auth login` command runs the same argv only for the one role the operator names.

Deselection during setup also retains old role homes. Recursively deleting one could erase a
role-owned credential created after planning, so setup removes only stale providers/profiles.
Whole-room deletion remains available solely through explicit `remove --apply`.

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

Claude's file-backed credential path is `.credentials.json` (plural) on Linux/Windows and as
a macOS fallback. Normal macOS login lives in Keychain. Current Claude runtimes expose a
separate secure-storage location override, so each generated settings file and provider pins
`CLAUDE_SECURESTORAGE_CONFIG_DIR` to the same role home as `CLAUDE_CONFIG_DIR`, overriding
operator and daemon ambient values. Because that override is not yet in Anthropic's stable
documentation, diagnostics still classify Keychain state as unverifiable rather than claiming
isolation or compatibility with older runtimes. The room does not query, copy or re-key those
secrets. It recognizes only safely inferable auth method names:
the documented cloud-provider selectors, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`CLAUDE_CODE_OAUTH_TOKEN`, and `apiKeyHelper`. Operators use one of those methods or run
`CLAUDE_CONFIG_DIR=<role-home> CLAUDE_SECURESTORAGE_CONFIG_DIR=<role-home> claude auth login`
per role, directly from the guide or through `paseo-room auth login claude <role>`.
Authentication status and token validity are never probed automatically.
This follows Anthropic's documented
[credential storage](https://code.claude.com/docs/en/authentication#credential-management), plus the
observed result of running `claude auth status` under an isolated config directory.

Claude's global `CLAUDE.md` is operator-authored configuration, so it is folded into each
generated role memory before the room contract. Top-level personal `mcpServers` from the
source `.claude.json` are seeded with stable UI state, while `oauthAccount` and project
history are excluded and subsequent role state remains private. The legacy default source is
`~/.claude.json`; when `--claude-home` / `CLAUDE_CONFIG_DIR` is set, the source is
`<CLAUDE_CONFIG_DIR>/.claude.json`.

That file is written **once** and owned by Claude afterwards, which has a consequence worth
stating plainly: MCP servers you add to your own Claude later never reach an existing role
home. Setup and verify report that divergence as a warning rather than repairing it. Only the
declared server *names* are compared — no command, URL, argument, credential or history value
is read — and the fix offers the two real options with their cost: add the server to the role
with `CLAUDE_CONFIG_DIR=<role-home> claude mcp add …`, or delete the role's `.claude.json`
and let the next `setup --apply` reseed it from current state, which discards that role's
other accumulated runtime state. Rewriting the file for you would make that second choice
silently and unavoidably, so the room does not. The Paseo-conflict check of §2a runs first and
fails; advice never precedes a hard failure.

Environment names seen only by the setup process are reported as ambient and unverifiable,
because the room neither copies their values into provider configuration nor proves that the
Paseo daemon inherited them. Login guidance uses the resolved executable, including an
operator-supplied binary override.

Before reading role credential metadata or planning managed writes, setup and verify use
`lstat` on each existing room-relative directory ancestor. A symlink or non-directory at the
room root, shared directory, roles directory, agent directory, or role home fails structural
safety without traversing it. This prevents a pre-existing alias from redirecting generated
configuration or a role credential pathname outside the room.

Pi's role `settings.json` keeps operator preferences but removes top-level `packages` and
`extensions`. A role must not auto-install packages into its generated home or discover an
unrelated extension configured by the operator. The `npm`, `git`, `extensions` and
`trust.json` paths are never linked. Safe file-backed configuration and read-only resources
are linked when present: `models.json`, `AGENTS.md`, skills, prompts, themes, keybindings and
the Pi-specific `mcp.json`; `auth.json` is role-owned and preserve-only. Pi recognizes a
bounded list of built-in provider API-key environment names by presence only, otherwise
reports that ambient auth may exist but is not validated. Interactive authentication is a
minimal Pi login session that starts in the role home instead of inheriting the caller repository:
`PI_CODING_AGENT_DIR=<role-home> pi --no-extensions --no-approve
--append-system-prompt ''` session followed by `/login`. Pi treats the explicit empty append
source as present and resolves it to no content, suppressing fallback discovery of the role
home's generated `APPEND_SYSTEM.md`, including its runtime capsule and role instructions.
That direct launch neither resolves nor probes the adapter and cannot load the adapter or
Paseo's generated integration extension; it is visibly described as non-room-equivalent. Pi providers pin
`PI_MCP_CONFIG_MODE=exclusive`, so the adapter
uses that role-home `mcp.json` as its single config source instead of independently discovering
generic global or project MCP configuration. Sessions, stores and caches remain private to
each role.

The Pi role's `APPEND_SYSTEM.md` is generated in a deliberate order: operator global append,
small communication-style capsule, Pi runtime capsule, then the
role contract. Passing this file through `--append-system-prompt` suppresses Pi's normal
global append discovery rather than duplicating it. `--no-approve` does not disable normal
project `AGENTS.md` / `CLAUDE.md` context loading, so repository instructions still arrive.
No room-owned `SYSTEM.md` is created or copied.

### 4a. What a managed write is allowed to replace

There is still no transaction machinery (§7), but a single write is now type-safe and atomic,
which is a different and much smaller claim.

Every managed write first classifies the existing path with `lstat` and refuses a shape it
does not own: a managed regular file may replace only an absent path or a regular file, and a
managed symlink only an absent path or a symlink. The earlier code removed the old path
recursively first, which would have deleted a directory — possibly one holding role-owned
credentials — that happened to sit at a managed name. A refusal names the path and the shape
found, and tells the operator to move it aside; nothing is deleted on their behalf.

The replacement itself is built at a unique sibling temporary path and `rename`d into place,
so a seat reading a role document never sees a half-written file, and a failure leaves the
previous content intact and removes the temporary sibling.

Exact directory ownership — the primitive behind Peer `skills` — is declared per entry and
never inferred, so it can never apply to a role home or a credential-bearing path. Within a
declared directory the room removes only *undeclared children that are links or files*. A
stale child that is a real directory fails instead of being removed recursively. Migration is
equally narrow: an existing room has `roles/<agent>/peer/skills` as one whole-directory
symlink, and the first upgraded setup accepts exactly that one shape — a symlink whose target
is the operator skills directory it was going to link anyway — unlinks the alias alone, and
rebuilds the projection. A symlink pointing anywhere else, or an unrecognized real directory
at that path, fails and asks the operator to move it. The operator's skills are never
recursively traversed, copied or deleted, including when the migrated link's target no longer exists.

A declared entry may also reserve child names it neither writes nor reconciles, for state the
agent's own runtime owns inside a projected directory (§2, Claude `skills/synced`). Reserving a
name is narrower than owning it: the room will not create it, will not replace it, and will not
count it stale.

Recovery is unchanged: run `setup` again.

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

Pi has no selectable Paseo mode and no sandbox/approval mechanism to pin. Its profile omits
`modeId`, and profile repair removes a stale owned mode value while preserving model and
thinking choices. It extends Paseo's core `pi` provider, never OMP. The provider instead owns
a role-specific argv tail:

```text
--no-extensions --extension <canonical adapter entry> --no-approve
--append-system-prompt <role APPEND_SYSTEM.md>
```

Paseo itself appends a generated temporary integration extension. The room neither resolves
nor creates that file and includes only one explicit `--extension`: `pi-mcp-adapter` from the
operator Pi home's fixed global npm location. Before any plan can proceed, the adapter checks
the manifest name, resolves its single `pi.extensions` entry, canonicalises package root and
entry, and requires the entry to be a regular file contained by that root. Adapter version is
reported only as a diagnostic: peer ranges, exact versions, digests, compatibility matrices
and allowlists are deliberately not policy.

The provider also pins `PI_MCP_CONFIG_MODE=exclusive`. This is separate from Pi's
`--no-extensions`: the adapter has its own eager config discovery and can otherwise load
generic home or project MCP servers while the explicit extension is starting. Exclusive mode
leaves the role-specific `PI_CODING_AGENT_DIR/mcp.json` available and excludes those other
sources.

Path evidence alone does not prove Pi loaded the capability. A shell-free child process runs
offline with `PI_CODING_AGENT_DIR=/dev/null`, `PI_MCP_CONFIG_MODE=exclusive`, `--mode rpc`,
`--no-session` and the same strict extension/trust flags from a fresh empty temporary working
directory. The probe also sets `HOME` to that directory, and removes it afterwards, so neither
generic global nor caller-project MCP discovery can reach operator inputs. Input is one
correlated `get_commands` JSONL request; valid UI events are ignored, output and runtime are
capped, and malformed output or process failure fails. The response must contain exactly one
`mcp` command from `source: "extension"` whose reported path canonicalises to the same adapter
entry. The probe cannot write the caller project, operator home or a planned role home.

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

`provider`, `name`, `notes`, `modeId` (including its required absence for Pi), `icon` and
`color` are owned and repaired. The
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
also neuters that option is **unverified**, and the room does not pretend otherwise: since
`thinkingOptionId` is seeded once and yours afterwards, a room seat found on `ultra` or
`ultracode` in the live configuration produces a warning that names the seats, says the
delegation behaviour under those closures was not verified, and leaves the selection alone.
It does not change exit status, provider selection or what setup writes. Rejecting the option
outright would be enforcing a vendor claim nobody here has evidence for.

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

**Lead Discovery and Recovery** therefore gives Supervisor an explicit discovery-and-reuse
procedure. Its authoritative wording is the canonical contract section
[`contract/supervisor.md`](../src/room/prompts/contract/supervisor.md), over the shared evidence
in [`contract/shared-seat-identity.md`](../src/room/prompts/contract/shared-seat-identity.md),
and is not restated here. What matters for this file is the shape of its evidence: eligibility
comes from the *current live configuration* rather than display names — the exact current room
Lead profile read from `list_profiles` and materialized field by field, a cwd-filtered agent
list treated only as candidate discovery, then full status inspection for provider, workspace
and mode — and ownership must be corroborated by parentage or known Human-opened history
rather than assumed. A profile name, agent title, cwd or provider label is not membership, and
an unparented or ambiguous candidate enters duplicate recovery and Human escalation instead of
being adopted.

An eligible established Lead may be initializing, running, idle, waiting for permission, or
closed but unarchived and resumable; those are lifecycle states of one owner. Supervisor
opens exactly one child Lead only when no eligible, corroborated owner exists. Fresh-session
review is routed to that Lead, which opens a fresh read-only Peer under **Independent
Review**; freshness never creates a second Lead or gives Supervisor a channel to Peer.

**Peer Seat Lifecycle** applies the same live-config rule to a Lead-created Peer: Lead reads
the exact current room Peer profile, copies provider, mode and feature values exactly, keeps
the profile's model unless a repository protocol routes models, selects thinking
effort under that repository protocol's routing policy as described in §7, and requires the live seat's
daemon-added `paseo.parent-agent-id` to equal the current Lead. A wrong provider,
workspace, mode or parent is not eligible for a brief. The Peer remains one fresh session for
one brief and has no room tools or orchestration path. The brief also names exactly one
disposition — Engineer, Architect, Reviewer or Scout — which is an assignment mandate, not a
second profile or a seat identity.

Paseo currently does not retain `profileId` on an agent session; compact `list_agents`
results also omit `workspaceId` and `currentModeId`, which is why status inspection is a
separate step. Exact provider, mode and workspace prove that a direct launch is
profile-equivalent, not that someone literally clicked the profile. This design deliberately
does not add generation-versioned provider ids and does not claim daemon enforcement.

Duplicate recovery is intentionally bounded rather than magical. Supervisor stops new
parallel routing, preserves both histories and artifacts, keeps the previously established
healthy owner, and closes a duplicate only after moving work stops and a stable handoff
exists. Ambiguous prior ownership, health, or concurrent writes are escalated to Human.
Supervisor never merges work, accepts a candidate, or directs Peer during recovery.

**Peer Seat Lifecycle** still says Lead opens Peer seats only, and `ROLE_NOTES` surfaces the
sole-Lead rule at the `list_profiles` decision point. Focused tests assert the exact generated
instructions.
This is stronger and less ambiguous guidance, but remains procedural rather than runtime
enforcement; a contradictory or non-compliant caller can still supply any provider id.

### 5c. Configuration evidence and runtime limits

Setup and verify share one desired-state plan. It covers managed role files, exact provider
commands and role-home environment pins, profile provider/mode identity, and the shared room
protocol copy. Provider environments are compared **whole**, not as a subset: an extra live
key can enable exactly what a pin closes, so an added, removed or changed key is drift.
Unrelated *top-level* provider fields remain the operator's. Regression tests traverse that
whole chain for Codex, Claude and Pi and apply negative drift to each prompt carrier, each
role-home environment family, Pi's append path, and a profile provider. This proves generated
content and the live daemon configuration observed by the commands.

The next link is a vendor contract, not something `paseo-room` can observe from outside the
process: Codex ingests `developer_instructions` from its role `config.toml`; Paseo maps the
Claude plugin's `config.systemPrompt` value to the Claude Code SDK preset's append field,
with role `CLAUDE.md` retained as fallback; and Pi ingests the generated file named by
`--append-system-prompt`. Tests prove the generated carriers, plugin hook composition and live
registration/status. They do not prove that a process already running when setup changed the
files reloaded them, or that a resumed Claude session re-enters the creation hook, and neither
setup nor verify can prove that a model obeyed instructions in a particular turn. Generated/live
configuration evidence, vendor-runtime ingestion contracts, and model behavior are three
different claims.

### 5d. Contract provenance

`room.json` records a `contract` digest: `sha256:` plus the first 16 hex characters of a hash
over every document the room composes — the three role documents — in one fixed order. The
room-owned skill files are deliberately outside it: they are live managed entries whose exact
bytes `verify` compares, so a skill update never claims that a running seat holds different
startup instructions. It is derived from the rendered text rather than the package version on
purpose. Two package versions that render an identical contract are the same generation, and
editing one prompt asset without cutting a release still changes the digest, which is what
makes it useful while developing. It is truncated because it is provenance an operator
compares by eye, not a security claim; it authenticates nothing.

What it buys is a specific question that could not be answered before: *do the seats in this
room hold the text this package renders?* A matching digest passes. A different digest, or a
marker written before provenance existed and therefore carrying none, warns — stating that
setup rewrites the managed documents but a running seat keeps the text it started with, and
asking for `setup --apply` followed by a restart of the affected seats. The field is optional
in the marker schema so an older room still parses as a room rather than a foreign file. A
rollback to a package that predates the field regenerates its own marker through its own
setup; nothing migrates.

## 6. Add to a base prompt, never replace it

All three agents expose a replace-the-system-prompt path: `model_instructions_file` for
Codex, `--system-prompt` for Claude, and Pi's `SYSTEM.md` / `--system-prompt`. They are traps
for a tool like this one. Using them means
shipping a full copy of the vendor's system prompt — and re-shipping it on every agent
release, or silently degrading every seat when the vendor's prompt moves on.

The role contract is additive by nature, so it goes in the additive channel:
`developer_instructions` for Codex, a room-owned Paseo `before('agent.create')` hook that
writes `AgentSessionConfig.systemPrompt` for Claude, and the generated Pi append passed with
`--append-system-prompt`. Claude's generated `CLAUDE.md` remains as a degraded and resume
fallback.

That fallback is on by default and can be declined. `setup --no-claude-memory-contract` omits
the contract from the role `CLAUDE.md` files, leaving the plugin as the only Claude carrier. It
is an opt-out rather than the default precisely because resume behaviour is unproven: the
operator chooses to give up that coverage, and the run says so. Only the contract is dropped —
the operator's own global memory is still folded in, and a file with nothing left to carry is
removed rather than written empty, so an older contract generation cannot outlive the choice.
The decision is recorded in `room.json` as `claudeMemoryContract`, which is how `verify`
reconstructs the same desired state without being passed the flag again; absent means the
default, so a room written before the option existed keeps its behaviour.

Pinning the base prompt for stability is a legitimate thing to want, but it is the
operator's decision about their own installation, not the room's. If you set
`model_instructions_file` yourself, the room copies it through untouched.

Paseo launches Claude through the Claude Agent SDK rather than as a plain CLI process, so
there is no provider-owned argv into which a stronger append can be inserted;
`--system-prompt` remains the replace path this section refuses. Paseo 0.8 maps
`AgentSessionConfig.systemPrompt` to the Claude Code preset's SDK `append` field, but that
value is set per agent at creation time and cannot be pinned from a provider entry. The
room-owned, version-bounded server plugin supplies it at the `before('agent.create')` seam,
targeting only exact room Claude provider ids and preserving any caller prompt. The full
lifecycle and trust rationale is in
[claude-strong-contract-carrier.md](design/claude-strong-contract-carrier.md).

This stronger carrier is still bounded evidence: the room proves generated content, live
plugin registration/status, and deterministic composition, not model obedience. Only newly
created sessions pass through the hook; resume behavior is unproven, which is why
`CLAUDE.md` remains by default. Missing or failed plugin state makes Claude setup/verify fail rather than
silently claiming the stronger guarantee.

## 7. Deliberate non-goals

- **No transactional installer.** An earlier version had a journal, rollback, a versioned
  ownership manifest, lock files and inode-level identity guards — about 10k lines to
  protect a directory the tool creates itself. A half-finished `setup` is fixed by running
  `setup` again. Explicit `remove --apply` deletes the lot after warning that role-owned
  credential files are included. The type-safe atomic single write of §4a is not a step back
  toward that machinery: it makes one replacement safe, and rerunning setup is still the whole
  recovery model.
- **No installing or upgrading Paseo, Codex, Claude, Pi or `pi-mcp-adapter`.** The room checks
  compatibility and explains a mismatch; it never repairs someone else's installation.
- **No setup-time login or authentication validation.** Setup and verify report structural
  role-auth state and manage a secret-free guide, but do not run login, read credential
  contents, query keyrings, or validate token freshness. The separate, explicit `auth login`
  command only launches one vendor's interactive flow under the selected role home; it does
  not inspect the resulting credential store.
- **No launcher script.** The reference implementation wraps each seat in a shell script
  that regenerates the runtime on every launch. That buys automatic pickup of config
  changes, and costs a wrapper process whose stdout can corrupt the app-server's JSONL
  stream. Generating at `setup` time avoids the wrapper; the price is that changing your
  own config needs `setup --apply` again, which `verify` reports.
- **No per-seat model or task routing.** Model tier belongs to task risk, and that is a
  Workspace Protocol and Lead decision, not a room decision. The room preserves whatever
  model and reasoning effort you configured. **Peer Seat Lifecycle** keeps the hard split:
  provider, mode, workspace, parent and feature values are copied exactly as eligibility
  evidence; the profile's model stays the seat default unless a repository protocol
  explicitly supplies model routing; and thinking effort must follow that repository protocol's
  routing policy, use only an option the live Paseo/provider context establishes as supported,
  and never use a tier advertising automatic delegation. A repository that wants tactical
  routing criteria — task risk, uncertainty, context size, verification burden — states them in
  its own protocol; the room no longer ships a default that states them for every repository.
  Disposition informs that judgment and never fixes a tier. This is about *task* routing, and it is not a claim of
  capability parity between seats: which capabilities a seat carries is decided by role (§2b),
  because a seat with no room tools has no use for an orchestration surface.
- **No rewriting of operator control-plane configuration.** A recognizably Paseo-related MCP
  server makes setup fail before it applies anything (§2a); it never makes the room edit,
  filter or delete your MCP declarations, hooks, plugins or models. Detecting and refusing is
  the whole of it.
- **No concurrent writable Peers.** The model asks for one writer per moving scope with
  separate working trees; **Moving Write Ownership** holds the room to one writable Peer per
  project, which is stricter. The room provides no writer isolation, so separate scopes are
  not evidence of separate trees, and a repository protocol cannot relax the limit.
  Worktree-isolated concurrency is a deferred owner decision, not a gap to be closed by a
  repository file.
- **No security sandbox.** The room delivers tool policy and role authority. A Peer with
  shell access is not contained by it. Withholding executable resources and `paseo*` skills
  (§2b) is capability hygiene, and the MCP check is a bounded heuristic (§2a); neither is
  containment of a process that can run arbitrary code.
- **No Claude command-line prompt workaround.** Claude's strong carrier (§6) uses Paseo's
  creation-time SDK append seam through the room-owned plugin. It does not invent an argv hack,
  replace the vendor prompt, or treat `CLAUDE.md` as equivalent to an instruction-layer append.

`remove` is intentionally stronger than setup/update: after its dry-run warning and explicit
`--apply`, it recursively deletes the room home, including role-owned credential files. It
does not inspect or delete native OS keyring entries, which may remain, and never touches
operator agent-home authentication. Remote provider/profile cleanup is a precondition for that
local deletion: if Paseo is unavailable or cleanup errors, the room home and marker are retained
so rerunning `remove --apply` after recovery can finish without a journal or rollback mechanism.

## 8. Lineage

The model's own provenance is in
[demonthorn-agent-orchestration-deep-dive.md](demonthorn-agent-orchestration-deep-dive.md) §1.
This tool reaches it by way of `codex-room-setup` — a bash + Python implementation that
generated the same runtime homes and required a patched Paseo build to limit MCP injection
per provider. The contract wording in `src/room/prompts/contract/` descends from that
implementation's role overlays.

`paseo-room` differs in three ways worth stating:

1. It is an npm CLI with no launcher script and no patched daemon; per-provider room tools
   use Paseo's native `paseoTools` field.
2. It seats Claude Code and Pi as well as Codex, from one contract.
3. It generates once at `setup` instead of on every launch (see §7).

Where the written model and the reference implementation disagree, this tool follows the
implementation, because it is what actually ran. One such disagreement is live:

- The document's sample profiles put Supervisor and Lead in `read-only` sandboxes; every
  real config uses full access, and the Supervisor profile explicitly says to keep seats in
  full-access mode rather than accept a recurring permission ceremony. The room follows the
  real configs.

Two earlier deviations about the workspace protocol are resolved rather than live. The
reference overlays told every seat to read `WORKSPACE_PROTOCOL.md`, and an earlier version of
this room reproduced a shipped default in every role document; both broadcast the layer the
model reserves for Lead. The room now follows the document: Lead is the only standing reader,
Supervisor reads a repository file only under a Human mandate, Peer receives neither the
protocol path nor any workspace section, and Lead quotes what bears on an assignment into the
brief (§3). The shipped default itself is gone as well (§3): a repository that has no file of
its own leaves Lead on a short fallback in its own contract, and the onboarding skill exists so
that gap is closed by the repository's own evidence rather than by generic room text.
