/**
 * The Room Observer (docs/design/runtime-coordination-attention.md A-D1, §4).
 *
 * Derived state only: every recognised room seat Paseo reports, and the facts the attention
 * signals read. It is rebuilt from `listAgents` at start and kept current from lifecycle events;
 * nothing here is persisted, and nothing here decides anything. A fact the Observer could not
 * establish stays undefined, and a signal never fires from its absence.
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import type { PluginLifecycleEvents } from '@getpaseo/plugin/server';
import type { RuntimeAgent, RuntimeRole } from '../../shared/policy.js';
import type { GitEvidence } from '../git.js';
import { carriesSupervisorMessage } from '../notices.js';
import { toTimelineEntry, type AgentSnapshot, type PaseoPort, type SeatUsage, type TimelineEntry } from '../paseo-port.js';
import type { Recognition } from '../recognition.js';
import { leadMarkers, type Marker } from './triage.js';

export type SeatState = 'running' | 'idle' | 'permission' | 'closed' | 'archived';
/**
 * What started a turn: Paseo's child-finished envelope, a runtime notice or letter, a Lead succession's
 * handoff request or kickoff, or any other message.
 */
export type TurnTrigger = 'envelope' | 'runtime' | 'succession' | 'message' | 'unknown';

/** Opens a succession's handoff request and its successor's kickoff (seat context delta K-D5). */
export const SUCCESSION_PREFIX = '[paseo-room succession ';

type AgentTimelineItem = PluginLifecycleEvents['agent.turn_ended']['timeline'][number];
type TurnOutcome = PluginLifecycleEvents['agent.turn_ended']['outcome'];

export const MESSAGE_TAIL = 4_000;
/** Turns a seat keeps for the panel's seat view. */
const RECENT_TURNS = 8;
/** Timeline entries read back to find one turn's items; a longer turn is judged by its tail. */
const TURN_READ = 300;
const WRITE_WINDOW_MS = 2 * 60 * 60 * 1_000;
const IDENTITY_TTL_MS = 10 * 60 * 1_000;

export interface Project {
  /** Canonical Git common directory, or `dir:<canonical cwd>` outside Git. */
  readonly key: string;
  readonly root: string;
  readonly name: string;
  readonly git: boolean;
}

/** Where a seat works in its repository, for display: which checkout, and what it has checked out. */
export interface Checkout {
  /** The checkout's canonical root. */
  readonly root: string;
  /** A linked worktree rather than the repository's main checkout. */
  readonly linked: boolean;
  /** The branch HEAD names; absent on a detached HEAD. */
  readonly branch?: string;
}

export interface TurnFacts {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: 'completed' | 'failed' | 'canceled';
  readonly errorKey?: string;
  readonly trigger: TurnTrigger;
  readonly writes: readonly string[];
  readonly lastMessage?: string;
  /** The message that started the turn, bounded; a Peer's brief on its first turn. */
  readonly firstMessage?: string;
  /** A Lead's marker lines anywhere in the turn's own messages (Lead contract); none for another seat. */
  readonly markers: readonly Marker[];
  /** A Lead turn that read its Supervisor's `message_lead`, alone or steered into the turn: it answers it. */
  readonly answersSupervisor: boolean;
}

/** The compactions this runtime saw in a seat's turns (seat context delta K-D1). */
export interface SeatCompaction {
  readonly lastAt: number;
  readonly lastTrigger?: 'auto' | 'manual';
  readonly lastPreTokens?: number;
  /** Counted since the runtime started: the Observer persists nothing. */
  readonly seen: number;
}

