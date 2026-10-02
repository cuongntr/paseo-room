/**
 * What the panel reads from `runtime.room` (docs/design/runtime-panel-ux.md §6), and the few
 * derivations every screen shares: a project's status, its summary line, and the order of things.
 */
import { MAX_HANDOFF_BYTES, utf8Bytes } from '../shared/limits.js';
import { outcomeGist } from '../shared/names.js';
import type { LetterTally } from '../shared/panel.js';
import { SETTLED_STATES } from '../shared/states.js';
import { formatTokens } from '../shared/seat-context.js';
import { ago, clockTime, dayLabel } from './time.js';
import type { Tone } from './tone.js';

export interface SeatView {
  readonly agentId: string; readonly role: string; readonly provider: string; readonly title: string | null; readonly state: string;
  readonly model?: string | null; readonly thinking?: string | null;
  readonly cwd: string; readonly displayCwd: string; readonly workspaceId?: string | null; readonly parentAgentId: string | null; readonly pendingPermissions: number;
  readonly checkout?: { readonly root: string; readonly displayRoot: string; readonly linked: boolean; readonly branch?: string };
  readonly lastTurn?: { readonly outcome: string; readonly endedAgo: string; readonly endedAt: string };
  readonly context?: { readonly used: number; readonly max: number; readonly percent: number; readonly rotateAtPercent: number | null; readonly compactAtPercent: number | null };
  readonly compaction?: { readonly lastAt: string; readonly lastTrigger?: string; readonly lastPreTokens?: number; readonly seen: number };
}

export interface IncidentView {
  readonly id: string; readonly kind: string; readonly level: string; readonly text: string; readonly summary?: string; readonly count: number; readonly recipient: string;
  readonly projectKey: string; readonly subjects: readonly string[]; readonly openedAt: string; readonly feedback?: string;
}

export interface RuntimeRecord {
  readonly projectId: string; readonly health: string; readonly assignments: number; readonly active: number; readonly findings: number;
  /** Assignments not yet decided, drafts included, as the project's *Open* tab counts them. */
  readonly undecided?: number;
  /** Open assignments waiting on their Lead: a handback, a question, or a Peer that stopped. */
  readonly waiting?: number;
  /** The ledger's latest event. */
  readonly lastEventAt?: string;
}

/** A Lead replacement not yet finished (seat context delta §5.1). */
export interface SuccessionSummary {
  readonly id: string; readonly step: string; readonly fromAgentId: string; readonly fromTitle: string | null;
  readonly canFinish: boolean; readonly canCancel: boolean; readonly failure?: { readonly code: string; readonly message: string };
  /** A Supervisor started it at the Lead's rotation mark and reviews the handoff (seat context delta K-D9). */
  readonly startedBy?: 'supervisor';
}

export interface ProjectView {
  readonly key: string; readonly name: string; readonly root: string; readonly displayRoot: string; readonly git: boolean; readonly decidedBy: string;
  readonly supervisor?: SeatView; readonly seats: readonly SeatView[]; readonly incidents: readonly IncidentView[]; readonly runtime?: RuntimeRecord;
  readonly succession?: SuccessionSummary;
}

export interface SupervisorView extends SeatView { readonly portfolio: number }

export interface RoomView {
  readonly started: boolean;
  readonly projects: readonly ProjectView[];
  readonly supervisors: readonly SupervisorView[];
  readonly panelIncidents: readonly IncidentView[];
  readonly providers: readonly { readonly providerId: string; readonly agent: string; readonly role: string }[];
  /** Present only while a bridge call has waited a minute or more: the runtime is not answering its seats. */
  readonly spool?: { readonly unanswered: number; readonly oldestSeconds: number; readonly expired: number };
}

/**
 * Where a project stands: `asleep` when every live seat's session is closed (a message or opening it
 * resumes it), `inactive` when it has no live seat at all.
 */
export type ProjectStatus = 'attention' | 'working' | 'idle' | 'asleep' | 'inactive';

export const seatName = (seat: SeatView): string => seat.title ?? `${seat.role} ${seat.agentId.slice(0, 8)}`;

