# Change Request — Strong Claude contract carrier through a required room plugin

| Field | Value |
|---|---|
| Change ID | `role-contract-markdown-change-001` |
| Short name | Strong Claude carrier |
| Original plan | [Markdown Role Contract — Phase 1 Implementation Plan](role-contract-markdown-implementation-plan.md) |
| Status | Applied |
| Owner | Repository owner |
| Created | 2026-09-18 |
| Accepted | 2026-09-18 |
| Applied | 2026-09-18 |

## 1. Change summary

The accepted plan and PRD treat every Paseo plugin as optional, gated behind a separate Phase 2
feasibility decision, and accept `CLAUDE.md` as the room's only Claude carrier. This delta makes a
bundled, room-owned trusted **server plugin** a required part of a Claude room: it injects the role
contract at agent creation time through `agent.create` → `config.systemPrompt`, which Paseo's Claude
provider maps onto the Agent SDK preset append. `CLAUDE.md` is kept exactly as it is, as the
degraded/resume fallback. The plugin is only required when Claude is in the selection; nothing about
Codex or Pi changes.

## 2. Compelling reason

- **Discovered constraint, already documented as a known weakness.** [`docs/design.md`
  §6](../design.md) states that `CLAUDE.md` is user memory a project-level `CLAUDE.md` can dilute,
  that Paseo launches Claude through the Agent SDK so no provider-owned argv exists, and that
  `AgentSessionConfig.systemPrompt` "would be the strong equivalent, but it is set per agent at
  creation time and cannot be pinned from a provider entry". Paseo 0.8's `server.before('agent.create')`
  hook is exactly the creation-time seam that section was missing, so the "belongs upstream in Paseo"
  conclusion no longer holds for the delivery channel — only for a provider-level pin.
- **Owner decision, 2026-09-18.** The repository owner decided to proceed on the Paseo 0.8 plugin API
  now rather than wait for a stable API, accepting the preview-API risk and paying for it with an
  explicit upper version bound.
- **Requirement gap, not convenience.** REQ-006 preserves the additive carrier contract; it does not
  promise the Claude carrier is strong. Without this delta the strongest available Claude channel
  stays unused while the room continues to claim only "short enough to survive dilution".

## 3. What changes — Before / After

### Before (per the original plan and PRD)

Original plan §1 MVP-Lock, "Out of this phase":

> all Paseo plugin feasibility, plugin packaging, hooks, UI/RPC, and runtime guards

PRD §3 Out of Scope:

> Making the companion plugin mandatory or a prerequisite for any documented guarantee in this initiative.

PRD REQ-012 keeps the CLI the enforcement floor "with the plugin absent or disabled", and PRD §9
Phase 2 gates every plugin artifact behind a timeboxed feasibility decision.

### After (per this delta)

For a selection containing Claude:

- `paseo-room` ships a bundled, dependency-free Paseo **server** plugin whose manifest declares
  `requirements.paseo` as `>=0.8.0 <0.9.0`.
- `setup --apply` writes the plugin's files under `~/.paseo-room` as ordinary managed entries and
  registers that directory with the local daemon through the Paseo API.
- A `before('agent.create')` hook appends the rendered role contract to `config.systemPrompt` for
  **exact room Claude provider ids only**, skipping Paseo's internal agents and never touching an
  operator's own Claude provider. Composition is marker-delimited and idempotent.
- `CLAUDE.md` remains byte-identical to today and remains the documented fallback: whether a resumed
  session re-runs the creation hook or persists a previously injected prompt is **unproven**, so the
  file carrier is not weakened or removed.
- `pluginsEnabled` stays an explicit operator opt-in. The room reads it, and fails with actionable
  guidance when it is not enabled; it never sets, patches, or infers it.
- Plugin absence, disablement, load failure, path drift, or generated-content/contract-generation
  drift makes `verify` **fail** for Claude, on the same footing as provider-pin drift.
- `remove --apply` deregisters the plugin through the API before deleting the room home, and leaves
  `pluginsEnabled` alone.

Claude therefore gains a second, stronger carrier; it does not lose the first one.

