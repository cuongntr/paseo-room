# AGENTS.md

## Purpose

This repository builds `paseo-room`, an npm/npx CLI that creates and manages a user-global Paseo Room with this Phase 1 topology:

```text
Human → Supervisor → Lead → Peer
```

Phase 1 supports homogeneous Codex rooms on macOS and Linux. Claude Code, Pi, OpenCode, mixed-agent rooms, Windows, remote Paseo daemons, partial tool policies, and automatic migration from `codex-room-setup` are out of scope.

The repository is pre-implementation: no runnable `paseo-room` package exists yet. Until the package foundation lands, lifecycle commands and contracts below describe required behavior rather than commands available to execute.

## Source of Truth

Read the relevant documents before changing behavior:

1. [Accepted PRD](docs/product/paseo-room-prd.md) — product scope and REQ-001–REQ-019.
2. [Active Technical Design](docs/design/platform/paseo-room.md) — architecture, public contracts, persistence, security, and recovery.
3. [Active Role Compatibility Contract](docs/design/platform/paseo-room-role-contract.md) — RC-001–RC-305 and exact Codex role overlays.
4. [Active Phase 1 Implementation Plan](docs/plans/paseo-room-phase-1-implementation-plan.md) — frozen REQ-001–REQ-016 delivery scope and gate order.
5. The assigned Bead — bounded implementation scope and definition of done.

When these sources disagree, stop and report the conflict. Do not silently reinterpret an accepted requirement or Active design. Phase 1 additions require an accepted delta-change.

## Work Tracking

This repository uses Beads through `bd`.

`bd` must be available before working the graph. It manages the embedded Dolt issue database under `.beads/`; see [.beads/README.md](.beads/README.md) for the local quick start. Do not edit database files directly. Confirm the export setting with `bd config get export.git-add`; if needed, restore it with `bd config set export.git-add false`.

```bash
bd ready --json
bd show <issue-id> --json
bd update <issue-id> --claim
bd dep cycles --json
```

- Work only on an actionable leaf Bead, not directly on an epic.
- Treat the Bead's scope, prerequisites, validation, proof, reversibility, and provenance as the implementation contract.
- Do not close a Bead until its definition of done is verified.
- Keep `.beads/issues.jsonl` consistent with the database. `export.git-add` must remain disabled.
- Do not create Git commits unless the repository owner explicitly asks.

The current graph root is `paseo-room-s7a`. The initial implementation frontier is `paseo-room-u36`.

## Technology and Repository Conventions

- Node.js `>=22`.
- npm package manager and publication format.
- Strict TypeScript ESM; do not introduce `any`, type suppression, or CommonJS without an approved design change.
- `tsup` for package output and Vitest for tests.
- Use `commander`, `@clack/prompts`, `zod`, `smol-toml`, `semver`, and the pinned public `@getpaseo/client` baseline selected by the design.
- Import Paseo only from the public `@getpaseo/client` package root. Never import internal APIs.
- Keep shared lifecycle code agent-agnostic. Codex paths, TOML, launch rules, model catalog handling, and tool vocabulary belong under `src/adapters/codex/`.
- Use dependency injection for filesystem, process, clock/PID, adapter, and Paseo boundaries so tests can use disposable fixtures.
- Match the module layout in the Technical Design unless the assigned Bead explicitly changes it.

## Non-Negotiable Behavioral Contracts

- Dry-run is the default. Filesystem or daemon mutation requires wizard confirmation or explicit `--apply`.
- Public lifecycle commands are `plan`, `install`, `verify`, `doctor`, `recover`, and `uninstall`.
- JSON output uses schema version 1 and writes exactly one JSON document to stdout.
- Exit codes are fixed: `0` success, `1` validation, compatibility, verification, or operation failure, `2` usage error, `3` ownership conflict, `4` recovery required.
- Managed provider IDs are exactly `codex-supervisor`, `codex-lead`, and `codex-peer`.
- Supervisor and Lead use `paseoTools.enabled: true`; Peer uses `false`. Phase 1 does not expose `disabledTools`.
- Every provider update supplies the complete fixed key set: `extends`, `label`, `command`, `env`, and `paseoTools`.
- Provider launch commands use an absolute native Codex executable or `[absoluteNode, absoluteCodexScript]`. They must not depend on npm cache or a GUI daemon's shell `PATH`.
- Role homes are isolated. Canonical Codex state and the managed root must be disjoint in both ancestor directions.
- Codex overlays are pinned by the Role Compatibility Contract, including model `gpt-5.6-sol`, reasoning `medium`, `danger-full-access`, approval `never`, and disabled native multi-agent behavior.
- Human retains product, priority, material-cost, external-effect, and irreversible-risk decisions. Lead owns technical acceptance. Peer cannot orchestrate or self-accept.

