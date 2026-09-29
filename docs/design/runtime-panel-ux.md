# Room Runtime Panel — UX Design

| Field | Value |
|---|---|
| Status | Active |
| Owner | Repository owner |
| Scope | The runtime plugin's client: the Room runtime surface and workspace panel, and the Room attention and Room seats settings screens |
| Governing | [Attention delta](runtime-coordination-attention.md) §8.3–§8.4; [Runtime Coordination Technical Design](runtime-coordination.md) §8.1 |
| Behaviour change | None — the panel reads and calls the same RPCs; read fields are added for the panel alone (§6) |

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

A review in live use on 2026-09-29, with five projects and 139 finished assignments in one, found
the panel showing structure more than what was happening:

- A project's finished assignments listed the five *oldest*, since the ledger keeps creation order,
  and no assignment row said when anything happened.
- Every project had the same grey dot, so idle, asleep and seatless projects looked alike, and a
  *Supervisor* pill repeated on every row said only that one existed.
- A seatless project sat among live ones with the same weight, and a *No supervisor* warning stayed
  amber on a project with nothing in flight.
- Runtime vocabulary reached the main path: *Writer in the Lead's workspace*, *Live facts are
  fresh*, assignment ids in lists, `lead-turn-v1`, `POST {state, model, questions}`.
- Nothing said what had happened lately, in a project or to the letters a Supervisor received.
- The settings screens followed the code: the sensor's mode came before its connection, and the
  shadow evaluation that justifies *Assist* sat at the bottom. Room seats was not reachable from the
  panel.

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
- **Say what happened, and when.** Lists are newest first and carry a time; a project and an
  assignment each show their recent steps with who took them.
- **Colour only the exception.** A healthy record, an accepted assignment and a watched project draw
  no pill; health, a writer in the Lead's checkout, a missing Supervisor with work in flight and a
  rejected assignment do.
- **Settings follow the order of setup**, and put the evidence for a switch beside it.

## 4. Information architecture

```text
Room (surface root)                         Project (pushed)                   Assignment (pushed)
├─ header: summary · 🔔 · 👥 · Add repository ├─ header: name · ~/path · status    ├─ header: gist · kind · where · id
├─ Needs attention (only when non-empty)     ├─ Watched by <Supervisor> (Open,   │   · state
├─ Projects (one line each → Project;        │   Change) or No Supervisor        ├─ Brief (with created, settled)
│   inactive ones folded into one line)      ├─ Needs attention (this project)   ├─ Peer (open)
├─ Supervisors (row per Supervisor, open,    ├─ Seats (Lead → Peers, open;       ├─ Evidence
│   + New Supervisor)                        │   Replace Lead in its header;     ├─ History
└─ How the room runtime works (modal)        │   Start Lead when none)           └─ Operator recovery
                                             ├─ Writer / findings (only if any)
                                             ├─ Recent activity (→ Assignment)
                                             ├─ Assignments: Open | Finished by
                                             │   day (→ Assignment)
                                             └─ Isolated writers (reclaim, close)
```

The **workspace panel** opens straight onto the project of its workspace, when that workspace
belongs to an observed project, and falls back to Room otherwise. Row order:

- projects: needing attention, then working, idle and asleep, the most recently active first within
  each, then alphabetical; projects with no live seat fold into one *inactive* line at the end;
- attention items: page, then now, then digest, then newest first;
- open assignments: the most recently updated first, undispatched drafts last;
- finished assignments: the most recently settled first, grouped by local day, twenty at a time;
- recent activity: newest first, six shown, up to thirty on *Show more*.

## 5. Screens and forms

- **Needs attention row.** Level icon (page: octagon, danger; now: triangle, warning; digest:
  info, muted), then `project — text` in two lines at most, then a meta line with kind, age and
  recipient (or *for you*). Actions: **Open** (the subject agent) and 👍/👎 feedback with a
  selected state; a `context-high` item also offers **Replace Lead…** for its Lead.
- **Room header.** `N projects · N working · all quiet` (or *N need a look*), counting projects
  with a live seat; the bell opens *Room attention*, the people icon *Room seats*, and **Add
  repository** is a secondary button, since adding one is rare.
