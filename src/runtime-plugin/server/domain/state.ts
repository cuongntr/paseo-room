/**
 * Runtime state projection (docs/design/runtime-coordination.md §4.3, §4.4, §5.1, §5.3).
 *
 * Replay folds immutable events into this projection. `checkEvent` decides whether an event is
 * a legal next step without mutating anything; the controller calls it before appending, and
 * replay calls it before applying, so an illegal transition in a ledger pauses the project
 * instead of being silently absorbed. Writer ownership is its own projection: no technical
 * decision about an assignment releases it — only proven archive does.
 */
import type { AssignmentCreateInputV1, CandidateRefV1 } from '../contracts/assignment.js';
import type { PeerReportReceiptV1 } from '../contracts/peer.js';
import type { GateResultV1, RuntimeEventOf, RuntimeEventV1 } from '../events/schema.js';

export type AssignmentState =
  | 'draft' | 'dispatching' | 'active' | 'questioned' | 'blocked' | 'handed-back' | 'rework'
  | 'awaiting-permission' | 'accepted' | 'rejected' | 'abandoned' | 'uncertain';
export type ReportingState = 'closed' | 'open' | 'consumed' | 'uncertain';
export type Closure = 'open' | 'closing' | 'closed' | 'uncertain';
export type OwnershipState = 'reserved' | 'held' | 'releasing' | 'released' | 'uncertain';

export const TERMINAL_STATES: readonly AssignmentState[] = ['accepted', 'rejected', 'abandoned'];

export interface AcceptedReport {
  readonly generation: number;
  readonly tool: 'ask' | 'handoff';
  readonly requestId: string;
  readonly fingerprint: string;
  readonly receipt: PeerReportReceiptV1;
  readonly report: Readonly<Record<string, unknown>>;
  readonly eventId: string;
}

export interface GateRun {
  readonly gateRunId: string;
  readonly candidate: CandidateRefV1;
  readonly command: string;
  readonly status: 'running' | 'finished' | 'uncertain';
  readonly result?: GateResultV1;
}

export interface WriterOwnership {
  readonly assignmentId: string;
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly agentId?: string;
  readonly state: OwnershipState;
}

export interface AssignmentView {
  readonly id: string;
  readonly input: AssignmentCreateInputV1;
  readonly leadAgentId: string;
  readonly leadProviderId: string;
  readonly state: AssignmentState;
  readonly closure: Closure;
  readonly reportingGeneration: number;
  readonly reportingState: ReportingState;
  /** The generation whose single `run()` has been requested; one run per generation. */
  readonly runGeneration: number;
  readonly peerProviderId?: string;
  readonly workspaceId?: string;
  readonly peerAgentId?: string;
  readonly observedProviderId?: string;
  readonly observedModel?: string;
  readonly candidate?: CandidateRefV1;
  readonly inspectedCommit?: string;
  readonly reports: readonly AcceptedReport[];
  readonly gates: readonly GateRun[];
  readonly awaitingPermissionId?: string;
  /** Intents without a terminal result, keyed by intent id. Recovery works from these. */
  readonly openIntents: Readonly<Record<string, RuntimeEventV1['type']>>;
  readonly decision?: { readonly type: 'accepted' | 'rejected' | 'abandoned'; readonly eventId: string };
  readonly eventIds: readonly string[];
}

export interface NoticeView {
  readonly noticeId: string;
  readonly assignmentId?: string;
  readonly kind: string;
  readonly class: 'record' | 'owner' | 'operator' | 'page';
  readonly state: 'pending' | 'sent' | 'failed' | 'uncertain';
  readonly eventId: string;
}

export interface ProjectState {
  readonly projectId: string;
  binding?: { readonly canonicalRoot: string; readonly gitCommonDir: string };
  ownershipConflict?: { readonly leadAgentIds: readonly string[]; readonly eventId: string };
  readonly assignments: Map<string, AssignmentView>;
  readonly ownership: Map<string, WriterOwnership>;
  readonly notices: Map<string, NoticeView>;
  lastSequence: number;
}