## Safety and Ownership

- Paseo and Codex are user-managed dependencies. Never install, upgrade, authenticate, start, stop, or repair them on the user's behalf.
- Never write `~/.paseo/config.json` directly. Use `client.config.get()` and `client.config.patch()` through the public SDK.
- Local daemon admission uses canonical Paseo home, current-user PID/owner evidence, normalized loopback listen endpoint, equal compatible CLI/daemon versions, and reachability. Bind manifests and locks to the hash of canonical home plus normalized status listen. Because the pinned public SDK does not expose connected `serverId`, do not claim protocol-level peer identity; re-probe under lock and verify full provider state after mutation.
- Never modify or claim the canonical Codex home, credentials, unrelated Paseo providers, or Codex-created mutable role state.
- Never copy, print, persist, back up, or hash credential content. `PASEO_PASSWORD` is memory-only: it may be passed only through the selected Paseo status subprocess environment and public SDK config, must be excluded from argv/provider/Codex environments, and must be redacted from errors.
- Use argv arrays with `shell: false`, absolute executable paths, bounded timeouts, and sanitized output.
- Check paths with `lstat`/`realpath`; reject symlink parents, path escape, hard-link alias risk, foreign ownership, unsupported shebangs, and managed/canonical root overlap.
- Managed roots and backups are `0700`; owned regular files and journals are `0600`. First-install root creation must first persist the accepted deterministic sibling `0600` bootstrap sidecar, create the absent root without clobbering, and transfer authority to the durable internal journal before retiring the sidecar. Pre-existing roots are never adopted.
- Do not follow symlinks during backup, hashing, rollback, or uninstall. Record and compare link metadata only.
- First-install collisions and customized managed state are conflicts. Never adopt, overwrite, or force-delete them.
- Roll back only when the current value still equals the transaction's recorded after-value. Preserve divergence and return `recovery-required`. Portable update/removal uses journaled unpredictable same-parent capture names followed by no-clobber publication; the destination may be briefly absent. Deliberate same-UID interference with transaction-private names/captured inodes and same-inode writes through existing descriptors are outside Phase 1 and must be serialized.
- Never restore the whole Paseo configuration. Never automatically retry mutations with ambiguous outcomes.
- An unfinished journal blocks normal mutation. Only `recover --apply` may mutate recovery state.
- Automated tests must use disposable homes and isolated daemons. Do not touch the operator environment. The only exception is the separately approved final macOS R3 (real user-home risk-containment) rehearsal defined by the Technical Design.

`paseoTools.enabled: false` is a Paseo capability boundary, not an operating-system sandbox. Do not claim otherwise in code, tests, or documentation.

## Testing and Verification

Follow this gate order unless a Bead narrows the required proof:

1. Typecheck.
2. Lint.
3. Unit and property tests.
4. Integration and failure-injection tests.
5. Package build and `npm pack` checks.
6. Isolated Paseo contract and platform smoke tests when applicable.

Additional rules:

- Test observable behavior, ownership decisions, public schemas, and failure boundaries—not implementation trivia.
- Default/read-only commands must leave fixture homes byte-for-byte unchanged.
- Cover every ownership decision, journal transition, public exit code, and relevant requirement acceptance criterion.
- Preserve unrelated providers and files in positive, negative, property, and uninstall tests.
- Use pinned Paseo `0.8.0-beta.1` contract tests where mocks cannot prove SDK persistence, provider readiness, launch composition, or policy read-back.
- Keep at least 85% branch coverage for safety logic under `src/core`, `src/paseo/provider-policy`, and `src/adapters/codex`; explicit critical-case evidence takes precedence over aggregate coverage.
- Report every skipped or unavailable gate. Never weaken a check to obtain a passing result.

## Clean-Room Requirement

The behavior of the unlicensed `codex-room-setup` reference was characterized during design, but its source is not licensed for reuse. Implement behavior from this repository's requirements and contracts. Do not copy reference source, prose, templates, tests, or generated artifacts.

## Change Discipline

- Keep changes within the assigned Bead's write scope.
- Preserve unrelated work and unfamiliar files.
- Prefer the simplest implementation satisfying the frozen contract and reuse established local patterns.
- Public CLI/JSON/exit semantics, persisted schemas, provider shape, role authority, security boundaries, and rollback behavior require explicit design review before incompatible changes.
- Any change that weakens Peer policy, enables partial `disabledTools`, follows links during mutation, accepts remote daemon targets, adopts existing managed provider IDs, or changes the pinned role overlay requires repository-owner security review.
- Update user or operator documentation whenever observable behavior changes.