- **Project row.** A status mark whose shape carries the status — a triangle needs a look, a haloed
  dot works, a dot is idle, a ring is asleep (every live seat's session closed; opening one or a
  message resumes it) — then the name and one summary line such as `Lead idle · 1 of 2 Peers
  working · 3 open · 1 waiting on Lead · 1 permission waiting`. *Open* counts the runtime
  assignments not yet decided, drafts included, as the project's *Open* tab does, and *waiting on
  Lead* those handed back, asking, or stopped. On the
  right: an incident count, *replacing Lead* while a replacement is open (amber when it waits on
  you), the Lead's *context N%* past its mark, an amber *No Supervisor* only while work is in flight
  (otherwise the summary ends *no Supervisor*), the Supervisor's name only when the room has more
  than one, when it last did something, and a chevron. The path shows only when two projects share
  a name. Projects with no live seat fold into *N inactive projects*, unless a Lead replacement is
  open or a dispatched assignment is still undecided: those stay in the list, as *No live seats · 1
  open*. A leftover draft alone does not keep a project in the list.
- **Supervisor row.** Name, `Watches cmdb, gitops, paseo-beads` (three names, then `+N`), its folder
  and last compaction, a context bar, a state pill and **Open**. The section header offers *New
  Supervisor*.
- **Seat row** (a project's Lead → Peer tree). The seat's name, then `role · agent · model ·
  thinking <option>` as Paseo reports them, any waiting permissions, then where it works — *Worktree
  on paseo-room/asg_… · ~/.paseo/worktrees/…* or *Main checkout on main* (*at a detached HEAD* when
  HEAD names no branch) — then the last turn and last compaction, a context bar, a state pill and
  **Open**. The role is left out of the second line when the seat's title ends with it, as
  `cmdb — Lead` does. The main checkout is the
  project's own folder, so only a worktree names its path. A runtime-dispatched Peer is named `<Disposition> · <outcome gist> · <assignment id>`, so
  the tree says what each Peer is doing without opening it. The Seats header offers **Replace
  Lead…** for the project's Lead while no replacement is open; it sits beside the rows rather than in
  one, because pressing a row opens its agent.
- **Context bar** (seat and Supervisor rows). A short bar filled to the seat's context percent, with
  its percent beside it and a tick at its role's rotation mark (else its compact mark), from Paseo's
  figure for the seat's latest model call ([seat context delta](runtime-coordination-seat-context.md)
  K-D1). It turns amber past the rotation mark and red past a compact mark that reaches the seat (a
  Claude seat whose window the mark fits); a Lead past its mark also shows a *context N%* pill on its
  project's row. No bar while Paseo reports no figure.
- **Context line** (the role pill). `context 31% · last compacted 2026-09-26 14:05 (auto, at 498k)`
  — the compaction's time rather than its age, so the pill is not redrawn every minute.
- **Project header.** Name, `~/path`, a status pill, and one line under it: *Watched by
  <Supervisor> · assigned by you* (or *· it opened the Lead*) with **Open** and **Change…**. A project
  with no Supervisor shows a callout with **Assign a Supervisor**, amber while work is in flight and
  muted otherwise.
- **Runtime record.** Nothing while it is healthy and no writer holds the Lead's checkout. A writer
  there shows an accent callout, *<assignment> writes in the Lead's checkout*, with **Open
  assignment**; findings show under *Findings · runtime <health>* with **Run recovery**; *Paseo not
  reached yet — live facts may be stale* shows as one muted line.
- **Recent activity.** The project's latest major steps, newest first: dispatched, handed back (with
  its commit), a Peer's question, a permission waiting, a missing report, rework, a gate's result, a
  scope overrun, accepted, rejected or abandoned, a lease taken over, a failure or an uncertain
  outcome. Each row has a toned icon, the step, the assignment it belongs to, its time (`14:02`,
  `Yesterday 23:40`) and who took it (you, Lead, Peer, Supervisor or the runtime); a row opens its
  assignment. Six show, up to thirty on *Show more*.
- **Assignments.** A segmented control, *Open N | Finished N*, opening on *Open* when anything is
  open. A row names the assignment by its outcome's gist (48 characters, at a word boundary), then
  `kind · read-only | worktree | main checkout` (*writable* until dispatch decides where), then
  *updated 5 min ago* when open, or the settling time and *took 42 min* when finished. Its state
  shows as a pill in plain words (*handed back*, *asked a question*, *working*…) except *accepted*,
  which is a muted check. Finished ones are grouped under *Today*, *Yesterday*, `Sat 26 Sep`…,
  twenty at a time with *Show 20 more*.