/** What a seat runs on, as Paseo reports it — `claude-opus-5-5 · thinking medium` — or '' when unknown. */
export const launchLabel = (seat: Pick<SeatView, 'model' | 'thinking'>): string =>
  [seat.model ?? '', seat.thinking === undefined || seat.thinking === null ? '' : `thinking ${seat.thinking}`].filter(part => part !== '').join(' · ');

/**
 * Where a seat works — `worktree on paseo-room/asg_… · ~/.paseo/worktrees/…` or `main checkout on
 * main` — or undefined outside Git. The main checkout is the project's own folder, so only a
 * worktree names its path.
 */
export function checkoutLine(seat: Pick<SeatView, 'checkout'>): string | undefined {
  const { checkout } = seat;
  if (checkout === undefined) return undefined;
  const where = checkout.linked ? 'worktree' : 'main checkout';
  const head = checkout.branch === undefined ? `${where} at a detached HEAD` : `${where} on ${checkout.branch}`;
  return checkout.linked ? `${head} · ${checkout.displayRoot}` : head;
}

type SeatContext = NonNullable<SeatView['context']>;

/** A seat's context toned at its role's rotation mark (warning) and at a compact mark that reaches it (danger). */
export function contextTone(context: SeatContext): Tone {
  const past = (mark: number | null): boolean => mark !== null && context.percent >= mark;
  return past(context.compactAtPercent) ? 'danger' : past(context.rotateAtPercent) ? 'warning' : 'neutral';
}

/**
 * A seat's context as one line — `context 31% · last compacted 3 h ago (auto, at 498k)` — with its
 * tone; undefined while Paseo reports no figure. `clock` names the compaction's time instead of its
 * age, for a view redrawn only when its content changes.
 */
export function contextLine(seat: Pick<SeatView, 'context' | 'compaction'>, when: 'ago' | 'clock' = 'ago'): { readonly text: string; readonly tone: Tone } | undefined {
  const { context, compaction } = seat;
  if (context === undefined) return undefined;
  const parts = [`context ${String(context.percent)}%`];
  if (compaction !== undefined) {
    const how = [compaction.lastTrigger, compaction.lastPreTokens === undefined ? undefined : `at ${formatTokens(compaction.lastPreTokens)}`].filter(part => part !== undefined);
    const moment = when === 'clock' ? clockTime(compaction.lastAt) : ago(compaction.lastAt);
    parts.push(`last compacted ${moment}${how.length === 0 ? '' : ` (${how.join(', ')})`}`);
  }
  return { text: parts.join(' · '), tone: contextTone(context) };
}

/**
 * Supervisors as a picker lists them: running ones before those whose session is closed, then by
 * name; the default is `preferred` when it is listed, else the first that runs.
 */
export function supervisorChoices(supervisors: readonly SupervisorView[], preferred?: string): { readonly choices: readonly SupervisorView[]; readonly initial: string | undefined } {
  const choices = [...supervisors].sort((a, b) => Number(a.state === 'closed') - Number(b.state === 'closed') || seatName(a).localeCompare(seatName(b)));
  const initial = choices.find(entry => entry.agentId === preferred)?.agentId ?? choices[0]?.agentId;
  return { choices, initial };
}

/** What a Supervisor watches: `watching 2 projects`, or that it watches none yet. */
export const watchingLabel = (portfolio: number): string =>
  (portfolio === 0 ? 'not watching any project yet' : `watching ${String(portfolio)} project${portfolio === 1 ? '' : 's'}`);

/** A Supervisor as a picker describes it: whether it runs, where it stands, what it watches. */
export const supervisorSummary = (entry: SupervisorView): string =>
  [providerLabel(entry.provider), STATE_LABEL[entry.state] ?? entry.state, entry.displayCwd, watchingLabel(entry.portfolio)].join(' · ');

/** Whether a live Lead runs the project. */
export const hasLead = (project: ProjectView): boolean => project.seats.some(seat => seat.role === 'lead');

/** Observed projects with no live Lead: each can take one without retyping its folder. */
export const leadlessProjects = (room: Pick<RoomView, 'projects'>): readonly ProjectView[] =>
  room.projects.filter(project => !hasLead(project)).sort((a, b) => a.name.localeCompare(b.name));

/** `text` with its first letter capitalised, to start a sentence. */
export const sentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const AGENT_LABELS: Readonly<Record<string, string>> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };
export const agentLabel = (agent: string): string => AGENT_LABELS[agent] ?? agent;

