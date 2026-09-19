# AGENTS.md

## What this repository is

`paseo-room` is a small CLI that generates Codex/Claude/Pi role homes under `$HOME` and
registers them with a local Paseo daemon. [README.md](README.md) describes the behaviour,
[docs/demonthorn-agent-orchestration-deep-dive.md](docs/demonthorn-agent-orchestration-deep-dive.md)
is the reference model it implements, and [docs/design.md](docs/design.md) explains why each override exists. **Read
the design notes before changing an override, an overlay key, or a provider field** — most
of them are counter-intuitive and exist because of a specific failure.

It is deliberately simple. An earlier version implemented a transactional installer
(journal, rollback, ownership manifest, lock files, inode-level guards) — roughly 10k lines
for the same result, and so hard to exercise that features could not be tested by hand.
That design is in git history before the `v2` rewrite. Do not reintroduce it.

## Design rules

- **Everything stays in `$HOME`.** Only `~/.paseo-room` is written. Agent homes are read,
  never modified.
- **Dry run by default.** Mutation happens only under `--apply` or an explicit wizard
  confirmation.
- **No transaction machinery.** A failed `setup` is fixed by running `setup` again. Explicit
  `remove --apply` deletes the room home, including role-owned credential files, after warning.
- **Compatibility is one check.** `paseo daemon status --json` must report a running daemon,
  matching CLI and daemon versions, and `>= 0.8.0-beta.1`; a selection containing Claude or Pi
  raises that floor to `>= 0.8.0`.
- **Copy the operator's config, override the minimum.** Never rewrite someone's model, MCP
  servers, or hooks. Pi role settings omit package and extension declarations so startup
  cannot install packages or discover unrelated extensions.
- **Add to a base prompt, never replace it.** `model_instructions_file` (Codex) and
  `--system-prompt` (Claude) replace the vendor prompt and would force us to vendor a copy.
  Role text goes in `developer_instructions`, Claude's room plugin `config.systemPrompt` append
  with `CLAUDE.md` as degraded fallback, and Pi's additive `APPEND_SYSTEM.md`.
- **Claude's strong carrier is a required trusted plugin.** It is bounded to Paseo
  `>=0.8.0 <0.9.0`, appends only for exact room Claude provider ids at agent creation, and
  retains `CLAUDE.md` as degraded/resume fallback. Require `pluginsEnabled`; never set or infer it.
  `--no-claude-memory-contract` drops only the contract half of `CLAUDE.md`, never the operator's
  own memory, and is recorded in the marker so `verify` compares against the room's own choice.
- **Pin at the provider level whatever the agent's own config cannot guarantee.** A Paseo
  provider entry outranks the agent config: `params` for Codex sandbox/approval,
  `disallowedTools` and environment pins for Claude's native agent surfaces.
  `providerMatches` compares these, so `verify` catches their removal — a pin that can be
  silently dropped is not a guarantee.
- **Paseo is the only control plane.** Every native multi-agent path stays closed. If you
  add an agent adapter, close its equivalent before shipping it.
- **Pi adapters are explicit and authenticated.** Resolve only the operator Pi home's global
  `pi-mcp-adapter`, require canonical package containment, and prove `/mcp` attribution with
  the bounded offline RPC probe. Never install or upgrade Pi or the adapter.
- **Peer never gets room tools.** `ROLE_PASEO_TOOLS` in `src/roles.ts` is the single source
  of that rule, and it must stay a single call site. Peer's narrower resource set follows from
  the same principle and lives in `src/agents/resources.ts`; it is capability hygiene, not
  containment, and must never be documented as a sandbox. `roleResourceEntries` decides both
  projections generically: Supervisor keeps whole-directory aliases, Lead's role-home `skills`
  stays a symlink to an exact room-owned aggregate of every operator skill plus the room-owned
  one, and Peer's is an exact role-home projection of the non-`paseo*` operator skills. No
  projection ever writes into an operator home.