- **Assignment screen.** The gist as its title, `Engineer · worktree` under it, and its state. The
  brief lists outcome, the assignment id (selectable), scope, exclusions, acceptance, gate, base
  commit, when it was created and when it settled with how long it took. *Peer* says the agent and
  model, the turn when past the first, and whether its session is open or archived; *Evidence* names
  the gate by its command, *passed* or *failed*. *History* lists every step the panel names, oldest first, with its time
  and who took it.
- **Isolated writers.** Each lease and kept worktree is named by its assignment's gist, then its
  branch and scope (*one at a time: …* for serial-only paths), then *Peer live · lease held* and
  *taken over N×* after a reclaim.
- **No Lead.** A project with Peers but no live Lead shows *No Lead runs this project* with **Start
  Lead**; a project whose seats are all archived offers **Start Lead** in its empty Seats card. While
  a replacement waits to be finished, both offer **Finish replacing Lead** instead.
- **Lead replacement in progress.** Above the Seats card, a callout says where it stands (*writing
  its handoff*, *ready for your review*, *archived; successor not started*) with **Show progress**,
  **Review handoff** or **Finish replacing Lead**, and why it stopped when it did. A replacement that
  failed stays for a day in red, with its reason, **Try again** and **Dismiss**.
- **Replace Lead (modal, three steps;** [seat context delta](runtime-coordination-seat-context.md)
  §8.3**).**
  - *Why*: a reason (*Context is high*, *New contract*, *Other*), an optional note to the Lead, and
    the preflight: its blockers, its notes, and each seat the Lead opened with what Paseo's archive
    does to it (archived with the Lead, or detached and kept). **Ask the Lead for a handoff** is
    disabled while anything blocks.
  - *Handoff*: a spinner while the Lead writes, which may be closed; then the handoff in an editable
    monospace field with its size against 64 KB. **Cancel replacement** and **Continue**.
  - *Confirm*: what is archived, what is kept, the new Lead's agent and model, its Supervisor, and
    that it verifies the handoff before acting outside the repository. **Replace Lead**, then **Open
    new Lead**. Reopened on a replacement that stopped after the archive, the modal shows this step
    with **Finish replacing Lead** and **Cancel replacement**.
- **Empty room.** A setup card: *1 New Supervisor → 2 Add repository*, with both buttons.
- **New Supervisor (modal).**
  - *Agent* is a segmented control over the room's Supervisor providers.
  - *Folder* has the placeholder `~/room-desk` and the hint *An existing folder outside every
    repository — the runtime creates none*; `~` is accepted.
  - *Name* is optional, with the placeholder *Room Supervisor*.
  - **Start Supervisor** is the primary action.
- **Add repository (modal, two steps).**
  - *Repository*: a folder field and **Check folder**, which shows a checklist:
    - Git repository;
    - has a commit (a warning, not a blocker);
    - workspace protocol (informational);
    - no Lead yet (a blocker, with *Open Lead* and *Assign a Supervisor instead*).

    Below the field, up to six observed projects with no live Lead, each checked with one tap.
  - *Lead*: a Supervisor radio list (or a callout with *New Supervisor* when there is none), an
    *Agent* segmented control, and *First directive* (multiline, optional, sent verbatim).
  - **Start Lead** is the primary action.
- **Start Lead (modal).** The *Lead* step alone, for a project the room already observes: its folder
  is fixed and its Supervisor preselected. It calls `runtime.start-project` like *Add repository*.
- **Supervisor pickers** (Add repository, Start Lead, Assign Supervisor). Running Supervisors first,
  then those whose session is closed, each with its agent, state, folder and portfolio. The default
  is the project's current Supervisor, else the first running one.
- **Assign Supervisor (modal).** The picker, plus *No assignment (use the Lead's parent)* when one
  was assigned. **Assign** is the primary action.
- **Settings › Room attention.** Built from host Settings controls, in this order:
  - *Letters to Supervisors*: the switch, and *Last 24 hours* — letters sent by level, failures,
    incidents opened, Lead turns by what was decided for them, and the ratings given (each item's
    latest, whether you or a Supervisor gave it) — read back from the attention log.
  - *When to tell a Supervisor*: permission waiting, Peer result unread, orphaned Peer.
  - *How often*: digest interval, wakes per hour, urgent page hold.
  - *Attention sensor*: the mode, and whether it is ready to send with today's calls, failures and
    tokens, or why not.
  - *Sensor connection*: endpoint and pinned model with **Apply**, then the key's state, a secure
    input, and **Store** / **Remove**.
  - *Sensor privacy*: the mask switch, and *Allow sending to <host>* (for loopback, a line saying
    nothing leaves the machine).
  - *Sensor evaluation*: today's shadow tallies (*Lead turns today — 34 assessed, would record 20,
    digest 10, wake 4*) beside the *Assist Lead turns* switch, and **Refresh**.
  - An egress callout while the sensor sends off the machine.