export interface Seat {
  readonly agentId: string;
  readonly role: RuntimeRole;
  /** The agent the room manifest names for the seat's provider. */
  readonly agent: RuntimeAgent;
  readonly provider: string;
  title: string | null;
  /** The model and thinking option Paseo reports the seat runs with, for display. */
  model: string | null;
  thinking: string | null;
  cwd: string;
  workspaceId: string | null;
  project: Project;
  /** The checkout the seat works in, read at each snapshot and turn end; undefined outside Git. */
  checkout: Checkout | undefined;
  parentAgentId: string | null;
  state: SeatState;
  archivedAt: string | null;
  turnStartedAt: number | undefined;
  lastTurn: TurnFacts | undefined;
  /** The seat's latest turns since the runtime started, oldest first, for the panel's seat view. */
  recentTurns: readonly TurnFacts[];
  /** Recent failed turns, newest last, for repeated-failure detection. */
  failures: { readonly at: number; readonly key: string }[];
  /** Pending permission ids and when the Observer first saw each. */
  readonly pending: Map<string, number>;
  /** Recent turns that edited or wrote files in the seat's working tree, with those files relative to it. */
  writeTurns: { readonly start: number; readonly end: number; readonly paths: readonly string[] }[];
  /**
   * The context of the seat's latest model call. A snapshot without one keeps the last figure: a
   * session resumed after a daemon restart reports none until its next call, on the same context.
   */
  usage: SeatUsage | null;
  compaction: SeatCompaction | undefined;
  refreshedAt: number;
}

export interface ObserverDependencies {
  readonly paseo: Pick<PaseoPort, 'listAgents' | 'getAgent' | 'recentTimeline'>;
  readonly recognition: Pick<Recognition, 'recognize'>;
  readonly git: Pick<GitEvidence, 'identity' | 'isLinked' | 'branch'>;
  readonly now: () => Date;
}

/** Classifies what started a turn from its first user message. */
export function triggerOf(text: string | undefined): TurnTrigger {
  if (text === undefined) return 'unknown';
  if (text.startsWith('<paseo-system>')) return 'envelope';
  if (text.startsWith('[paseo-room notice ') || text.startsWith('[paseo-room notices ') || text.startsWith('[paseo-room attention ')) return 'runtime';
  if (text.startsWith(SUCCESSION_PREFIX)) return 'succession';
  return 'message';
}

/** A short stable key for "the same failure": the error code, or the message's first 80 characters. */
export function errorKey(error: { readonly message: string; readonly code?: string }): string {
  return error.code ?? error.message.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
}

/** A written path relative to `cwd` when it lies inside it, as a list of zero or one. */
function inTree(cwd: string, path: string): string[] {
  const within = relative(cwd, resolve(cwd, path));
  return within === '' || within === '..' || within.startsWith('../') ? [] : [within];
}

function stateOf(snapshot: AgentSnapshot): SeatState {
  if (snapshot.archivedAt !== null) return 'archived';
  if (snapshot.status === 'closed') return 'closed';
  if (snapshot.pendingPermissions.length > 0) return 'permission';
  return snapshot.activeTurn || snapshot.status === 'running' || snapshot.status === 'initializing' ? 'running' : 'idle';
}

export class Observer {
  private readonly seatsById = new Map<string, Seat>();
  /** Per working directory: its project and, in Git, its checkout; only the branch there changes. */
  private readonly identities = new Map<string, { readonly project: Project; readonly checkout?: Omit<Checkout, 'branch'>; readonly at: number }>();

  constructor(private readonly deps: ObserverDependencies) {}

  private get time(): number {
    return this.deps.now().getTime();
  }

  /** The project a working directory belongs to; linked worktrees share their repository's. */
  async projectOf(cwd: string): Promise<Project> {
    return (await this.identify(cwd)).project;
  }

  private async identify(cwd: string): Promise<{ readonly project: Project; readonly checkout?: Omit<Checkout, 'branch'> }> {
    const cached = this.identities.get(cwd);
    if (cached !== undefined && this.time - cached.at < IDENTITY_TTL_MS) return cached;
    let found: { readonly project: Project; readonly checkout?: Omit<Checkout, 'branch'> };
    try {
      const identity = await this.deps.git.identity(cwd);
      const root = basename(identity.gitCommonDir) === '.git' ? dirname(identity.gitCommonDir) : identity.canonicalRoot;
      // For display only: a checkout Git cannot place leaves the project as it is.
      const linked = await this.deps.git.isLinked(identity).catch(() => undefined);
      found = { project: { key: identity.gitCommonDir, root, name: basename(root), git: true }, ...(linked === undefined ? {} : { checkout: { root: identity.canonicalRoot, linked } }) };
    } catch {
      const root = await realpath(cwd).catch(() => cwd);
      found = { project: { key: `dir:${root}`, root, name: basename(root), git: false } };
    }
    this.identities.set(cwd, { ...found, at: this.time });
    return found;
  }