- **The room ships no default workspace protocol.** A repository's root
  `WORKSPACE_PROTOCOL.md` is optional and, where it exists, complete: there is no room default
  behind it and no point-by-point merge. Lead resolves the repository root and reads it in full
  before orchestration, and is the only standing reader; Supervisor reads a repository's protocol
  only under an explicit Human audit, update, or maintenance mandate, and may propose a change
  with causal evidence but never impose one. Lead's contract carries a deliberately small,
  always-visible `Assignment Vocabulary and Operating Baseline`, not a hidden workspace fallback.
  Do not reintroduce a shipped default, a generated room template, or a merge rule; read
  [docs/design/lead-project-onboarding-skill.md](docs/design/lead-project-onboarding-skill.md)
  first if you are tempted.
- **One room-owned skill, for Lead only.** `src/room/skills/paseo-project-onboarding/` is the
  procedure for drafting a repository protocol from that repository's own evidence. It is
  proposal-first and writes the repository file only under an explicit Human apply instruction.
  It reaches Lead through the projected `skills` directory and no other seat. Its bundled
  template is a scaffold loaded while the skill runs, never a runtime default.
- **Peer reads one brief, not the organisation manual.** Peer receives no workspace layer, no
  room skill, and is never told the protocol filename; Lead quotes the constraints that bear on an assignment
  into the brief. The `Authority Floor` section of `contract/shared-authority.md` keeps the
  invariant that repository or workspace instructions cannot enlarge or weaken contract
  authority and routes conflicts to Lead. What a Peer needs unconditionally lives in its own
  contract body, not in the workspace layer: house-style and no-unrequested-additions restraint
  under `Bounded Outcome`, faithful reporting and the unrun-gate bar under
  `Reproducible Handoff`.
- **Own a managed path by shape, and only the shape you write.** A managed file or link may
  replace only an absent path or the same shape, and is renamed in from a temporary sibling. A
  path declared absent is deleted only when it is a regular file the room would otherwise have
  written. Exact directory ownership is declared per entry and must never be extended to role
  homes or credential-bearing paths.

## Layout

```text
src/
  index.ts      cli.ts      wizard.ts       # entry, flags, guided flow
  commands.ts                               # setup / verify / remove, and the shared diff
  layout.ts     fsops.ts    which.ts        # $HOME paths, file writes, executable lookup
  result.ts     render.ts                   # checks/operations, and how they are printed
  paseo.ts                                  # version check + provider config over the SDK
  room.ts                                   # room.json marker
  agents/types.ts                           # the Agent seam: entries, checks, binary, pins
  agents/codex.ts  agents/claude.ts  agents/pi.ts   # per-agent role homes
  agents/resources.ts                       # per-role operator resource sharing and Peer projection
  agents/mcp.ts                             # bounded Paseo MCP recognition, shared by the adapters
  room/instructions.ts                      # semantic role document composition
  room/prompts.ts  room/prompts/             # typed registry + canonical Markdown assets
  room/skills.ts   room/skills/              # the room-owned Lead skill: loader + assets
test/                                       # one file per area, real temp $HOME fixtures
docs/demonthorn-agent-orchestration-deep-dive.md  # the model; changes here are conceptual
docs/design.md                              # this tool's rationale; keep current with code
```

## Adding an agent adapter

1. Add the id to `AGENT_IDS` in `src/roles.ts`.
2. Implement `Agent` in `src/agents/<id>.ts`: `homeEnv`, `pins`, and a `build` that returns
   managed entries, preserve-only credential diagnostics, checks and the resolved binary. Do
   not build providers there — `commands.ts`
   does that from `homeEnv` and `pins`, so the tool policy stays in one place.
3. Close the agent's native multi-agent path in `pins` or in the generated config, and say
   how in `docs/design.md` §2.
4. Keep mutable credentials role-owned and preserve-only: never copy, link, inspect, replace,
   or validate them. Share supported read-only resources through `roleResourceEntries` in
   `src/agents/resources.ts` rather than linking them directly: it is the single place that
   decides what Peer does not receive, and declaring an executable resource name there is part
   of closing a new agent's capability surface.