- **Settings › Room seats.**
  - *Accounts*: host Settings rows, one per seat (`Lead · Claude`), with its account line — email or
    login method, plan, and the organization unless it is only the personal one Claude names after
    the email — and a state pill. When seats sign in as more than one account, each line ends
    *account A*, *account B*…, and a last row says which seats share which. The section header's one
    button says when the accounts were checked (`Checked 11:04`, `Checked Yesterday 23:40`) and
    checks again.
  - *Thinking Lead may choose*: one row per Peer provider, with its model and default in the hint and
    one chip per thinking option Paseo lists for the profile's model
    ([peer-effort delta](runtime-coordination-peer-effort.md)). A lit chip is allowed; the default is
    lit and locked; an option saved for an earlier model shows amber, *not offered now*, to turn
    off. An option that starts agents on its own is not a chip, unless it is the profile's own: the
    hint says it is never offered.
  - *Seat context*: a bar showing the Lead's marks as zones of its context — calm below *report at*,
    amber to *compact at*, red past it — then one select per mark: Lead *report at* and *compact at*,
    Supervisor and Peer *compact at*, each *Off* or 10–95% in 5-point steps. Each hint gives the mark
    in tokens per window: *report at* on a 1M, 272k and 200k model, *compact at* on a 1M and a 200k
    Claude model, and *not applied* where it comes to less than 150k. A notice row says a compact
    mark reaches a Claude seat when its session next opens, while Codex and Pi keep their own
    compaction.
- **Role pill (every seat's composer).** Paseo 0.9 draws a tab icon only for a built-in or
  plugin-registered provider, so a room seat's tab shows the generic agent icon, and a plugin cannot
  decorate tabs. Instead, each live seat gets a composer pill that names its role: *Supervisor*
  (eye, accent), *Lead* (compass) or *Peer* (wrench). The agent keeps its own name. The pill's
  popover shows:
  - for a Lead: the project and its Supervisor;
  - for a Peer: the project, its Lead and its Supervisor;
  - *Works in*, for a Lead or a Peer: the same checkout line as its seat row;
  - for a Supervisor: the projects it watches and its folder;
  - *Runs*: the model and thinking option the seat runs with, when Paseo reports them;
  - *Context*: the context line, when Paseo reports a figure;
  - **Open Room runtime** in every case.

  The client re-reads `runtime.room` every 20 s, and adds, redraws or removes a pill only when that
  seat's pill content changes. A seat outside any Paseo workspace gets no pill.

## 6. Data the panel needs

`runtime.room` adds these read fields:

- `displayRoot` (the home directory as `~`);
- for incidents, `openedAt` (ISO), `projectKey` and `subjects`;
- for seats, `lastTurnEndedAt` (ISO);
- for Supervisors, `portfolio` (a count);
- for seats, `workspaceId` (the Paseo workspace, which the role pill targets);
- for seats, `model` and `thinking`, read from Paseo's agent record for display only;
- for projects, `runtime` — `{ projectId, health, assignments, active, findings }` when a runtime
  ledger exists for the same Git common directory;
- for seats, `context` — `{ used, max, percent, rotateAtPercent, compactAtPercent }` — and
  `compaction` — `{ lastAt, lastAgo, lastTrigger?, lastPreTokens?, seen }` — per the
  [seat context delta](runtime-coordination-seat-context.md) §5.1;
- for seats, `checkout` — `{ root, displayRoot, linked, branch? }` — the checkout the seat works in,
  read from Git at each snapshot and turn end ([attention delta](runtime-coordination-attention.md)
  §4); absent outside Git;
- for projects, `succession` — `{ id, step, fromAgentId, fromTitle, canFinish, canCancel, failure? }`
  — while a Lead replacement is not finished. A project whose last seat that replacement archived
  stays listed.

Replace Lead uses `runtime.succession-preflight`, `-start`, `-status`, `-complete` and `-cancel`
(seat context delta §5.2).

For the panel alone — derived from the ledger or the attention log on each read, and never part of
a seat tool's answer:

- `runtime.project` gives each assignment `createdAt`, `updatedAt`, `settledAt` (when it was
  accepted, rejected or abandoned) and, once dispatched, `isolated` (it took a worktree lease), and
  adds `activity`: the latest thirty major milestones, newest first, each `{ at, assignmentId?,
  label, tone, by, major }`;
- `runtime.assignment` adds the same times and `timeline`, every milestone of that assignment,
  oldest first;
- `runtime.room` gives each project's `runtime` record `undecided` (not yet decided, drafts
  included), `waiting` (open assignments handed back, asking, or stopped) and `lastEventAt`;