export function projectStatus(project: ProjectView): ProjectStatus {
  if (project.incidents.length > 0 || (project.runtime?.health ?? 'healthy') !== 'healthy' || waitsOnHuman(project.succession)) return 'attention';
  if (project.seats.some(seat => seat.state === 'running' || seat.state === 'permission')) return 'working';
  // A replacement in progress, or dispatched work still undecided, keeps a project whose seats are all archived in view.
  if (project.seats.length === 0) return project.succession === undefined && (project.runtime?.active ?? 0) === 0 ? 'inactive' : 'idle';
  return project.seats.every(seat => seat.state === 'closed') ? 'asleep' : 'idle';
}

export const STATUS_TONE: Readonly<Record<ProjectStatus, Tone>> = { attention: 'warning', working: 'success', idle: 'muted', asleep: 'muted', inactive: 'muted' };
export const STATUS_LABEL: Readonly<Record<ProjectStatus, string>> = { attention: 'needs a look', working: 'working', idle: 'idle', asleep: 'asleep', inactive: 'no live seats' };

/** A project's undecided runtime assignments, drafts included. */
export const openCount = (project: ProjectView): number => project.runtime?.undecided ?? project.runtime?.active ?? 0;

/** Whether a project has work in flight: a seat working, something to look at, or an open assignment. */
export const hasWork = (project: ProjectView): boolean =>
  ['attention', 'working'].includes(projectStatus(project)) || (project.runtime?.active ?? 0) > 0;

export function stateTone(state: string): Tone {
  if (state === 'running') return 'success';
  if (state === 'permission') return 'warning';
  if (state === 'archived' || state === 'closed') return 'muted';
  return 'neutral';
}

export const STATE_LABEL: Readonly<Record<string, string>> = { running: 'working', idle: 'idle', permission: 'needs permission', closed: 'asleep', archived: 'archived' };

/** "Claude" for `claude-lead/claude-opus-5`. */
export const providerLabel = (provider: string): string => agentLabel(provider.split('/')[0]?.split('-')[0] ?? provider);

/**
 * A project in one line — `Lead idle · 1 of 2 Peers working · 3 open · 1 waiting on Lead` — naming a
 * missing Supervisor only while nothing else would.
 */
export function projectSummary(project: ProjectView): string {
  const parts: string[] = [];
  if (project.seats.length === 0) {
    parts.push('No live seats');
  } else {
    const leads = project.seats.filter(seat => seat.role === 'lead');
    const peers = project.seats.filter(seat => seat.role === 'peer');
    const working = peers.filter(seat => seat.state === 'running' || seat.state === 'permission').length;
    const [lead] = leads;
    parts.push(lead === undefined ? 'No Lead' : leads.length > 1 ? `${String(leads.length)} Leads` : `Lead ${STATE_LABEL[lead.state] ?? lead.state}`);
    if (peers.length > 0) parts.push(working > 0 ? `${String(working)} of ${String(peers.length)} Peer${peers.length === 1 ? '' : 's'} working` : `${String(peers.length)} Peer${peers.length === 1 ? '' : 's'} idle`);
  }
  const open = openCount(project);
  const waiting = project.runtime?.waiting ?? 0;
  if (open > 0) parts.push(`${String(open)} open`);
  if (waiting > 0) parts.push(`${String(waiting)} waiting on Lead`);
  const permissions = project.seats.reduce((sum, seat) => sum + seat.pendingPermissions, 0);
  if (permissions > 0) parts.push(`${String(permissions)} permission${permissions === 1 ? '' : 's'} waiting`);
  if (project.seats.length === 0 && open === 0 && project.runtime !== undefined) parts.push(`${String(project.runtime.assignments)} assignment${project.runtime.assignments === 1 ? '' : 's'} recorded`);
  if (project.seats.length > 0 && project.supervisor === undefined && !hasWork(project)) parts.push('no Supervisor');
  return parts.join(' · ');
}

/** The newest thing a project did: a seat's turn end or a runtime event, as ISO. */
export function lastActivity(project: ProjectView): string | undefined {
  return [...project.seats.map(seat => seat.lastTurn?.endedAt), project.runtime?.lastEventAt]
    .filter((value): value is string => value !== undefined).sort().at(-1);
}

