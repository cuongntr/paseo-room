/**
 * What only the operator's panel reads from a project ledger (docs/design/runtime-panel-ux.md §6):
 * when each assignment was created, last moved and settled, and its milestones as short phrases.
 * Derived from the events alone, so an answer's revision stays stable until the ledger changes.
 * No seat tool returns any of it; the views a Lead or Supervisor reads are unchanged.
 */
import type { Milestone, MilestoneTone } from '../shared/panel.js';
import { SETTLED_STATES } from '../shared/states.js';
import type { RuntimeEventV1 } from './events/schema.js';

export interface AssignmentTimes {
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When Lead or Human accepted, rejected or abandoned it. */
  readonly settledAt?: string;
  /** Once dispatched: whether into its own worktree rather than the Lead's checkout. */
  readonly isolated?: boolean;
}

export type { Milestone } from '../shared/panel.js';

const SETTLED = new Set<string>(SETTLED_STATES.map(state => `assignment.${state}`));

/** Each assignment's times, keyed by id. */
export function assignmentTimes(events: readonly RuntimeEventV1[]): Map<string, AssignmentTimes> {
  const times = new Map<string, { createdAt: string; updatedAt: string; settledAt?: string; isolated?: boolean }>();
  for (const event of events) {
    const id = event.assignmentId;
    if (id === undefined) continue;
    const known = times.get(id);
    if (known === undefined) {
      if (event.type === 'assignment.created') times.set(id, { createdAt: event.occurredAt, updatedAt: event.occurredAt });
      continue;
    }
    // A notice about the assignment is the runtime telling its Lead, not the assignment moving.
    if (!event.type.startsWith('notice.')) known.updatedAt = event.occurredAt;
    if (SETTLED.has(event.type)) known.settledAt = event.occurredAt;
    if (event.type === 'assignment.dispatch-requested') known.isolated ??= false;
    if (event.type === 'lease.reserved') known.isolated = true;
  }
  return times;
}

function by(event: RuntimeEventV1): Milestone['by'] {
  if (event.actor.source === 'human') return 'human';
  if (event.actor.source === 'seat' && (event.actor.role === 'lead' || event.actor.role === 'peer' || event.actor.role === 'supervisor')) return event.actor.role;
  return 'runtime';
}

type Phrase = readonly [label: string, tone: MilestoneTone, major: boolean];

const short = (commit: string): string => commit.slice(0, 7);

/** How a reader names an event, or undefined for bookkeeping no reader needs. */
function phrase(event: RuntimeEventV1): Phrase | undefined {
  switch (event.type) {
    case 'project.ownership-conflict': return ['Two Leads claimed this project', 'danger', true];
    case 'project.ownership-resolved': return ['The project\'s Lead was confirmed', 'success', true];
    case 'assignment.created': return ['Created', 'muted', false];
    case 'assignment.dispatch-requested': return [event.data.thinking === undefined ? 'Dispatched' : `Dispatched with ${event.data.thinking} thinking`, 'accent', true];
    case 'workspace.create-succeeded': return [`Worktree created on ${event.data.branch}`, 'muted', false];
    case 'workspace.create-failed': case 'workspace.create-refused': return ['The worktree could not be created', 'danger', true];
    case 'agent.create-succeeded': return ['Peer started', 'muted', false];
    case 'agent.create-failed': return ['The Peer could not be started', 'danger', true];
    case 'binding.refused': return ['The new Peer did not match its request and was not used', 'danger', true];
    case 'run.failed': return ['The Peer\'s turn could not start', 'danger', true];
    case 'report.accepted':
      return event.data.tool === 'ask'
        ? ['The Peer asked a question', 'warning', true]
        : [event.data.candidate === undefined ? 'Handed back' : `Handed back commit ${short(event.data.candidate.commit)}`, 'accent', true];
    case 'report.missing': return ['The Peer ended without reporting', 'danger', true];
    case 'permission.awaiting': return ['The Peer waits on a permission', 'warning', true];
    case 'permission.resolved': return [`Permission ${event.data.outcome === 'other' ? 'resolved' : event.data.outcome}`, 'muted', false];
    case 'assignment.answered': return ['Lead answered', 'muted', false];
    case 'assignment.rework-requested': return ['Rework requested', 'warning', true];
    case 'gate.requested': return ['Gate started', 'muted', false];
    case 'gate.finished': {
      const { result } = event.data;
      if (result.timedOut) return ['Gate timed out', 'danger', true];
      if (result.exitCode === 0) return ['Gate passed', 'success', true];
      return [result.exitCode === undefined ? `Gate ended (${result.termination})` : `Gate failed (exit ${String(result.exitCode)})`, 'danger', true];
    }
    case 'gate.uncertain': return ['The gate\'s outcome is unknown', 'warning', true];
    case 'scope.exceeded': return [`Changed ${String(event.data.paths.length)} path${event.data.paths.length === 1 ? '' : 's'} outside its write scope`, 'warning', true];
    case 'assignment.accepted': return [event.data.override === undefined ? 'Accepted' : 'Accepted with an override', 'success', true];
    case 'assignment.rejected': return ['Rejected', 'danger', true];
    case 'assignment.abandoned': return ['Abandoned', 'danger', true];
    case 'lease.reclaimed': return ['A new Peer took over the worktree', 'warning', true];
    case 'archive.succeeded': return ['Peer archived', 'muted', false];
    case 'workspace.close-succeeded': return [event.data.directoryRemoved ? 'Worktree closed' : 'Worktree closed; its directory was left behind', 'muted', false];
    case 'workspace.close-failed': return ['The worktree could not be closed', 'danger', true];
    case 'agent.create-uncertain': case 'run.uncertain': case 'report.uncertain': case 'archive.uncertain':
    case 'workspace.create-uncertain': case 'workspace.close-uncertain': case 'ownership.uncertain':
      return ['An action\'s outcome is uncertain', 'warning', true];
    default: return undefined;
  }
}

function milestone(event: RuntimeEventV1, [label, tone, major]: Phrase): Milestone {
  return { at: event.occurredAt, ...(event.assignmentId === undefined ? {} : { assignmentId: event.assignmentId }), label, tone, by: by(event), major };
}

/** The milestones of `events`, oldest first. */
export function milestones(events: readonly RuntimeEventV1[]): Milestone[] {
  return events.flatMap(event => {
    const named = phrase(event);
    return named === undefined ? [] : [milestone(event, named)];
  });
}

/** A project's latest major milestones, newest first, read from the ledger's end until `limit` are found. */
export function recentActivity(events: readonly RuntimeEventV1[], limit: number): Milestone[] {
  const found: Milestone[] = [];
  for (let index = events.length - 1; index >= 0 && found.length < limit; index -= 1) {
    const event = events[index];
    const named = event === undefined ? undefined : phrase(event);
    if (event !== undefined && named?.[2] === true) found.push(milestone(event, named));
  }
  return found;
}