- `runtime.attention-status` adds `letters`, the last 24 hours of the attention log tallied: letters
  sent by level, failed, incidents opened, Lead turns by decision, and the latest rating of each
  rated item as `useful` and `noise` counts, `partial` when a day file was too large to read back.
  Only those record types are parsed: a line's time and type are read from its head first.

Their shapes are declared once in `shared/panel.ts`, and the settled states they count by in
`shared/states.ts`, which the runtime's domain reads too. An assignment's *updated* time ignores
notices about it: the runtime telling its Lead something is not the assignment moving.

Milestone phrases are written once, on the server (`server/panel.ts`), so the project's activity and
the assignment's history name a step alike. An assignment's gist comes from `shared/names.ts`, which
also titles its Peer and worktree.

`runtime.start-supervisor` and `runtime.start-project` accept `~/` paths. No RPC changes behaviour.

## 7. Accessibility and resilience

- Every icon-only control has an accessibility label.
- Status is never carried by colour alone.
- Touch targets are at least 32 px.
- Loading shows a spinner with text, and the last good data stays on screen while the panel
  refreshes.
- The Room and Project screens redraw each minute even when no data changed, so a relative time such
  as *5 min ago* stays true.
- An unavailable runtime shows an error card with its recovery action and **Retry**.
- Actions that depend on host navigation are hidden on hosts that lack it.

## 8. Revision History

| Date | Author | Change |
|---|---|---|
| 2026-09-24 | Bytes | Created from the operator's request to redesign the panel: attention-first information architecture, project-centred navigation, guided modal forms, host Settings controls for the settings screens. |
| 2026-09-24 | Bytes | Role pill: each seat's composer shows its room role without renaming the agent, because Paseo 0.9 gives custom providers no tab icon. |
| 2026-09-25 | Bytes | Room seats gains *Thinking Lead may choose*, the operator's per-Peer-provider thinking envelope. |
| 2026-09-25 | Bytes | Seat rows and role pills show the model and thinking option each seat runs with; runtime Peers are named by disposition, outcome gist and assignment id instead of `Peer <id>`. |
| 2026-09-26 | Bytes | Seat context K1: context line on seat rows, the Supervisor row and the role pill; *New project* renamed *Add repository*, offering observed projects without a Lead; *Start Lead* on a project with none; Supervisor pickers list running Supervisors first with state and folder; Room seats gains *Seat context*. |
| 2026-09-27 | Bytes | Seat context K2: **Replace Lead…** in the Seats header and on a `context-high` item, a three-step modal (why and preflight, the handoff to review, confirm), a progress callout on the project and a *replacing Lead* pill on its row, and **Finish replacing Lead** in place of *Start Lead* while a replacement waits. |
| 2026-09-28 | Bytes | Seat rows and role pills say which checkout each Lead and Peer works in — a linked worktree with its branch and path, or the main checkout with its branch — so a worktree Peer can be told apart from one in the Lead's folder. |
| 2026-09-29 | Bytes | Review in live use (§2): one-line project rows with shape-coded status marks and an *asleep* state, inactive projects folded, colour only for exceptions; a Supervisor line in the project header; the runtime record shown only when something is wrong; recent activity; assignments newest first with times, *Open / Finished* and finished ones by day; an assignment screen titled by its gist with its history; context bars; Room attention reordered by setup with a 24-hour letter tally; Room seats with account letters and thinking chips, reachable from the panel. Panel-only read fields (§6). |
| 2026-09-29 | Bytes | *Seat context* hints give *report at* in tokens too, and say *not applied* where a mark comes to less than 150k on a window (seat context delta K-D2, amended). |