  /** Rebuilds every seat from Paseo; facts only events carry are kept for seats still present. */
  async rebuild(): Promise<void> {
    const snapshots = await this.deps.paseo.listAgents();
    const present = new Set<string>();
    for (const snapshot of snapshots) {
      if (await this.upsert(snapshot) !== undefined) present.add(snapshot.id);
    }
    for (const id of [...this.seatsById.keys()]) if (!present.has(id)) this.seatsById.delete(id);
  }

  /** Adopts a fresh snapshot, keeping event-derived facts. Returns undefined for a non-seat. */
  async upsert(snapshot: AgentSnapshot): Promise<Seat | undefined> {
    const recognized = this.deps.recognition.recognize(snapshot.provider);
    if (recognized === undefined) return undefined;
    const known = this.seatsById.get(snapshot.id);
    const project = known !== undefined && known.cwd === snapshot.cwd ? known.project : await this.projectOf(snapshot.cwd);
    const checkout = await this.checkoutOf(snapshot.cwd);
    const seat: Seat = known ?? {
      agentId: snapshot.id, role: recognized.role, agent: recognized.agent, provider: snapshot.provider, title: snapshot.title, model: snapshot.model, thinking: snapshot.thinking, cwd: snapshot.cwd, workspaceId: snapshot.workspaceId, project, checkout,
      parentAgentId: snapshot.parentAgentId, state: stateOf(snapshot), archivedAt: snapshot.archivedAt,
      turnStartedAt: undefined, lastTurn: undefined, recentTurns: [], failures: [], pending: new Map(), writeTurns: [], usage: snapshot.usage, compaction: undefined, refreshedAt: this.time,
    };
    seat.title = snapshot.title;
    seat.model = snapshot.model;
    seat.thinking = snapshot.thinking;
    seat.cwd = snapshot.cwd;
    seat.workspaceId = snapshot.workspaceId;
    seat.project = project;
    seat.checkout = checkout;
    seat.parentAgentId = snapshot.parentAgentId;
    seat.state = stateOf(snapshot);
    seat.archivedAt = snapshot.archivedAt;
    if (snapshot.usage !== null) seat.usage = snapshot.usage;
    seat.refreshedAt = this.time;
    const live = new Set(snapshot.pendingPermissions.map(permission => permission.id));
    for (const id of [...seat.pending.keys()]) if (!live.has(id)) seat.pending.delete(id);
    for (const id of live) if (!seat.pending.has(id)) seat.pending.set(id, this.time);
    this.seatsById.set(seat.agentId, seat);
    return seat;
  }

  /** Where in its repository `cwd` lies, with the branch read afresh; undefined outside Git, or when Git cannot say. */
  private async checkoutOf(cwd: string): Promise<Checkout | undefined> {
    const where = (await this.identify(cwd)).checkout;
    if (where === undefined) return undefined;
    const branch = await this.deps.git.branch(where.root).catch(() => undefined);
    return { ...where, ...(branch === undefined ? {} : { branch }) };
  }

  /** Re-reads seats whose snapshot is older than `maxAgeMs`; a failed read changes nothing. */
  async refreshStale(maxAgeMs: number): Promise<void> {
    for (const seat of [...this.seatsById.values()]) {
      if (seat.state === 'archived' || this.time - seat.refreshedAt < maxAgeMs) continue;
      const snapshot = await this.deps.paseo.getAgent(seat.agentId).catch(() => null);
      if (snapshot === undefined) this.seatsById.delete(seat.agentId);
      else if (snapshot !== null) await this.upsert(snapshot);
    }
  }

  async onCreated(agentId: string): Promise<Seat | undefined> {
    const snapshot = await this.deps.paseo.getAgent(agentId).catch(() => undefined);
    return snapshot === undefined ? undefined : await this.upsert(snapshot);
  }

  private async seatFor(agentId: string): Promise<Seat | undefined> {
    return this.seatsById.get(agentId) ?? await this.onCreated(agentId);
  }