const STATUS_RANK: Readonly<Record<ProjectStatus, number>> = { attention: 0, working: 1, idle: 2, asleep: 3, inactive: 4 };
/** Projects needing a look, then working, idle, asleep and inactive; the most recently active first within each. */
export function sortProjects(projects: readonly ProjectView[]): ProjectView[] {
  return projects.map(project => ({ project, rank: STATUS_RANK[projectStatus(project)], last: lastActivity(project) ?? '' }))
    .sort((a, b) => a.rank - b.rank || b.last.localeCompare(a.last) || a.project.name.localeCompare(b.project.name))
    .map(({ project }) => project);
}

/** The names of the projects a Supervisor watches, alphabetically. */
export const watchedProjects = (room: Pick<RoomView, 'projects'>, supervisorAgentId: string): readonly string[] =>
  room.projects.filter(project => project.supervisor?.agentId === supervisorAgentId).map(project => project.name).sort((a, b) => a.localeCompare(b));

/** A short list: `a, b, c` or `a, b, c +2`. */
export function shortList(names: readonly string[], shown = 3): string {
  return names.length <= shown ? names.join(', ') : `${names.slice(0, shown).join(', ')} +${String(names.length - shown)}`;
}

/** Whether a seat's title already says its role as its last part, as `shop — Lead` does; `Fix peer reporting` does not. */
export const titleNamesRole = (seat: Pick<SeatView, 'title' | 'role'>): boolean =>
  seat.title?.split(/\s[—–·-]\s/).at(-1)?.trim().toLowerCase() === seat.role.toLowerCase();

const LEVEL_RANK: Readonly<Record<string, number>> = { page: 0, now: 1, digest: 2 };
export function sortIncidents(incidents: readonly IncidentView[]): IncidentView[] {
  return [...incidents].sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || b.openedAt.localeCompare(a.openedAt));
}

export const LEVEL_STYLE: Readonly<Record<string, { readonly icon: string; readonly tone: Tone; readonly label: string }>> = {
  page: { icon: 'OctagonAlert', tone: 'danger', label: 'Urgent' },
  now: { icon: 'TriangleAlert', tone: 'warning', label: 'Needs a look' },
  digest: { icon: 'Info', tone: 'muted', label: 'FYI' },
};

export const KIND_LABEL: Readonly<Record<string, string>> = {
  'lead-gone-with-work': 'Lead archived with work running',
  'writers-observed': 'Possible concurrent writers',
  'duplicate-lead': 'More than one Lead',
  'permission-waiting': 'Permission waiting',
  'peer-result-unread': 'Peer result unread',
  'turn-failing': 'Repeated failure',
  'peer-orphaned': 'Orphaned Peer',
  'context-high': 'Context past rotation mark',
};

export const ROLE_ICON: Readonly<Record<string, string>> = { supervisor: 'Eye', lead: 'Compass', peer: 'Wrench' };

// ── Lead replacement (seat context delta K-D5, §8.3) ─────────────────────────────────────────────

/**
 * Whether a replacement waits on Human: a handoff to review, a successor to finish, or a failure to
 * see. A Supervisor reviews the handoff of a replacement it started.
 */
export const waitsOnHuman = (succession: SuccessionSummary | undefined): boolean =>
  succession !== undefined && ((succession.step === 'received' && succession.startedBy !== 'supervisor') || succession.step === 'failed' || succession.canFinish);

/** Where a replacement stands, as the project screen says it. */
export function successionHeadline(succession: SuccessionSummary): string {
  const from = succession.fromTitle ?? 'the Lead';
  const bySupervisor = succession.startedBy === 'supervisor';
  switch (succession.step) {
    case 'requested': return `${bySupervisor ? 'The Supervisor is replacing' : 'Replacing'} ${from}: it is writing its handoff`;
    case 'received': return bySupervisor ? `The Supervisor is replacing ${from}: it reviews the handoff` : `Replacing ${from}: its handoff is ready for your review`;
    case 'archived': return `${sentence(from)} is archived; its successor is not started yet`;
    case 'created': return `${sentence(from)} is archived; its successor has not received the handoff yet`;
    case 'failed': return `Replacing ${from} failed`;
    default: return `Replacing ${from}`;
  }
}