export interface Violation {
  readonly eventId: string;
  readonly type: string;
  readonly message: string;
}

export function emptyProjectState(projectId: string): ProjectState {
  return { projectId, assignments: new Map(), ownership: new Map(), notices: new Map(), lastSequence: 0 };
}

/** Is any writer ownership in the project other than released? Then no writable dispatch. */
export function activeWriter(state: ProjectState): WriterOwnership | undefined {
  for (const owner of state.ownership.values()) if (owner.state !== 'released') return owner;
  return undefined;
}

type Check = string | undefined;

function need(condition: boolean, message: string): Check {
  return condition ? undefined : message;
}

function assignmentOf(state: ProjectState, event: RuntimeEventV1): AssignmentView | undefined {
  return event.assignmentId === undefined ? undefined : state.assignments.get(event.assignmentId);
}

function inState(assignment: AssignmentView, allowed: readonly AssignmentState[], action: string): Check {
  return need(allowed.includes(assignment.state), `Cannot ${action} while the assignment is ${assignment.state}.`);
}

/** Why `event` may not follow `state`, or undefined when it is a legal next step. */
export function checkEvent(state: ProjectState, event: RuntimeEventV1): Check {
  if (event.projectId !== state.projectId) return 'Event belongs to another project.';
  switch (event.type) {
    case 'project.bound': return need(state.binding === undefined, 'The project is already bound.');
    case 'project.rebound': return need(state.binding !== undefined, 'Only a bound project can be rebound.');
    case 'project.ownership-conflict': return undefined;
    case 'project.ownership-resolved': return need(state.ownershipConflict !== undefined, 'There is no ownership conflict to resolve.');
    case 'notice.pending': return need(!state.notices.has(event.data.noticeId), `Notice ${event.data.noticeId} already exists.`);
    case 'notice.sent': case 'notice.failed': case 'notice.uncertain':
      return need(state.notices.has(event.data.noticeId), `Unknown notice ${event.data.noticeId}.`);
    default: break;
  }
  if (event.type === 'assignment.created') {
    if (event.assignmentId === undefined) return 'An assignment event needs an assignment id.';
    return need(!state.assignments.has(event.assignmentId), `Assignment ${event.assignmentId} already exists.`);
  }
  const assignment = assignmentOf(state, event);
  if (assignment === undefined) return `Event ${event.type} names no known assignment.`;
  const owner = state.ownership.get(assignment.id);
  const writable = assignment.input.mode === 'writable';
  switch (event.type) {
    case 'assignment.dispatch-requested':
      return inState(assignment, ['draft'], 'dispatch')
        ?? need(state.ownershipConflict === undefined, 'Dispatch is paused by a Lead ownership conflict.')
        ?? need(!writable || activeWriter(state) === undefined, 'Another writer still owns this project.');
    case 'ownership.reserved':
      return need(writable, 'A read-only assignment reserves no writer ownership.')
        ?? inState(assignment, ['dispatching'], 'reserve ownership')
        ?? need(activeWriter(state) === undefined, 'Another writer still owns this project.');
    case 'agent.create-requested':
      return inState(assignment, ['dispatching'], 'create the Peer')
        ?? need(!writable || owner?.state === 'reserved', 'A writable Peer is created only after ownership is reserved.')
        ?? need(assignment.peerAgentId === undefined, 'This assignment already has a Peer.');
    case 'agent.create-succeeded': case 'agent.create-failed': case 'agent.create-uncertain':
      return need(assignment.openIntents[event.data.intentId] === 'agent.create-requested'
        || (assignment.state === 'uncertain' && event.type !== 'agent.create-uncertain'), 'No unresolved create intent matches.');
    case 'binding.refused':
      return inState(assignment, ['dispatching'], 'refuse the Peer binding')
        ?? need(assignment.peerAgentId === event.data.agentId, 'The refusal names a different agent than the one created.');
    case 'binding.published':
      return inState(assignment, ['dispatching'], 'bind the Peer')
        ?? need(assignment.peerAgentId === event.data.agentId, 'The binding names a different agent than the one created.');
    case 'ownership.held':
      return need(owner?.state === 'reserved', 'Only reserved ownership becomes held.')
        ?? need(assignment.peerAgentId === event.data.agentId && assignment.observedProviderId !== undefined, 'Ownership is held only by the bound Peer.');
    case 'reporting.generation-opened': {
      const from: Record<typeof event.data.turn, readonly AssignmentState[]> = {
        initial: ['dispatching'], answer: ['questioned'], 'follow-up': ['blocked'], rework: ['rework'],
      };
      return inState(assignment, from[event.data.turn], `open a ${event.data.turn} reporting generation`)
        ?? need(event.data.generation === assignment.reportingGeneration + 1, 'Reporting generations increase by exactly one.')
        ?? need(assignment.reportingState === 'closed' || assignment.reportingState === 'consumed', 'The previous reporting generation is not terminal.')
        ?? need(assignment.observedProviderId !== undefined, 'No proven Peer binding exists.')
        ?? need(!writable || owner?.state === 'held', 'A writable Peer needs held ownership before any turn.');
    }
    case 'run.requested':
      return need(event.data.generation === assignment.reportingGeneration && assignment.reportingState === 'open', 'A run must use the open reporting generation.')
        ?? need(assignment.runGeneration < event.data.generation, 'This reporting generation already has its run.')
        ?? need(!Object.values(assignment.openIntents).includes('run.requested'), 'Another run is still unresolved.');
    case 'run.succeeded': case 'run.failed': case 'run.uncertain':
      return need(assignment.openIntents[event.data.intentId] === 'run.requested'
        || (assignment.state === 'uncertain' && event.type !== 'run.uncertain'), 'No unresolved run intent matches.');
    case 'report.accepted':
      return need(event.data.generation === assignment.reportingGeneration, 'The report names a stale generation.')
        ?? need(assignment.reportingState === 'open' || assignment.reportingState === 'uncertain', 'The reporting generation is not open.')
        ?? inState(assignment, ['active', 'awaiting-permission', 'uncertain'], 'accept a report');
    case 'report.refused': return undefined;
    case 'report.missing':
      return need(event.data.generation === assignment.reportingGeneration, 'Missing report names a stale generation.')
        ?? need(assignment.reportingState === 'open' || assignment.reportingState === 'uncertain', 'The reporting generation is not open.')
        ?? inState(assignment, ['active', 'awaiting-permission', 'uncertain'], 'record a missing report');
    case 'report.uncertain':
      return need(event.data.generation === assignment.reportingGeneration, 'Uncertain report names a stale generation.');
    case 'permission.awaiting':
      return inState(assignment, ['active'], 'await a reporting permission')
        ?? need(event.data.generation === assignment.reportingGeneration && assignment.reportingState === 'open', 'Permission applies only to the open generation.');
    case 'permission.resolved':
      return inState(assignment, ['awaiting-permission'], 'resolve a permission')
        ?? need(assignment.awaitingPermissionId === event.data.permissionRequestId, 'A different permission request is outstanding.');
    case 'assignment.answered': return inState(assignment, ['questioned', 'blocked'], 'answer');
    case 'assignment.rework-requested': return inState(assignment, ['handed-back'], 'request rework');
    case 'assignment.accepted': return inState(assignment, ['handed-back'], 'accept');
    case 'assignment.rejected': return inState(assignment, ['handed-back'], 'reject');
    case 'assignment.abandoned':
      if (assignment.state === 'uncertain') {
        return need(assignment.reportingState !== 'open' && assignment.reportingState !== 'uncertain', 'Abandon an uncertain assignment only after its generation is terminal.')
          ?? need(assignment.closure === 'closing' || assignment.closure === 'uncertain', 'Abandon an uncertain assignment only after archive is requested.');
      }
      return inState(assignment, ['draft', 'questioned', 'blocked', 'handed-back', 'rework'], 'abandon');
    case 'assignment.close-requested':
      return need(TERMINAL_STATES.includes(assignment.state) || assignment.state === 'uncertain', 'Close an assignment only after a technical decision or while it is uncertain.')
        ?? need(assignment.closure === 'open' || assignment.closure === 'uncertain', 'The assignment is already closing or closed.');
    case 'archive.requested':
      return need(assignment.closure === 'closing' || assignment.closure === 'uncertain', 'Archive follows a close request.')
        ?? need(assignment.peerAgentId === event.data.agentId, 'Archive names a different agent.')
        ?? need(!Object.values(assignment.openIntents).includes('archive.requested'), 'Another archive is still unresolved.');
    case 'archive.succeeded': case 'archive.failed': case 'archive.uncertain':
      return need(assignment.openIntents[event.data.intentId] === 'archive.requested'
        || (assignment.closure === 'uncertain' && event.type !== 'archive.uncertain'), 'No unresolved archive intent matches.');
    case 'ownership.releasing':
      return need(owner?.state === 'held', 'Only held ownership starts releasing.')
        ?? need(assignment.closure === 'closing', 'Release starts only after a close request.');
    case 'ownership.released':
      return need(owner?.state === 'releasing' || owner?.state === 'uncertain', 'Only releasing or uncertain ownership is released.')
        ?? need(assignment.closure === 'closed', 'Ownership is released only after archive is proven.');
    case 'ownership.uncertain':
      return need(owner !== undefined && owner.state !== 'released', 'No unreleased ownership to mark uncertain.');
    case 'gate.requested':
      return inState(assignment, ['handed-back'], 'run a gate')
        ?? need(assignment.candidate !== undefined && assignment.candidate.commit === event.data.candidate.commit, 'A gate runs only against the projected candidate.')
        ?? need(!assignment.gates.some(gate => gate.status === 'running'), 'Another gate is still running.');
    case 'gate.finished':
      // A late sidecar may still settle a gate recorded as uncertain after a restart.
      return need(assignment.gates.some(gate => gate.gateRunId === event.data.result.id && gate.status !== 'finished'), 'No unsettled gate matches.');
    case 'gate.uncertain':
      return need(assignment.gates.some(gate => gate.gateRunId === event.data.gateRunId && gate.status === 'running'), 'No running gate matches.');
    default: {
      const exhaustive: never = event;
      return `Unhandled event ${(exhaustive as RuntimeEventV1).type}.`;
    }
  }
}