  async onTurnStarted(agentId: string): Promise<Seat | undefined> {
    const seat = await this.seatFor(agentId);
    if (seat === undefined) return undefined;
    seat.turnStartedAt = this.time;
    if (seat.state !== 'archived') seat.state = seat.pending.size > 0 ? 'permission' : 'running';
    return seat;
  }

  /**
   * Records a finished turn. Paseo's `turn_ended` carries the agent's whole timeline, not the turn's
   * (`S/agent/agent-manager.js` passes `timelineStore.getItems`), so the turn's own items are read
   * back by its id; without an id or an answer, only what follows the timeline's last user message
   * counts. Evidence scoped to the turn, its writes and compactions, is taken only when the turn is
   * bounded one of those ways; without a boundary only its messages count.
   */
  async onTurnEnded(agentId: string, outcome: TurnOutcome, timeline: readonly AgentTimelineItem[], turnId?: string | null): Promise<{ readonly seat: Seat; readonly turn: TurnFacts } | undefined> {
    const fresh = !this.seatsById.has(agentId);
    const seat = await this.seatFor(agentId);
    if (seat === undefined) return undefined;
    const now = this.time;
    const stamp = new Date(now).toISOString();
    // A Lead's or Supervisor's context is read at the turn that changed it, so a crossing is seen
    // then; a Peer's waits for the stale sweep. Only the figure is taken: the turn's own facts stand.
    // A seat first seen at this event was just read whole.
    const usage = seat.role !== 'peer' && !fresh ? this.deps.paseo.getAgent(agentId).then(snapshot => snapshot?.usage ?? null, () => null) : Promise.resolve(null);
    // A turn may have switched the seat's branch.
    const checkout = fresh ? Promise.resolve(seat.checkout) : this.checkoutOf(seat.cwd);
    let entries: readonly TimelineEntry[] = [];
    if (turnId !== undefined && turnId !== null && turnId !== '') {
      entries = (await this.deps.paseo.recentTimeline(agentId, TURN_READ).catch(() => [])).filter(entry => entry.turnId === turnId);
    }
    let bounded = entries.length > 0;
    if (!bounded) {
      const all = timeline.map(item => toTimelineEntry(item as Parameters<typeof toTimelineEntry>[0], stamp));
      const start = all.map(entry => entry.kind).lastIndexOf('user');
      bounded = start !== -1;
      entries = bounded ? all.slice(start) : all;
    }
    const turn = this.turnFrom(seat, entries, outcome, now, bounded);
    if (bounded) for (const entry of entries) if (entry.kind === 'compaction') this.compacted(seat, entry, now);
    const read = await usage;
    if (read !== null) seat.usage = read;
    seat.checkout = await checkout;
    seat.lastTurn = turn;
    seat.recentTurns = [...seat.recentTurns, turn].slice(-RECENT_TURNS);
    seat.turnStartedAt = undefined;
    if (seat.state !== 'archived' && seat.state !== 'closed') seat.state = seat.pending.size > 0 ? 'permission' : 'idle';
    if (turn.errorKey !== undefined) seat.failures = [...seat.failures, { at: now, key: turn.errorKey }].slice(-5);
    else if (turn.outcome === 'completed') seat.failures = [];
    // A write outside the working tree, such as a scratch file in /tmp, is no writer of that tree.
    const paths = turn.writes.flatMap(path => inTree(seat.cwd, path));
    if (paths.length > 0) seat.writeTurns = [...seat.writeTurns, { start: turn.startedAt, end: turn.endedAt, paths }].filter(entry => now - entry.end < WRITE_WINDOW_MS).slice(-10);
    return { seat, turn };
  }

  private compacted(seat: Seat, entry: TimelineEntry, now: number): void {
    const at = Date.parse(entry.timestamp);
    const { trigger, preTokens } = entry.compaction ?? {};
    seat.compaction = {
      lastAt: Number.isNaN(at) ? now : at, ...(trigger === undefined ? {} : { lastTrigger: trigger }),
      ...(preTokens === undefined ? {} : { lastPreTokens: preTokens }), seen: (seat.compaction?.seen ?? 0) + 1,
    };
  }