/** What Paseo's archive of a Lead does to a seat it opened, as the preflight reports it. */
export interface DescendantView {
  readonly agentId: string; readonly title: string | null; readonly role: string; readonly state: string;
  readonly fate: 'archived-with-lead' | 'detached' | 'kept'; readonly why?: string;
}

export interface SuccessionPreflightView {
  readonly lead: { readonly agentId: string; readonly title: string | null; readonly provider: string; readonly state: string; readonly contextPercent: number | null };
  readonly project: { readonly key: string; readonly name: string; readonly root: string };
  readonly blockers: readonly { readonly code: string; readonly message: string }[];
  readonly notes: readonly string[];
  readonly descendants: readonly DescendantView[];
  readonly supervisor: { readonly agentId: string; readonly title: string | null } | null;
  readonly successor: { readonly provider: string; readonly model: string | null };
}

const FATE_WORDS: Readonly<Record<DescendantView['fate'], string>> = {
  'archived-with-lead': 'archived with the Lead', detached: 'detached, and keeps running', kept: 'keeps running',
};

/** One seat the Lead opened and what happens to it: `Reviewer — detached, and keeps running (open in a tab)`. */
export const fateLine = (seat: DescendantView): string =>
  `${seat.title ?? `${seat.role} ${seat.agentId.slice(0, 8)}`} — ${FATE_WORDS[seat.fate]}${seat.why === undefined ? '' : ` (${seat.why})`}`;

/** A handoff's size against its bound, in UTF-8 bytes as the server counts it: `11.2 KB of 64 KB`. */
export function handoffSize(text: string): { readonly label: string; readonly over: boolean } {
  const bytes = utf8Bytes(text);
  return { label: `${(bytes / 1024).toFixed(1)} KB of ${String(MAX_HANDOFF_BYTES / 1024)} KB`, over: bytes > MAX_HANDOFF_BYTES };
}

// ── Assignments (runtime-panel-ux.md §5) ─────────────────────────────────────────────────────────

/** An assignment as `runtime.project` lists it, with the panel's times. */
export interface AssignmentEntry {
  readonly id: string; readonly kind: string; readonly mode: string; readonly outcome: string; readonly state: { readonly value: string };
  readonly createdAt?: string; readonly updatedAt?: string; readonly settledAt?: string; readonly isolated?: boolean;
}

export const isFinished = (entry: Pick<AssignmentEntry, 'state'>): boolean => (SETTLED_STATES as readonly string[]).includes(entry.state.value);

/** An assignment's name in a list: its outcome, cut to a phrase. */
export const assignmentGist = (entry: Pick<AssignmentEntry, 'outcome'>): string => outcomeGist(entry.outcome);

/**
 * Where an assignment's Peer works: `read-only`, its own `worktree`, or the Lead's `main checkout`;
 * `writable` while it is not dispatched, since dispatch decides.
 */
export function workplace(entry: Pick<AssignmentEntry, 'mode' | 'isolated'>): string {
  if (entry.mode === 'read-only') return 'read-only';
  if (entry.isolated === undefined) return 'writable';
  return entry.isolated ? 'worktree' : 'main checkout';
}

/** Open assignments, the most recently updated first; drafts, not yet dispatched, last. */
export function openAssignments(entries: readonly AssignmentEntry[]): AssignmentEntry[] {
  const draft = (entry: AssignmentEntry): number => (entry.state.value === 'draft' ? 1 : 0);
  return entries.filter(entry => !isFinished(entry)).map((entry, index) => ({ entry, index }))
    .sort((a, b) => draft(a.entry) - draft(b.entry) || (b.entry.updatedAt ?? '').localeCompare(a.entry.updatedAt ?? '') || b.index - a.index)
    .map(({ entry }) => entry);
}

/** Finished assignments, the most recently settled first; without times, the ledger's newest (its last) first. */
export function finishedAssignments(entries: readonly AssignmentEntry[]): AssignmentEntry[] {
  const settled = (entry: AssignmentEntry): string => entry.settledAt ?? entry.updatedAt ?? '';
  return entries.filter(isFinished).map((entry, index) => ({ entry, index }))
    .sort((a, b) => settled(b.entry).localeCompare(settled(a.entry)) || b.index - a.index)
    .map(({ entry }) => entry);
}

