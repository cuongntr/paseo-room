# AGENTS.md

## What this repository is

`paseo-room` is a small CLI that generates Codex/Claude role homes under `$HOME` and
registers them with a local Paseo daemon. [README.md](README.md) describes the behaviour,
[docs/orchestration-model.md](docs/orchestration-model.md) is the reference model it
implements, and [docs/design.md](docs/design.md) explains why each override exists. **Read
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
- **No transaction machinery.** The room home is disposable: a failed `setup` is fixed by
  running `setup` again, and `remove` deletes it. That is the entire recovery story.
- **Compatibility is one check.** `paseo daemon status --json` must report a running daemon,
  matching CLI and daemon versions, and `>= 0.8.0-beta.1`.
- **Copy the operator's config, override the minimum.** Never rewrite someone's model, MCP
  servers, or hooks.
- **Add to a base prompt, never replace it.** `model_instructions_file` (Codex) and
  `--system-prompt` (Claude) replace the vendor prompt and would force us to vendor a copy
  of it. Role text goes in `developer_instructions` / `CLAUDE.md`.
- **Pin at the provider level whatever the agent's own config cannot guarantee.** A Paseo
  provider entry outranks the agent config: `params` for Codex sandbox/approval,
  `disallowedTools` for Claude's `Task`. `providerMatches` compares these, so `verify`
  catches their removal — a pin that can be silently dropped is not a guarantee.
- **Paseo is the only control plane.** Every native multi-agent path stays closed. If you
  add an agent adapter, close its equivalent before shipping it.
- **Peer never gets room tools.** `ROLE_PASEO_TOOLS` in `src/roles.ts` is the single source
  of that rule, and it must stay a single call site.

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
  agents/codex.ts  agents/claude.ts         # per-agent role homes
  room/clauses.ts  room/instructions.ts     # the role contract text
test/                                       # one file per area, real temp $HOME fixtures
docs/orchestration-model.md                 # the model; changes here are conceptual
docs/design.md                              # this tool's rationale; keep current with code
```

## Adding an agent adapter

1. Add the id to `AGENT_IDS` in `src/roles.ts`.
2. Implement `Agent` in `src/agents/<id>.ts`: `homeEnv`, `pins`, and a `build` that returns
   entries, checks and the resolved binary. Do not build providers there — `commands.ts`
   does that from `homeEnv` and `pins`, so the tool policy stays in one place.
3. Close the agent's native multi-agent path in `pins` or in the generated config, and say
   how in `docs/design.md` §3.
4. Share the operator's credentials and skills by symlink; never copy secrets.
5. Register it in `AGENTS` in `src/commands.ts`.

## Working on the role contract

`src/room/clauses.ts` is prose, written as ordinary wrapped text — blank lines separate
statements, line breaks inside a statement collapse when rendered. It is the role-profile
layer of [the model](docs/orchestration-model.md) §3, so it carries identity, authority and
invariants — never repository tactics or task detail.

Changing a clause changes what every seat is told, so state the authority it grants or
removes in the commit message. Shared clauses (`SHARED_IDS`) go to all three seats; role
clauses go to one.

`src/room/workspace.ts` is the default for the *workspace* layer, appended to every role
document and written out whole as `room/WORKSPACE_PROTOCOL.md`. `PROTOCOL_IDS` in
`instructions.ts` decides which sections each seat receives.

Every statement there must be workflow and must be new. Authority belongs in `clauses.ts`:
restating a clause here teaches the seat nothing and blurs the boundary the two layers
depend on. Anything true of only one project belongs in that project's own
`docs/WORKSPACE_PROTOCOL.md`, which wins over this default wherever it speaks.

## Before committing

```bash
npm run verify   # typecheck → lint → test → build, in that order
```

Do not report work as done on a subset of that chain.

## Releasing

`.github/workflows/release.yml` publishes to npm when a GitHub Release is published. It
re-runs the gate, refuses to publish if the tag does not match `package.json` (`v0.1.0` →
`0.1.0`), and picks the dist-tag from the version: a prerelease goes out as `next`, anything
else as `latest`.

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