function update(state: ProjectState, id: string, change: Partial<AssignmentView>, event: RuntimeEventV1): void {
  const current = state.assignments.get(id);
  if (current === undefined) return;
  state.assignments.set(id, { ...current, ...change, eventIds: [...current.eventIds, event.id] });
}

function withIntent(view: AssignmentView, intentId: string, type: RuntimeEventV1['type'] | undefined): Record<string, RuntimeEventV1['type']> {
  const next = { ...view.openIntents };
  if (type === undefined) Reflect.deleteProperty(next, intentId);
  else next[intentId] = type;
  return next;
}

function withoutPermission(view: AssignmentView): AssignmentView {
  const copy: { -readonly [K in keyof AssignmentView]?: AssignmentView[K] } = { ...view };
  delete copy.awaitingPermissionId;
  return copy as AssignmentView;
}

function setOwner(state: ProjectState, id: string, change: Partial<WriterOwnership>): void {
  const current = state.ownership.get(id);
  if (current !== undefined) state.ownership.set(id, { ...current, ...change });
}

function applyReport(state: ProjectState, view: AssignmentView, event: RuntimeEventOf<'report.accepted'>): void {
  const report: AcceptedReport = {
    generation: event.data.generation, tool: event.data.tool, requestId: event.data.requestId,
    fingerprint: event.data.fingerprint, receipt: event.data.receipt, report: event.data.report, eventId: event.id,
  };
  update(state, view.id, {
    state: event.data.receipt.assignmentState,
    reportingState: 'consumed',
    reports: [...view.reports, report],
    ...(event.data.candidate === undefined ? {} : { candidate: event.data.candidate }),
    ...(event.data.inspectedCommit === undefined ? {} : { inspectedCommit: event.data.inspectedCommit }),
  }, event);
}

