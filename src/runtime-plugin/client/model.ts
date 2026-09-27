/**
 * What the panel reads from `runtime.room` (docs/design/runtime-panel-ux.md §6), and the few
 * derivations every screen shares: a project's status, its headline, and the order of things.
 */
import { formatTokens } from '../shared/seat-context.js';
import { ago, clockTime } from './time.js';
import type { Tone } from './tone.js';

export interface SeatView {
  readonly agentId: string; readonly role: string; readonly provider: string; readonly title: string | null; readonly state: string;
  readonly model?: string | null; readonly thinking?: string | null;
  readonly cwd: string; readonly displayCwd: string; readonly workspaceId?: string | null; readonly parentAgentId: string | null; readonly pendingPermissions: number;
  readonly lastTurn?: { readonly outcome: string; readonly endedAgo: string; readonly endedAt: string };
  readonly context?: { readonly used: number; readonly max: number; readonly percent: number; readonly rotateAtPercent: number | null; readonly compactAtPercent: number | null };
  readonly compaction?: { readonly lastAt: string; readonly lastTrigger?: string; readonly lastPreTokens?: number; readonly seen: number };
}

export interface IncidentView {
  readonly id: string; readonly kind: string; readonly level: string; readonly text: string; readonly summary?: string; readonly count: number; readonly recipient: string;
  readonly projectKey: string; readonly subjects: readonly string[]; readonly openedAt: string; readonly feedback?: string;
}

export interface RuntimeRecord { readonly projectId: string; readonly health: string; readonly assignments: number; readonly active: number; readonly findings: number }

export interface ProjectView {
  readonly key: string; readonly name: string; readonly root: string; readonly displayRoot: string; readonly git: boolean; readonly decidedBy: string;
  readonly supervisor?: SeatView; readonly seats: readonly SeatView[]; readonly incidents: readonly IncidentView[]; readonly runtime?: RuntimeRecord;
}

export interface SupervisorView extends SeatView { readonly portfolio: number }

export interface RoomView {
  readonly started: boolean;
  readonly projects: readonly ProjectView[];
  readonly supervisors: readonly SupervisorView[];
  readonly panelIncidents: readonly IncidentView[];
  readonly providers: readonly { readonly providerId: string; readonly agent: string; readonly role: string }[];
}

export type ProjectStatus = 'attention' | 'working' | 'idle';

export const seatName = (seat: SeatView): string => seat.title ?? `${seat.role} ${seat.agentId.slice(0, 8)}`;

/** What a seat runs on, as Paseo reports it — `claude-opus-5-5 · thinking medium` — or '' when unknown. */
export const launchLabel = (seat: Pick<SeatView, 'model' | 'thinking'>): string =>
  [seat.model ?? '', seat.thinking === undefined || seat.thinking === null ? '' : `thinking ${seat.thinking}`].filter(part => part !== '').join(' · ');

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
  if (project.incidents.length > 0 || (project.runtime?.health ?? 'healthy') !== 'healthy') return 'attention';
  return project.seats.some(seat => seat.state === 'running' || seat.state === 'permission') ? 'working' : 'idle';
}

export const STATUS_TONE: Readonly<Record<ProjectStatus, Tone>> = { attention: 'warning', working: 'success', idle: 'muted' };

export function stateTone(state: string): Tone {
  if (state === 'running') return 'success';
  if (state === 'permission') return 'warning';
  if (state === 'archived' || state === 'closed') return 'muted';
  return 'neutral';
}

export const STATE_LABEL: Readonly<Record<string, string>> = { running: 'working', idle: 'idle', permission: 'needs permission', closed: 'not running', archived: 'archived' };

/** "Claude" for `claude-lead/claude-opus-5`. */
export const providerLabel = (provider: string): string => agentLabel(provider.split('/')[0]?.split('-')[0] ?? provider);

/** "Lead idle · 2 Peers working · last turn 5 min ago". */
export function projectHeadline(project: ProjectView): string {
  const leads = project.seats.filter(seat => seat.role === 'lead');
  const peers = project.seats.filter(seat => seat.role === 'peer');
  const working = peers.filter(seat => seat.state === 'running' || seat.state === 'permission').length;
  const parts: string[] = [];
  const [lead] = leads;
  if (project.seats.length === 0) return project.runtime === undefined ? 'No live seats' : `No live seats · ${String(project.runtime.assignments)} recorded assignment${project.runtime.assignments === 1 ? '' : 's'}`;
  parts.push(lead === undefined ? 'No Lead' : leads.length > 1 ? `${String(leads.length)} Leads` : `Lead ${STATE_LABEL[lead.state] ?? lead.state}`);
  if (peers.length > 0) parts.push(working > 0 ? `${String(working)} of ${String(peers.length)} Peers working` : `${String(peers.length)} Peer${peers.length === 1 ? '' : 's'} idle`);
  const waiting = project.seats.reduce((sum, seat) => sum + seat.pendingPermissions, 0);
  if (waiting > 0) parts.push(`${String(waiting)} permission${waiting === 1 ? '' : 's'} waiting`);
  return parts.join(' · ');
}

/** The newest turn end among a project's seats, as ISO. */
export function lastActivity(project: ProjectView): string | undefined {
  return project.seats.map(seat => seat.lastTurn?.endedAt).filter((value): value is string => value !== undefined).sort().at(-1);
}

const STATUS_RANK: Readonly<Record<ProjectStatus, number>> = { attention: 0, working: 1, idle: 2 };
export function sortProjects(projects: readonly ProjectView[]): ProjectView[] {
  return [...projects].sort((a, b) => STATUS_RANK[projectStatus(a)] - STATUS_RANK[projectStatus(b)] || a.name.localeCompare(b.name));
}

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
  'project-quiet': 'Stalled project',
  'context-high': 'Context past rotation mark',
};

export const ROLE_ICON: Readonly<Record<string, string>> = { supervisor: 'Eye', lead: 'Compass', peer: 'Wrench' };
