/**
 * Deterministic attention signals (docs/design/runtime-coordination-attention.md §5).
 *
 * Every signal is a level-triggered condition recomputed from Observer facts: a condition that
 * appears opens an incident and one that clears closes it, so a missed event can delay a signal
 * but never wedge one. Durations, counts and orderings are computed here, in code — never asked of
 * a model. A fact the Observer does not have never makes a condition true.
 */
import type { AttentionSettings } from '../../shared/attention.js';
import type { Observer, Seat } from './observer.js';

export type SignalKind =
  | 'lead-gone-with-work' | 'writers-observed' | 'duplicate-lead' | 'permission-waiting'
  | 'peer-result-unread' | 'turn-failing' | 'peer-orphaned' | 'project-quiet';

/** `page` bypasses budgets; `now` wakes the Supervisor when idle; `digest` waits for the next digest. */
export type Level = 'page' | 'now' | 'digest';

export interface Condition {
  /** Stable identity of the condition: a repeat of the same key is the same incident. */
  readonly key: string;
  readonly kind: SignalKind;
  readonly level: Level;
  readonly projectKey: string;
  /** The seats the condition is about; the first is its subject. */
  readonly subjects: readonly string[];
  readonly text: string;
  /** The same, with seat names only: for the panel, where ids are noise. */
  readonly summary: string;
  /** Changes when the evidence changes, so an open incident counts it without a new letter. */
  readonly evidence: string;
}

export interface SignalContext {
  readonly observer: Pick<Observer, 'seats' | 'seat' | 'descendants' | 'live' | 'projects'>;
  readonly delivery: AttentionSettings['delivery'];
  readonly now: number;
  /** Project keys with a runtime assignment ledger, whose duplicate Leads the ledger already pages. */
  readonly ledgerProjects: ReadonlySet<string>;
  /** Projects whose last Lead turn the sensor recorded as `continuing`, and when. */
  readonly quiet: ReadonlyMap<string, number>;
}

const MINUTE = 60_000;
const FAILURE_WINDOW_MS = 30 * MINUTE;
/** Files named per seat in a `writers-observed` letter. */
const MAX_PATHS = 5;

export function seatLabel(seat: Seat | undefined, fallback = 'unknown seat'): string {
  if (seat === undefined) return fallback;
  return `${seat.role} ${seat.title ?? seat.agentId.slice(0, 8)} (${seat.agentId})`;
}

/** A seat by name alone: its title, or its role and a short id. */
export function seatName(seat: Seat | undefined, fallback = 'an unknown seat'): string {
  if (seat === undefined) return fallback;
  return seat.title ?? `${seat.role} ${seat.agentId.slice(0, 8)}`;
}

type Label = (seat: Seat | undefined) => string;
/** Both renderings of one sentence: with ids for letters, with names for the panel. */
const both = (say: (label: Label) => string): { readonly text: string; readonly summary: string } => ({
  text: say(seat => seatLabel(seat)), summary: say(seat => seatName(seat)),
});

