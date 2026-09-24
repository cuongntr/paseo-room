# Room Runtime Panel — UX Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Scope | The runtime plugin's client: the Room runtime surface and workspace panel, and the Room attention and Room seats settings screens |
| Governing | [Attention delta](runtime-coordination-attention.md) §8.3–§8.4; [Runtime Coordination Technical Design](runtime-coordination.md) §8.1 |
| Behaviour change | None — the panel reads and calls the same RPCs; three read fields are added (§6) |

## 1. Who uses it and for what

A single operator — the Human — runs one room across several repositories from the Paseo app,
usually on a wide screen and sometimes on a phone. The panel serves five jobs, in this order of
frequency:

1. **Is anything stuck, or waiting for me?** Attention items across every project, most urgent
   first, each with a way to reach the agent concerned.
2. **What is each project doing?** Which Lead, how many Peers are working, who supervises it, and
   when something last happened.
3. **Jump to an agent.** From any seat, straight into its Paseo conversation.
4. **Set up the room.** Start a Supervisor, start a project Lead under a Supervisor, and move a
   project under a Supervisor. This is rare, deliberate and error-prone, so it is guided.
5. **Inspect the runtime record.** Assignments, isolated writers, findings and recovery. This is
   rare and done by someone who already knows why they are looking.

## 2. What was wrong

- The room and the runtime record were two unrelated lists. The same repository appeared twice,
  once as a path.
- There was no hierarchy. Raw absolute paths and agent ids carried the most visual weight, and
  status was plain words.
- Forms opened inline in the middle of the page, results appeared as text at its bottom, and a
  failed action looked the same as a successful one.
- The Trust text, which is read once, took more room than the projects, which are read constantly.
- Assignment detail was a JSON dump.
- There was no route from a seat to its agent.
- The settings screens used ad-hoc chips and fields instead of the host's settings controls, so
  they looked foreign next to Paseo's own pages.

## 3. Principles

- **Attention first, quiet when quiet.** The panel leads with what needs the Human. When nothing
  does, a single line says so.
- **One project, one place.** A repository appears once, and its runtime record lives inside it.
- **Names over identifiers.** Show titles and repository names, and paths with `~`. Ids appear only
  in detail views, where they can be copied.
- **Status is visual.** A coloured dot or pill, with the word beside it, so it is never colour alone.
- **Guided forms in modals.** Each field has a label and a hint, and errors appear on the field
  they concern. The primary action is disabled until the form can succeed, and shows its progress.
  Every outcome is confirmed with a toast.
- **Look like Paseo.** Use the host's theme tokens, Lucide icons, `Modal`, `useToast`, `TextInput`
  and the Settings controls. Keep a centred column no wider than 760 px, and full width with 12 px
  gutters when compact.
- **Destructive means deliberate.** Discarding work or abandoning an assignment asks for a reason
  in a confirmation modal.

## 4. Information architecture

```text
Room (surface root)                         Project (pushed)                  Assignment (pushed)
├─ header: summary · New project · ⚙         ├─ header: name · status · ~/path  ├─ header: id · state
├─ Needs attention (only when non-empty)     ├─ Supervisor (change, open)       ├─ Brief
├─ Projects (row per project → Project)      ├─ Seats (Lead → Peers, open)      ├─ Peer (open)
├─ Supervisors (row per Supervisor, open,    ├─ Attention (this project)        ├─ Evidence
│   + New Supervisor)                        └─ Runtime record (health, writer, ├─ Worktree / lease
└─ About the runtime (collapsed)                assignments → Assignment,       └─ Operator recovery
                                                isolated writers, findings,
                                                recovery)
```

The **workspace panel** opens straight onto the project of its workspace, when that workspace
belongs to an observed project, and falls back to Room otherwise. Row order:

- projects: needing attention, then working, then idle, then alphabetical;
- attention items: page, then now, then digest, then newest first.

## 5. Screens and forms

- **Needs attention row.** Level icon (page: octagon, danger; now: triangle, warning; digest:
  info, muted), then `project — text` in two lines at most, then a meta line with kind, age and
  recipient (or *for you*). Actions: **Open** (the subject agent) and 👍/👎 feedback with a
  selected state.
- **Project row.** Status dot, then the name, then a meta line such as `Lead idle · 2 Peers
  working · 5 min ago`. On the right, a Supervisor pill (neutral) or an amber *No supervisor* pill,
  and a chevron.
- **Supervisor row.** Name, `Watching N projects`, a state pill and **Open**. A final row offers
  *New Supervisor*.
- **Empty room.** A setup card: *1 Start a Supervisor → 2 Start a project*, with both buttons.
- **New Supervisor (modal).**
  - *Agent* is a segmented control over the room's Supervisor providers.
  - *Folder* has the placeholder `~/room-desk` and the hint *An existing folder outside every
    repository — the runtime creates none*; `~` is accepted.
  - *Name* is optional, with the placeholder *Room Supervisor*.
  - **Start Supervisor** is the primary action.
- **New project (modal, two steps).**
  - *Repository*: a folder field and **Check**, which shows a checklist:
    - Git repository;
    - has a commit (a warning, not a blocker);
    - workspace protocol (informational);
    - no Lead yet (a blocker, with *Open Lead* and *Assign a Supervisor instead*).
  - *Lead*: a Supervisor radio list (or a callout with *New Supervisor* when there is none), an
    *Agent* segmented control, and *First directive* (multiline, optional, sent verbatim).
  - **Start Lead** is the primary action.
- **Assign Supervisor (modal).** A radio list of live Supervisors, plus *No assignment (use the
  Lead's parent)* when one was assigned. **Assign** is the primary action.
- **Settings › Room attention.** Built from host Settings controls:
  - *Letters*: a switch, plus selects with sensible steps for each threshold.
  - *Attention sensor*: a mode select, endpoint and model inputs with an **Apply** action, the
    mask switch, *Allow sending to <host>* (hidden for loopback), and assist for `lead-turn-v1`.
  - *Sensor key*: its state, a secure input, and **Store** / **Remove**.
  - *Status*.
  - An egress callout while the sensor sends off the machine.
- **Settings › Room seats.** Host Settings rows, one per seat, with an account line and a state
  pill, and **Refresh** in the section header.

## 6. Data the panel needs

`runtime.room` adds these read fields:

- `displayRoot` (the home directory as `~`);
- for incidents, `openedAt` (ISO), `projectKey` and `subjects`;
- for seats, `lastTurnEndedAt` (ISO);
- for Supervisors, `portfolio` (a count);
- for projects, `runtime` — `{ projectId, health, assignments, active, findings }` when a runtime
  ledger exists for the same Git common directory.

`runtime.start-supervisor` and `runtime.start-project` accept `~/` paths. No RPC changes behaviour.

## 7. Accessibility and resilience

- Every icon-only control has an accessibility label.
- Status is never carried by colour alone.
- Touch targets are at least 32 px.
- Loading shows a spinner with text, and the last good data stays on screen while the panel
  refreshes.
- An unavailable runtime shows an error card with its recovery action and **Retry**.
- Actions that depend on host navigation are hidden on hosts that lack it.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-24 | Bytes | Created from the operator's request to redesign the panel: attention-first information architecture, project-centred navigation, guided modal forms, host Settings controls for the settings screens. |