### Concrete diff

| Aspect | Before | After |
|---|---|---|
| Scope | Phase 1 plan: 4 work packages, no plugin artifact | Unchanged Phase 1 plan + a separate active design/plan for this carrier (3 work packages) |
| Architecture | Claude contract delivered only as `CLAUDE.md` user memory | Two carriers: creation-time `config.systemPrompt` append (strong) + unchanged `CLAUDE.md` (degraded/resume fallback) |
| Dependency | Paseo daemon only; `>= 0.8.0-beta.1`, raised to `>= 0.8.0` by Pi | Adds a room-owned local plugin registered through the daemon plugin API; a selection containing Claude also raises the floor to `>= 0.8.0`, and the plugin manifest bounds it below `0.9.0` |
| Plugin posture | Optional, Phase-2 gated, never a prerequisite for a guarantee | **Required for Claude rooms**, for this carrier only; still trusted code requiring operator `pluginsEnabled` |
| `verify` | Claude carrier evidence is file + provider pins | Adds plugin registration/status/content/generation checks; failure, not warning |
| Timeline | Phase 2 feasibility gate precedes any plugin artifact | Feasibility gate superseded **only** for this carrier; plugin guard/UI/RPC surfaces stay Phase-2 conditional |
| API contract | N/A | Consumes preview Paseo plugin contracts: `agent.create` before-hook, `plugin.directory.install`, `plugin.list`, `plugin.reload`, `plugin.remove`, and the daemon `pluginsEnabled` flag |
| Data model | N/A — no persisted data | Unchanged; `room.json` keeps its existing `contract` digest, reused as the plugin's contract generation |

## 4. Impact

### Affected beads

| Bead ID | Action | Reason |
|---|---|---|
| N/A | NEW | No bead edit belongs to this delta. Phase 1's bead graph is closed and frozen; this carrier is converted from its own active plan, [Claude Strong Contract Carrier — Implementation Plan](claude-strong-contract-carrier-implementation-plan.md). |

### Other affected artifacts

- [x] PRD: [Role Contract Maintainability and Paseo Runtime Guard PRD](../product/role-contract-and-plugin-prd.md) — §3 out-of-scope ("never mandatory"), REQ-012 ("with the plugin absent or disabled"), and §9 Phase 2 are **narrowed, not withdrawn**, by this delta for the Claude carrier only. The PRD stays Accepted and unedited; this artifact is the record of the narrowing, per the owner's instruction to leave frozen Phase 1 artifacts alone.
- [x] Technical design: new active design, [Claude Strong Contract Carrier](../design/claude-strong-contract-carrier.md). The frozen [Markdown Role Contract Technical Design](../design/role-contract-markdown.md) is not edited.
- [ ] ADR: none — the repository has no ADR directory and this introduces no new architectural layer beyond the already-consumed Paseo control plane.
- [ ] Migration / schema: none. No persisted schema, no credential migration; `room.json` keeps its existing optional `contract` field.
- [x] API contract: consumes preview Paseo plugin APIs. No `paseo-room` public API or CLI flag changes.
- [x] Active documentation: [`docs/design.md`](../design.md) §5c/§6 and its non-goals, `README.md`, and `AGENTS.md` need the new required-plugin rule and the sharpened evidence boundary. Owned by the new plan's documentation work package.

### Risk delta

- **Preview plugin API instability.** `>=0.8.0 <0.9.0` fences the manifest, and the daemon refuses to
  load an out-of-range plugin. A 0.9 daemon therefore degrades a Claude room to the `CLAUDE.md`
  carrier and must fail `verify` with that explanation rather than silently continuing.
- **A required plugin is a new hard dependency for Claude.** It moves a room from "CLI-only floor" to
  "CLI floor plus one required trusted local plugin". The floor itself is unchanged: with the plugin
  absent the room is degraded and loudly failing, never silently more permissive — no seat gains
  tools, authority, or a native multi-agent path from a missing hook.