export function age(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 60) return `${String(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
}

const active = (seat: Seat): boolean => seat.state === 'running' || seat.state === 'permission';

function leadGoneWithWork(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  for (const lead of ctx.observer.seats()) {
    if (lead.role !== 'lead' || lead.state !== 'archived') continue;
    const working = ctx.observer.descendants(lead.agentId).filter(active);
    if (working.length === 0) continue;
    found.push({
      key: `lead-gone:${lead.agentId}`, kind: 'lead-gone-with-work', level: 'page', projectKey: lead.project.key,
      subjects: [lead.agentId, ...working.map(seat => seat.agentId)],
      ...both(label => `${label(lead)} was archived while ${String(working.length)} of its seats still work: ${working.map(seat => label(seat)).join(', ')}.`),
      evidence: working.map(seat => seat.agentId).sort().join(','),
    });
  }
  return found;
}

function writersObserved(ctx: SignalContext): Condition[] {
  const byCwd = new Map<string, Seat[]>();
  for (const seat of ctx.observer.seats()) {
    if (seat.role === 'supervisor' || seat.state === 'archived' || seat.writeTurns.length === 0) continue;
    byCwd.set(seat.cwd, [...(byCwd.get(seat.cwd) ?? []), seat]);
  }
  const found: Condition[] = [];
  for (const [cwd, seats] of byCwd) {
    // The write turns of each seat that overlap another seat's, so the letter names what to check.
    const overlapping = new Map<string, Set<Seat['writeTurns'][number]>>();
    const note = (seat: Seat, turn: Seat['writeTurns'][number]): void => {
      overlapping.set(seat.agentId, (overlapping.get(seat.agentId) ?? new Set()).add(turn));
    };
    for (const a of seats) {
      for (const b of seats) {
        if (a.agentId >= b.agentId) continue;
        for (const x of a.writeTurns) {
          for (const y of b.writeTurns) {
            if (x.start < y.end && y.start < x.end) { note(a, x); note(b, y); }
          }
        }
      }
    }
    if (overlapping.size < 2) continue;
    const ids = [...overlapping.keys()].sort();
    const first = seats[0];
    if (first === undefined) continue;
    const writes = ids.map(id => {
      const turns = [...(overlapping.get(id) ?? [])];
      return { id, paths: [...new Set(turns.flatMap(turn => turn.paths))].sort(), ended: Math.max(...turns.map(turn => turn.end)) };
    });
    const files = (paths: readonly string[]): string =>
      paths.slice(0, MAX_PATHS).join(', ') + (paths.length > MAX_PATHS ? ` and ${String(paths.length - MAX_PATHS)} more` : '');
    found.push({
      key: `writers:${cwd}:${ids.join(',')}`, kind: 'writers-observed', level: 'now', projectKey: first.project.key, subjects: ids,
      ...both(label => `In ${cwd}, during overlapping turns, ${writes.map(write => `${label(ctx.observer.seat(write.id))} edited ${files(write.paths)} (turn ended ${age(ctx.now - write.ended)} ago)`).join('; ')} (observed, not proven); one working tree admits one writer.`),
      evidence: writes.map(write => `${write.id}@${String(write.ended)}:${write.paths.join('|')}`).join(','),
    });
  }
  return found;
}

function duplicateLead(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  for (const [key, project] of ctx.observer.projects()) {
    if (ctx.ledgerProjects.has(key)) continue;
    const leads = ctx.observer.live(key, 'lead');
    if (leads.length < 2) continue;
    const ids = leads.map(seat => seat.agentId).sort();
    found.push({
      key: `duplicate-lead:${key}`, kind: 'duplicate-lead', level: 'page', projectKey: key, subjects: ids,
      ...both(label => `${String(ids.length)} Leads are live on ${project.name}: ${leads.map(seat => label(seat)).join(', ')}. Keep the established owner and stop new routing to the others.`),
      evidence: ids.join(','),
    });
  }
  return found;
}

function permissionWaiting(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  const limit = ctx.delivery.permissionMinutes * MINUTE;
  for (const seat of ctx.observer.seats()) {
    if (seat.state === 'archived') continue;
    for (const [permissionId, since] of seat.pending) {
      const waited = ctx.now - since;
      if (waited < limit) continue;
      found.push({
        key: `permission:${seat.agentId}:${permissionId}`, kind: 'permission-waiting', level: 'now', projectKey: seat.project.key, subjects: [seat.agentId],
        ...both(label => `${label(seat)} has waited ${age(waited)} on permission ${permissionId}.`), evidence: permissionId,
      });
    }
  }
  return found;
}

function peerResultUnread(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  const limit = ctx.delivery.peerUnreadMinutes * MINUTE;
  for (const peer of ctx.observer.seats()) {
    if (peer.role !== 'peer' || peer.state !== 'idle' || peer.lastTurn === undefined || peer.lastTurn.outcome === 'canceled') continue;
    const lead = peer.parentAgentId === null ? undefined : ctx.observer.seat(peer.parentAgentId);
    if (lead === undefined || lead.role !== 'lead' || lead.state !== 'idle') continue;
    const endedAt = peer.lastTurn.endedAt;
    // The Lead has not run since the Peer finished: no turn of its ended after that moment.
    if (lead.lastTurn !== undefined && lead.lastTurn.endedAt >= endedAt) continue;
    const waited = ctx.now - endedAt;
    if (waited < limit) continue;
    const outcome = peer.lastTurn.outcome;
    found.push({
      key: `peer-unread:${peer.agentId}:${String(endedAt)}`, kind: 'peer-result-unread', level: 'now', projectKey: peer.project.key, subjects: [lead.agentId, peer.agentId],
      ...both(label => `${label(peer)} finished ${age(waited)} ago (${outcome}) and its Lead ${label(lead)} has not taken a turn since.`),
      evidence: String(endedAt),
    });
  }
  return found;
}

function turnFailing(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  for (const seat of ctx.observer.seats()) {
    if (seat.state === 'archived') continue;
    const [previous, last] = seat.failures.slice(-2);
    if (previous === undefined || last === undefined || previous.key !== last.key || last.at - previous.at > FAILURE_WINDOW_MS) continue;
    const repeated = seat.failures.filter(failure => failure.key === last.key).length;
    found.push({
      key: `failing:${seat.agentId}:${last.key}`, kind: 'turn-failing', level: 'now', projectKey: seat.project.key, subjects: [seat.agentId],
      ...both(label => `${label(seat)} failed ${String(repeated)} turns with the same error: "${last.key}". Check the prerequisite (quota, auth, network) before retrying.`),
      evidence: String(repeated),
    });
  }
  return found;
}

function peerOrphaned(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  const limit = ctx.delivery.orphanHours * 60 * MINUTE;
  for (const peer of ctx.observer.seats()) {
    if (peer.role !== 'peer' || peer.state !== 'idle' || peer.parentAgentId === null) continue;
    const lead = ctx.observer.seat(peer.parentAgentId);
    if (lead?.state !== 'archived' || lead.archivedAt === null) continue;
    const since = Math.max(Date.parse(lead.archivedAt), peer.lastTurn?.endedAt ?? 0);
    if (Number.isNaN(since) || ctx.now - since < limit) continue;
    found.push({
      key: `orphan:${peer.agentId}`, kind: 'peer-orphaned', level: 'digest', projectKey: peer.project.key, subjects: [peer.agentId, lead.agentId],
      ...both(label => `${label(peer)} has idled ${age(ctx.now - since)} since its Lead ${label(lead)} was archived; archive it if its work is handed off.`),
      evidence: '',
    });
  }
  return found;
}

function projectQuiet(ctx: SignalContext): Condition[] {
  const found: Condition[] = [];
  const limit = ctx.delivery.quietHours * 60 * MINUTE;
  for (const [key, since] of ctx.quiet) {
    const seats = ctx.observer.seats().filter(seat => seat.project.key === key && seat.state !== 'archived');
    if (seats.some(active) || seats.some(seat => (seat.lastTurn?.endedAt ?? 0) > since)) continue;
    if (ctx.now - since < limit) continue;
    const lead = seats.find(seat => seat.role === 'lead');
    found.push({
      key: `quiet:${key}:${String(since)}`, kind: 'project-quiet', level: 'now', projectKey: key, subjects: lead === undefined ? [] : [lead.agentId],
      ...both(label => `${lead === undefined ? 'The Lead' : label(lead)} said it would keep working ${age(ctx.now - since)} ago, and nothing in the project has run since.`),
      evidence: '',
    });
  }
  return found;
}

/** Every condition true now, in a stable order. */
export function conditions(ctx: SignalContext): readonly Condition[] {
  return [
    ...leadGoneWithWork(ctx), ...duplicateLead(ctx), ...writersObserved(ctx), ...permissionWaiting(ctx),
    ...peerResultUnread(ctx), ...turnFailing(ctx), ...projectQuiet(ctx), ...peerOrphaned(ctx),
  ];
}