5. Run the operator's MCP declarations through `paseoMcpCheck` in `src/agents/mcp.ts` before
   planning any write, so a Paseo-looking server fails the build instead of reaching a seat.
   Never edit, filter or rewrite the operator's declarations.
6. Register it in `AGENTS` in `src/commands.ts`.

## Working on the role contract

`src/room/prompts/` is the canonical model-facing prose. The contract assets under
`prompts/contract/` are the role-profile layer of
[the model](docs/demonthorn-agent-orchestration-deep-dive.md) §3, so they carry identity,
authority, and invariants — never repository tactics or task detail. Document heads live under
`prompts/documents/`; Pi-only additive capsules live under `prompts/pi/`. Do not duplicate
their authoritative prose in TypeScript or documentation.

Assets are files by independent distribution, not one file per heading:

```text
contract/shared-authority.md      every role
contract/shared-seat-identity.md  Supervisor + Lead
contract/challenge-signals.md     Lead + Peer
contract/{supervisor,lead,peer}.md  exactly one role each
```

All of them use ordinary wrapped prose: blank lines separate statements, and line breaks
inside a statement collapse when rendered. A role body may hold several H2 sections; a document
head or Pi capsule has one H1 and keeps its authored line breaks. Changing a contract asset
changes what at least one seat is told, so state the authority it grants or removes in the commit
message. `instructionKeys()` in `src/room/instructions.ts` defines each role's layer sequence and
gives every role exactly one role body.

Anything true of only one project belongs in that project's own root `WORKSPACE_PROTOCOL.md`,
which the room never writes: only `~/.paseo-room` is written. Do not add a room-wide workflow
document to compensate — that is exactly what this design removed. If Lead demonstrably cannot
act without some statement in the absence of a repository protocol, it belongs in Lead's
`Assignment Vocabulary and Operating Baseline` section, kept minimal, and nowhere else.

`src/room/skills/` is model-facing too, and read the same way: `SKILL.md` follows Agent Skill
frontmatter (`name`, a precise triggering `description`), and the `references/` template is a
scaffold, not policy. Its hard boundaries — no authority change, no tool-policy change, no
writer-cap change, no invented policy, no write without an explicit Human apply instruction —
are covered by static contract tests in `test/instructions.test.ts`. Changing the skill's
boundaries changes what Lead may do to a repository, so say so in the commit message.

## Before committing

```bash
npm run verify   # typecheck → lint → test → build → packed-package test, in that order
```

Do not report work as done on a subset of that chain.

## Releasing

`.github/workflows/release.yml` publishes to npm when a GitHub Release is published. It
re-runs the gate, refuses to publish if the tag does not match `package.json` (`v0.1.0` →
`0.1.0`), and picks the dist-tag from the version: a prerelease goes out as `next`, anything
else as `latest` — except that while the registry holds no stable version at all, a
prerelease also takes `latest`. npm hands `latest` to whichever version is published first
and never moves it on its own, so without that exception `npm install paseo-room` would keep
serving the oldest alpha. It cannot be corrected after the fact from CI: OIDC authenticates
`npm publish` and nothing else, so `npm dist-tag add` has no credential.

There is no `NPM_TOKEN`. The workflow authenticates through npm [trusted
publishing](https://docs.npmjs.com/trusted-publishers): GitHub mints an OIDC token
(`id-token: write`), npm verifies it came from this repo and this workflow file, and attaches
a provenance attestation. Two consequences:

- Renaming this workflow file breaks publishing until the trusted publisher is updated on
  npmjs.com.
- npm can only register a trusted publisher for a package that already exists, so **the first
  version must be published by hand** — `npm publish --tag next` locally — and the trusted
  publisher configured afterwards.

To cut a release: bump the version, land it on `main`, then publish a GitHub Release whose
tag is `v<version>`.