/** Folds one already-checked event into the projection. */
export function applyEvent(state: ProjectState, event: RuntimeEventV1): void {
  state.lastSequence = Math.max(state.lastSequence, event.sequence);
  switch (event.type) {
    case 'project.bound': case 'project.rebound':
      state.binding = { canonicalRoot: event.data.canonicalRoot, gitCommonDir: event.data.gitCommonDir };
      return;
    case 'project.ownership-conflict':
      state.ownershipConflict = { leadAgentIds: event.data.leadAgentIds, eventId: event.id };
      return;
    case 'project.ownership-resolved':
      delete state.ownershipConflict;
      return;
    case 'notice.pending':
      state.notices.set(event.data.noticeId, {
        noticeId: event.data.noticeId, kind: event.data.kind, class: event.data.class, state: 'pending', eventId: event.id,
        ...(event.assignmentId === undefined ? {} : { assignmentId: event.assignmentId }),
      });
      return;
    case 'notice.sent': case 'notice.failed': case 'notice.uncertain': {
      const notice = state.notices.get(event.data.noticeId);
      if (notice !== undefined) state.notices.set(notice.noticeId, { ...notice, state: event.type === 'notice.sent' ? 'sent' : event.type === 'notice.failed' ? 'failed' : 'uncertain' });
      return;
    }
    case 'assignment.created':
      if (event.assignmentId === undefined) return;
      state.assignments.set(event.assignmentId, {
        id: event.assignmentId, input: event.data.input, leadAgentId: event.data.leadAgentId, leadProviderId: event.data.leadProviderId,
        state: 'draft', closure: 'open', reportingGeneration: 0, reportingState: 'closed', runGeneration: 0, reports: [], gates: [],
        openIntents: {}, eventIds: [event.id],
      });
      return;
    default: break;
  }
  const view = assignmentOf(state, event);
  if (view === undefined) return;
  const id = view.id;
  switch (event.type) {
    case 'assignment.dispatch-requested':
      update(state, id, { state: 'dispatching', peerProviderId: event.data.peerProviderId, workspaceId: event.data.workspaceId }, event); return;
    case 'ownership.reserved':
      state.ownership.set(id, { assignmentId: id, workspaceId: event.data.workspaceId, baseCommit: event.data.baseCommit, state: 'reserved' });
      update(state, id, {}, event); return;
    case 'agent.create-requested':
      update(state, id, { openIntents: withIntent(view, event.data.intentId, event.type) }, event); return;
    case 'agent.create-succeeded':
      update(state, id, { peerAgentId: event.data.agentId, openIntents: withIntent(view, event.data.intentId, undefined), ...(view.state === 'uncertain' ? { state: 'dispatching' } : {}) }, event); return;
    case 'agent.create-failed': {
      // Proven: no agent exists, so a reservation without an agent cannot still be writing.
      const owner = state.ownership.get(id);
      if (owner?.state === 'reserved' || (owner?.state === 'uncertain' && owner.agentId === undefined)) setOwner(state, id, { state: 'released' });
      update(state, id, { state: 'blocked', openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    }
    case 'agent.create-uncertain':
      setOwner(state, id, { state: 'uncertain' });
      update(state, id, { state: 'uncertain' }, event); return;
    case 'binding.refused':
      setOwner(state, id, { state: 'uncertain', agentId: event.data.agentId });
      update(state, id, { state: 'uncertain' }, event); return;
    case 'binding.published':
      update(state, id, { observedProviderId: event.data.providerId, observedModel: event.data.model, workspaceId: event.data.workspaceId }, event); return;
    case 'ownership.held':
      setOwner(state, id, { state: 'held', agentId: event.data.agentId });
      update(state, id, {}, event); return;
    case 'reporting.generation-opened':
      update(state, id, { reportingGeneration: event.data.generation, reportingState: 'open' }, event); return;
    case 'run.requested':
      // Active is published with the run intent, before the external call, so a first tool call
      // can never race an internal dispatching, questioned, blocked or rework state.
      update(state, id, { state: 'active', runGeneration: event.data.generation, openIntents: withIntent(view, event.data.intentId, event.type) }, event); return;
    case 'run.succeeded':
      update(state, id, { openIntents: withIntent(view, event.data.intentId, undefined), ...(view.state === 'uncertain' ? { state: 'active', reportingState: 'open' } : {}) }, event); return;
    case 'run.failed':
      update(state, id, { state: 'blocked', reportingState: 'consumed', openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'run.uncertain':
      update(state, id, { state: 'uncertain', reportingState: 'uncertain' }, event); return;
    case 'report.accepted': applyReport(state, view, event); return;
    case 'report.refused': update(state, id, {}, event); return;
    case 'report.missing':
      state.assignments.set(id, { ...withoutPermission(view), state: 'blocked', reportingState: 'consumed', eventIds: [...view.eventIds, event.id] });
      return;
    case 'report.uncertain':
      update(state, id, { state: 'uncertain', reportingState: 'uncertain' }, event); return;
    case 'permission.awaiting':
      update(state, id, { state: 'awaiting-permission', awaitingPermissionId: event.data.permissionRequestId }, event); return;
    case 'permission.resolved':
      state.assignments.set(id, { ...withoutPermission(view), state: 'active', eventIds: [...view.eventIds, event.id] });
      return;
    case 'assignment.answered': update(state, id, {}, event); return;
    case 'assignment.rework-requested': update(state, id, { state: 'rework' }, event); return;
    case 'assignment.accepted': case 'assignment.rejected': case 'assignment.abandoned': {
      const type = event.type === 'assignment.accepted' ? 'accepted' : event.type === 'assignment.rejected' ? 'rejected' : 'abandoned';
      update(state, id, { state: type, decision: { type, eventId: event.id } }, event); return;
    }
    case 'assignment.close-requested': update(state, id, { closure: 'closing' }, event); return;
    case 'archive.requested': update(state, id, { openIntents: withIntent(view, event.data.intentId, event.type) }, event); return;
    case 'archive.succeeded': update(state, id, { closure: 'closed', openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'archive.failed': update(state, id, { closure: 'uncertain', openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'archive.uncertain': update(state, id, { closure: 'uncertain' }, event); return;
    case 'ownership.releasing': setOwner(state, id, { state: 'releasing' }); update(state, id, {}, event); return;
    case 'ownership.released': setOwner(state, id, { state: 'released' }); update(state, id, {}, event); return;
    case 'ownership.uncertain': setOwner(state, id, { state: 'uncertain' }); update(state, id, {}, event); return;
    case 'gate.requested':
      update(state, id, { gates: [...view.gates, { gateRunId: event.data.gateRunId, candidate: event.data.candidate, command: event.data.command, status: 'running' }] }, event); return;
    case 'gate.finished':
      update(state, id, { gates: view.gates.map(gate => gate.gateRunId === event.data.result.id ? { ...gate, status: 'finished', result: event.data.result } : gate) }, event); return;
    case 'gate.uncertain':
      update(state, id, { gates: view.gates.map(gate => gate.gateRunId === event.data.gateRunId ? { ...gate, status: 'uncertain' } : gate) }, event); return;
    default: return;
  }
}

export interface Projection {
  readonly state: ProjectState;
  readonly violations: readonly Violation[];
}

/** Replays a ledger. The first illegal transition stops folding: state after it is unknown. */
export function project(projectId: string, events: readonly RuntimeEventV1[]): Projection {
  const state = emptyProjectState(projectId);
  for (const event of events) {
    const problem = checkEvent(state, event);
    if (problem !== undefined) return { state, violations: [{ eventId: event.id, type: event.type, message: problem }] };
    applyEvent(state, event);
  }
  return { state, violations: [] };
}