/** Consecutive entries grouped under the local day `at` names; entries without a time go under `Earlier`. */
export function byDay<T>(entries: readonly T[], at: (entry: T) => string | undefined, now = Date.now()): { readonly day: string; readonly entries: readonly T[] }[] {
  const groups: { day: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const when = at(entry);
    const day = when === undefined ? 'Earlier' : dayLabel(when, now);
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

// ── Accounts (Settings › Room seats) ─────────────────────────────────────────────────────────────

export interface AccountView {
  readonly providerId: string; readonly role: string; readonly status: string;
  readonly method?: string; readonly email?: string; readonly plan?: string; readonly organization?: string; readonly note?: string;
}

/** A seat's account line: who, plan, and the organization unless it is only the personal one Claude names after the email. */
export function accountLine(seat: AccountView): string {
  if (seat.status === 'signed-out') return 'Not signed in';
  if (seat.status === 'present') return 'Credential file present';
  if (seat.status === 'unknown') return seat.note ?? 'Unknown';
  const personal = seat.email !== undefined && /^(.+)['’]s Organization$/.exec(seat.organization ?? '')?.[1] === seat.email;
  return [seat.email ?? seat.method ?? 'Signed in', seat.plan === undefined ? undefined : sentence(seat.plan), personal ? undefined : seat.organization]
    .filter(part => part !== undefined).join(' · ');
}

const accountKey = (seat: AccountView): string | undefined => (seat.status === 'signed-in' ? seat.email ?? seat.method : undefined);

/**
 * When seats sign in as more than one account, a letter per account in order of first use, so the
 * split is visible at a glance; empty when every seat shares one.
 */
export function accountLetters(seats: readonly AccountView[]): ReadonlyMap<string, string> {
  const letters = new Map<string, string>();
  for (const seat of seats) {
    const key = accountKey(seat);
    if (key !== undefined && !letters.has(key)) letters.set(key, String.fromCharCode(65 + letters.size));
  }
  if (letters.size < 2) return new Map();
  return new Map(seats.flatMap(seat => {
    const key = accountKey(seat);
    const letter = key === undefined ? undefined : letters.get(key);
    return letter === undefined ? [] : [[seat.providerId, letter] as const];
  }));
}

// ── Letters (Settings › Room attention) ──────────────────────────────────────────────────────────

const LEVEL_WORD: Readonly<Record<string, string>> = { page: 'urgent', now: 'now', digest: 'digest' };
const TURN_WORD: Readonly<Record<string, string>> = { now: 'woke the Supervisor', digest: 'went to a digest', record: 'only recorded' };

export const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** `9 letters sent (1 urgent, 3 now, 5 digest) · 6 incidents · 12 Lead turns: 3 woke the Supervisor · 2 marked noise`. */
export function lettersLine(tally: LetterTally): string {
  const count = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((sum, value) => sum + value, 0);
  // In the words' own order (urgent, now, digest), whatever order the log met them in.
  const breakdown = (counts: Readonly<Record<string, number>>, words: Readonly<Record<string, string>>): string =>
    [...new Set([...Object.keys(words), ...Object.keys(counts)])].filter(key => (counts[key] ?? 0) > 0)
      .map(key => `${String(counts[key])} ${words[key] ?? key}`).join(', ');
  const sent = count(tally.sent);
  const turns = count(tally.leadTurns);
  const parts = [
    sent === 0 ? 'No letters sent' : `${plural(sent, 'letter')} sent (${breakdown(tally.sent, LEVEL_WORD)})`,
    tally.failed === 0 ? undefined : `${String(tally.failed)} failed`,
    tally.incidents === 0 ? undefined : plural(tally.incidents, 'incident'),
    turns === 0 ? undefined : `${plural(turns, 'Lead turn')}: ${breakdown(tally.leadTurns, TURN_WORD)}`,
    tally.noise + tally.useful === 0 ? undefined : `rated ${String(tally.useful)} useful, ${String(tally.noise)} noise`,
  ];
  return `${parts.filter(part => part !== undefined).join(' · ')}${tally.partial === true ? ' (partial: a log file was too large to read)' : ''}`;
}