  private turnFrom(seat: Seat, entries: readonly TimelineEntry[], outcome: TurnOutcome, now: number, bounded: boolean): TurnFacts {
    const said = entries.filter(entry => entry.kind === 'assistant' && entry.text.trim() !== '');
    const assistant = said.at(-1);
    const firstUser = entries.find(entry => entry.kind === 'user');
    const writes = bounded ? [...new Set(entries.flatMap(entry => (entry.writes === undefined ? [] : [entry.writes])))] : [];
    return {
      startedAt: seat.turnStartedAt ?? now,
      endedAt: now,
      outcome: outcome.kind,
      ...(outcome.kind === 'failed' ? { errorKey: errorKey(outcome.error) } : {}),
      // A handoff request steered into a turn already running is not its first message.
      trigger: entries.some(entry => entry.kind === 'user' && entry.text.startsWith(SUCCESSION_PREFIX)) ? 'succession' : triggerOf(firstUser?.text),
      writes,
      // Every message of the turn, not only the last: an incident may be reported anywhere in it.
      markers: seat.role === 'lead' ? leadMarkers(said.map(entry => entry.text).join('\n')) : [],
      answersSupervisor: seat.role === 'lead' && entries.some(entry => entry.kind === 'user' && carriesSupervisorMessage(entry.text)),
      ...(assistant === undefined ? {} : { lastMessage: assistant.text.slice(-MESSAGE_TAIL) }),
      ...(firstUser === undefined || firstUser.text.trim() === '' ? {} : { firstMessage: firstUser.text.slice(0, MESSAGE_TAIL) }),
    };
  }

  async onPermissionRequested(agentId: string, requestId: string): Promise<Seat | undefined> {
    const seat = await this.seatFor(agentId);
    if (seat === undefined) return undefined;
    if (!seat.pending.has(requestId)) seat.pending.set(requestId, this.time);
    if (seat.state !== 'archived') seat.state = 'permission';
    return seat;
  }

  async onPermissionResolved(agentId: string, requestId: string): Promise<Seat | undefined> {
    const seat = await this.seatFor(agentId);
    if (seat === undefined) return undefined;
    seat.pending.delete(requestId);
    if (seat.state === 'permission' && seat.pending.size === 0) seat.state = seat.turnStartedAt === undefined ? 'idle' : 'running';
    return seat;
  }

  onArchived(agentId: string, archivedAt: string): Seat | undefined {
    const seat = this.seatsById.get(agentId);
    if (seat === undefined) return undefined;
    seat.state = 'archived';
    seat.archivedAt = archivedAt;
    seat.pending.clear();
    return seat;
  }

  seat(agentId: string): Seat | undefined {
    return this.seatsById.get(agentId);
  }

  seats(): readonly Seat[] {
    return [...this.seatsById.values()];
  }

  /** Every seat whose parent chain reaches `agentId`, excluding it. */
  descendants(agentId: string): readonly Seat[] {
    const found: Seat[] = [];
    const queue = [agentId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const parent = queue.shift();
      for (const seat of this.seatsById.values()) {
        if (seat.parentAgentId === parent && !seen.has(seat.agentId)) {
          seen.add(seat.agentId);
          found.push(seat);
          queue.push(seat.agentId);
        }
      }
    }
    return found;
  }

  /** Projects that hold at least one Lead or Peer seat, keyed by project key. */
  projects(): ReadonlyMap<string, Project> {
    const projects = new Map<string, Project>();
    for (const seat of this.seatsById.values()) {
      if (seat.role !== 'supervisor') projects.set(seat.project.key, seat.project);
    }
    return projects;
  }

  /** Live (not archived) seats of one role in a project. */
  live(projectKey: string, role: RuntimeRole): readonly Seat[] {
    return [...this.seatsById.values()].filter(seat => seat.project.key === projectKey && seat.role === role && seat.state !== 'archived');
  }

  /** Live room Supervisors, wherever they stand. */
  supervisors(): readonly Seat[] {
    return [...this.seatsById.values()].filter(seat => seat.role === 'supervisor' && seat.state !== 'archived');
  }
}
