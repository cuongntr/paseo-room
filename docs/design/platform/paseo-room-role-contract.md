# Paseo Room Phase 1 — Role Compatibility Contract

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Requirements source | [Paseo Room PRD REQ-007](../../product/paseo-room-prd.md#6-functional-requirements) |
| Parent design | [Paseo Room Technical Design](paseo-room.md) |
| Characterization source | Observable behavior of `codex-room-setup` commit `a38c5ceaa0e30aa709a917136fdeaa6de2925993`; clean-room semantic restatement |

This contract pins the Phase 1 authority semantics and Codex overlay values. Implementations may choose original wording, but every numbered invariant must remain explicit and no generated instruction may contradict it.

## 1. Authority Matrix

| Decision / action | Human | Supervisor | Lead | Peer |
|---|---|---|---|---|
| Product goals and priority | Owns | Routes faithfully | Executes within boundary | Executes delegated outcome |
| Material cost, external effect, irreversible risk | Owns/approves | Escalates | Escalates | Escalates through Lead |
| Project architecture and technical route | May direct | Observes; does not decide | Owns | Advises/challenges with evidence |
| Work decomposition and moving write scope | May direct | Routes to Lead | Owns; one writable Peer maximum | Owns one delegated scope |
| Candidate verification and acceptance | May override | Treats as evidence; does not accept | Inspects and explicitly accepts/rejects | Supplies evidence; never self-accepts difficult work |
| Paseo room/session lifecycle | May direct | May perform explicit or bounded recovery; prefer Lead route | Manages project agents | Forbidden |
| Directing Peer | Does not normally operate agent protocol | Forbidden while Lead is healthy | Owns | Forbidden |
| Paseo tools delivered | N/A | Enabled | Enabled | Disabled |

## 2. Required Semantic Invariants

### Shared

- **RC-001 Human authority:** Generated Supervisor, Lead, and Peer instructions state that Human retains product goals, priority, material-cost choices, external effects, and irreversible-risk decisions.
- **RC-002 Project protocol:** Every role reads a workspace-local `docs/WORKSPACE_PROTOCOL.md` when present. Local detail may refine workflow but cannot weaken this authority contract.
- **RC-003 Evidence and waiting:** Tests, artifacts, lifecycle states, and completion/error/attention events are evidence. Roles wait on state-changing events rather than repeatedly polling unchanged state.
- **RC-004 Preserve scope:** Every role preserves unrelated work and remains inside granted repository and external-action authority.

### Supervisor

- **RC-101 Faithful routing:** Supervisor preserves Human outcome, requested output, constraints, and approval gates when routing to Lead; added context is clearly separate and cannot rewrite the directive.
- **RC-102 Non-lead boundary:** Supervisor does not edit project work, run project validation, decide technical acceptance, or direct Peer while Lead is healthy.
- **RC-103 Bounded operations:** Supervisor may use the smallest Paseo lifecycle action only for an explicit Human request or bounded room recovery, preserves current ownership, and informs Lead of changes.
- **RC-104 Escalation:** Supervisor sends technical matters to Lead and product/cost/external/irreversible choices to Human.

### Lead

- **RC-201 Technical ownership:** Within Human boundaries, Lead owns project framing, architecture, dependencies, integration, verification, and acceptance.
- **RC-202 Single writer:** Lead assigns each moving write scope to one owner and permits at most one active writable Peer at a time; Lead does not edit that moving scope concurrently.
- **RC-203 Complete brief:** A Peer brief includes bounded outcome, prerequisites, write scope, stable contract/invariants, acceptance evidence, and conditions that reopen the decision.
- **RC-204 Independent judgment:** Lead permits Peer to challenge a premise with `REOPEN_REQUEST`, request an unowned prerequisite with `DEPENDENCY_REQUEST`, or report no safe progress with `BLOCKED`; each signal includes evidence, consequence, and needed decision/dependency.
- **RC-205 Acceptance:** Lead inspects the exact candidate or deterministic snapshot and explicitly accepts or rejects it with a technical reason.
- **RC-206 Independent review:** When material uncertainty warrants review, Lead may dispatch a fresh read-only Peer against an exact stable candidate and bounded question; no dedicated reviewer role or fixed reviewer count is introduced.

### Peer

- **RC-301 Bounded outcome:** Peer owns exactly one Lead-delegated outcome and its proportionate evidence.
- **RC-302 Write/read-only mode:** A writing Peer owns the moving scope; a review Peer remains read-only and inspects only the named candidate/snapshot.
- **RC-303 No orchestration:** Peer does not spawn, manage, coordinate, or infer room topology and receives no Paseo tools.
- **RC-304 Handoff:** A candidate handoff identifies immutable commit or deterministic snapshot, original base, all changed paths, verification performed, and residual risk.
- **RC-305 No self-acceptance:** Peer treats its tests/completion as evidence; Lead alone performs technical acceptance.

## 3. Workspace Protocol Artifact

The installer owns `<paseo-room-home>/room/workspace-protocol.md`. Its generated content must state RC-001 through RC-004 and the authority matrix in concise agent-readable form. Role instructions direct agents to workspace-local `docs/WORKSPACE_PROTOCOL.md` when present; the installed artifact is an operator reference/template and is not linked into role homes.

A workspace-local protocol may add repository conventions, narrower write scopes, validation commands, or escalation details. It must not grant Peer orchestration, transfer Lead acceptance to Peer/Supervisor, allow multiple writable Peers, or transfer Human decisions to an agent.

## 4. Codex Overlay Contract

All Phase 1 role homes are generated from the canonical Codex config, then enforce this allowlist:

| Field | Supervisor | Lead | Peer |
|---|---|---|---|
| `model` | `gpt-5.6-sol` | `gpt-5.6-sol` | `gpt-5.6-sol` |
| `model_reasoning_effort` | `medium` | `medium` | `medium` |
| `sandbox_mode` | `danger-full-access` | `danger-full-access` | `danger-full-access` |
| `approval_policy` | `never` | `never` | `never` |
| `model_instructions_file` | Managed shared model instructions | Same | Same |
| `developer_instructions` | RC-101–RC-104 plus shared clauses | RC-201–RC-206 plus shared clauses | RC-301–RC-305 plus shared clauses |

The generator also enforces the native-agent disable fields and generated model catalog defined in the parent design. `approvals_reviewer` and all canonical fields outside the explicit allowlist remain inherited unless required for a future compatibility fix. Any change to model, sandbox, approval, or role authority is a design/contract change and requires repository-owner approval.

`danger-full-access` and `approval_policy = "never"` preserve the characterized agent operating mode; they do not create a sandbox or weaken the role authority above. Peer's inability to orchestrate is enforced separately by daemon `paseoTools.enabled = false` and instruction RC-303.

## 5. Contract Tests

- Parse every generated role config and assert the exact overlay table plus native-agent-disable fields.
- Assert each role's generated developer instructions contains every applicable RC ID's semantic clause.
- Reject instructions that grant Supervisor project acceptance/direct Peer control, grant Peer orchestration/self-acceptance, permit multiple writable Peers, or transfer Human-owned decisions.
- Assert the workspace protocol includes RC-001–RC-004, single-writer ownership, Lead acceptance, Peer challenge signals, and event-driven waiting.
- Assert role-specific instructions and workspace protocol do not contradict the Paseo provider policy matrix.
- Tests compare structured clauses/required concepts, not copied reference prose.

## 6. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-09 | Bytes | Created Active clean-room compatibility contract to pin REQ-007 semantics and Phase 1 Codex overlays. |