- **Resume behaviour is unproven.** Whether a resumed Claude session re-invokes the hook or carries a
  previously injected prompt is not established. Mitigated by keeping `CLAUDE.md` and by documenting
  the creation-time claim as creation-time only.
- **Trusted, unsandboxed code in the room's blast radius.** The plugin is room-authored, has no
  imports beyond its own files, and registers exactly one hook. It is still trusted code, which is why
  `pluginsEnabled` remains the operator's explicit act.
- **Double injection / operator collateral.** A marker-delimited, idempotent composition and exact
  room-provider-id matching contain both; the hook returns unchanged input for every other provider
  and for Paseo's internal agents.

No claim is made that the injected prompt was observed being ingested by a running model. The room can
prove the hook is registered, that the plugin is loaded and running, and what string the composition
produces; ingestion remains a vendor/runtime contract, exactly as §5c already states for the file
carriers.

## 5. Out of scope for this delta

- Any plugin UI, sidebar surface, workspace panel, RPC, timeline row, theme, or client entry. This
  plugin has **no client entry**.
- Runtime guards or policy enforcement of any kind: no duplicate-Lead prevention, no
  creator/parentage checks, no topology validation. Those remain PRD REQ-014/REQ-015 and stay
  conditional on the Phase 2 decision.
- Codex and Pi carriers, wording, authority, role distribution, providers, profiles, credentials, and
  CLI flags.
- Any change to the role contract text, its composition, or the Markdown asset tree.
- Enabling, installing, or upgrading anything on the operator's behalf: `pluginsEnabled`, Paseo,
  Claude, or the plugin outside the room home.
- Replacing the vendor system prompt. The hook **appends**; a replace path would reopen
  `docs/design.md` §6.
- Retroactively updating an already-running seat.

## 6. Approval

Approved-by: Repository owner, 2026-09-18.

Basis: explicit owner approval on 2026-09-18 to proceed immediately on the Paseo 0.8 preview plugin
API rather than waiting for a stable API, accepting the preview-API risk and the required-plugin
posture for Claude rooms.

## 7. Apply plan

1. Convert [Claude Strong Contract Carrier — Implementation Plan](claude-strong-contract-carrier-implementation-plan.md)
   into beads. Phase 1's frozen bead graph is not reopened.
2. Implement WP-001 → WP-003 of that plan; no artifact under `docs/product/` or the frozen Phase 1
   design/plan scope sections is edited.
3. The original plan's revision history already carries a one-line reference to this delta (done
   2026-09-18); its frozen scope is left as written.
4. Update active documentation per §4, then set Status = Applied and fill the Applied date once the
   full `npm run verify` gate passes on the implemented carrier.

## 8. Things deliberately NOT changed

- **`CLAUDE.md` stays exactly as it is.** Removing or shortening it was considered and rejected:
  resume persistence and hook re-invocation are unproven, so the file is the room's only carrier for
  a session the hook never sees.
- **`pluginsEnabled` is not automated.** Writing it would be the room enabling trusted unsandboxed
  code on the operator's machine on their behalf. Reading and refusing is the whole of it, matching
  the existing "detect and refuse, never rewrite operator control-plane configuration" rule.
- **No provider-level pin for the system prompt.** It still does not exist upstream. `docs/design.md`
  §6 keeps that as the real fix; this carrier is the creation-time seam, not a substitute for it.
- **The Phase 2 feasibility gate survives.** It is superseded only for this carrier. Plugin guards,
  UI, and RPC still require the separate go/no-go.
- **No transaction machinery.** Registration failure is fixed by running `setup` again, per
  `AGENTS.md`.
- **Codex and Pi keep their existing carriers.** Codex's `developer_instructions` is already an
  instruction field; Pi's append is already additive and provider-owned.

## 9. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-18 | Bytes | Created and accepted on owner approval: required bundled server plugin as the strong creation-time Claude carrier, `CLAUDE.md` retained as degraded/resume fallback, Phase-2 feasibility gate superseded for this carrier only. |
| 2026-09-18 | Bytes | Applied: bundled carrier, managed lifecycle, fail-closed verification, package assets, tests, and active documentation completed; full `npm run verify` gate passed. |
