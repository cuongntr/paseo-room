/**
 * Runtime state projection (docs/design/runtime-coordination.md §4.3, §4.4, §5.1, §5.3).
 *
 * Replay folds immutable events into this projection. `checkEvent` decides whether an event is
 * a legal next step without mutating anything; the controller calls it before appending, and
 * replay calls it before applying, so an illegal transition in a ledger pauses the project
 * instead of being silently absorbed. Writer ownership is its own projection: no technical
 * decision about an assignment releases it — only proven archive does.
 *
 * Phase 2 (docs/design/runtime-coordination-phase2.md §4, §5.3) extends a writable reservation
 * with a writer lease on its own worktree. Leases may coexist only with each other, within the
 * fixed cap and with provably disjoint scopes; a writer in Lead's workspace still excludes every
 * other writer. Replay re-checks those rules, so a ledger can never hold two colliding writers.
 */
import { MAX_WORKTREE_LEASES } from '../../shared/limits.js';
import type { AssignmentCreateInputV1, CandidateRefV1 } from '../contracts/assignment.js';
import type { PeerReportReceiptV1 } from '../contracts/peer.js';
import type { GateResultV1, RuntimeEventOf, RuntimeEventV1 } from '../events/schema.js';
import { firstOverlap, parseScopes, reaches, type ScopeEntry } from './scope.js';

export type AssignmentState =
  | 'draft' | 'dispatching' | 'active' | 'questioned' | 'blocked' | 'handed-back' | 'rework'
  | 'awaiting-permission' | 'accepted' | 'rejected' | 'abandoned' | 'uncertain';
export type ReportingState = 'closed' | 'open' | 'consumed' | 'uncertain';
export type Closure = 'open' | 'closing' | 'closed' | 'uncertain';
export type OwnershipState = 'reserved' | 'held' | 'releasing' | 'released' | 'uncertain';

export const TERMINAL_STATES: readonly AssignmentState[] = ['accepted', 'rejected', 'abandoned'];

/** Decided, with nothing left to close: its Peer is archived, or none was ever placed. */
export function settled(view: AssignmentView): boolean {
  return TERMINAL_STATES.includes(view.state) && (view.closure === 'closed' || view.peerAgentId === undefined);
}

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

/**
 * A writer lease on a runtime-created worktree. Its state is the ownership state it extends:
 * reserved → held → releasing → released, or uncertain.
 */
export interface WriterLease {
  readonly workspaceId: string;
  /** The requested branch until the worktree exists, then the branch Paseo resolved. */
  readonly branch: string;
  readonly baseCommit: string;
  readonly scopes: readonly string[];
  readonly serialOnly: readonly string[];
  readonly epoch: number;
  readonly worktreePath?: string;
  /** Peers this lease was reclaimed from; none of them may report again. */
  readonly priorAgentIds: readonly string[];
}

export interface WriterOwnership {
  readonly assignmentId: string;
  readonly workspaceId: string;
  readonly baseCommit: string;
  readonly agentId?: string;
  readonly state: OwnershipState;
  readonly lease?: WriterLease;
}

export type WorkspaceCreateState = 'requested' | 'succeeded' | 'failed' | 'uncertain' | 'refused';
export type WorkspaceCloseState = 'open' | 'requested' | 'succeeded' | 'failed' | 'uncertain';

/** A runtime-requested Paseo worktree workspace, one per worktree assignment. */
export interface WorkspaceRecord {
  readonly assignmentId: string;
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly worktreeSlug: string;
  readonly create: WorkspaceCreateState;
  readonly createIntentId: string;
  readonly worktreePath?: string;
  readonly branch?: string;
  readonly headCommit?: string;
  readonly close: WorkspaceCloseState;
  readonly closeIntentId?: string;
  readonly discardUncommitted?: boolean;
  readonly archivedAt?: string;
  /** False is cleanup evidence: Paseo archived the record but the directory is still there. */
  readonly directoryRemoved?: boolean;
  readonly eventIds: readonly string[];
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
  /** Lead's thinking choice at dispatch and its reason; absent when the profile's option was kept. */
  readonly chosenThinking?: string;
  readonly thinkingReason?: string;
  /** The thinking option the bound Peer reported when it was created. */
  readonly observedThinking?: string;
  readonly candidate?: CandidateRefV1;
  readonly inspectedCommit?: string;
  readonly reports: readonly AcceptedReport[];
  readonly gates: readonly GateRun[];
  readonly awaitingPermissionId?: string;
  /** Intents without a terminal result, keyed by intent id. Recovery works from these. */
  readonly openIntents: Readonly<Record<string, RuntimeEventV1['type']>>;
  readonly decision?: { readonly type: 'accepted' | 'rejected' | 'abandoned'; readonly eventId: string };
  /** Changed paths of the current candidate outside its lease's scopes: evidence, not containment. */
  readonly scopeExceeded?: { readonly candidateCommit: string; readonly paths: readonly string[]; readonly eventId: string };
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
  /** Runtime-requested worktree workspaces, keyed by assignment id. */
  readonly workspaces: Map<string, WorkspaceRecord>;
  readonly notices: Map<string, NoticeView>;
  lastSequence: number;
}

export interface Violation {
  readonly eventId: string;
  readonly type: string;
  readonly message: string;
}

export function emptyProjectState(projectId: string): ProjectState {
  return { projectId, assignments: new Map(), ownership: new Map(), workspaces: new Map(), notices: new Map(), lastSequence: 0 };
}

/** Any writer ownership in the project other than released, optionally ignoring one assignment. */
export function activeWriter(state: ProjectState, except?: string): WriterOwnership | undefined {
  for (const owner of state.ownership.values()) if (owner.state !== 'released' && owner.assignmentId !== except) return owner;
  return undefined;
}

/** A writer in Lead's own workspace that is not released: it excludes every other writer. */
export function leadWorkspaceWriter(state: ProjectState, except?: string): WriterOwnership | undefined {
  for (const owner of state.ownership.values()) {
    if (owner.state !== 'released' && owner.lease === undefined && owner.assignmentId !== except) return owner;
  }
  return undefined;
}

/** Worktree leases that are not released. */
export function activeLeases(state: ProjectState, except?: string): (WriterOwnership & { readonly lease: WriterLease })[] {
  return [...state.ownership.values()].filter((owner): owner is WriterOwnership & { readonly lease: WriterLease } =>
    owner.lease !== undefined && owner.state !== 'released' && owner.assignmentId !== except);
}

export type LeaseCollision =
  | { readonly code: 'writer_exclusive'; readonly message: string }
  | { readonly code: 'writer_uncertain'; readonly message: string }
  | { readonly code: 'lease_cap'; readonly message: string }
  | { readonly code: 'scope_not_canonical'; readonly message: string }
  | { readonly code: 'scope_overlap'; readonly message: string }
  | { readonly code: 'serial_path'; readonly message: string };

function parsed(raws: readonly string[], empty: 'whole' | 'none'): readonly ScopeEntry[] | string {
  if (raws.length === 0 && empty === 'none') return [];
  const result = parseScopes(raws);
  return result.ok ? result.entries : `${result.item} ${result.reason}`;
}

/**
 * The §5.3 collision rules for a new worktree lease, decided on one projection. The controller
 * runs them before recording anything; replay runs them again on `lease.reserved`.
 */
export function leaseCollision(state: ProjectState, assignmentId: string, request: { readonly scopes: readonly string[]; readonly serialOnly: readonly string[] }): LeaseCollision | undefined {
  const exclusive = leadWorkspaceWriter(state, assignmentId);
  if (exclusive !== undefined) return { code: 'writer_exclusive', message: `Assignment ${exclusive.assignmentId} writes in Lead's workspace (${exclusive.state}); it excludes every other writer.` };
  const leases = activeLeases(state, assignmentId);
  const uncertain = leases.find(lease => lease.state === 'uncertain');
  if (uncertain !== undefined) return { code: 'writer_uncertain', message: `The writer of ${uncertain.assignmentId} is uncertain; no new writer starts until it is proven stopped.` };
  if (leases.length >= MAX_WORKTREE_LEASES) return { code: 'lease_cap', message: `${String(MAX_WORKTREE_LEASES)} worktree leases are already held in this project.` };
  const mine = parsed(request.scopes, 'whole');
  if (typeof mine === 'string') return { code: 'scope_not_canonical', message: `writeScope item ${mine}.` };
  const serial = parsed(request.serialOnly, 'none');
  if (typeof serial === 'string') return { code: 'scope_not_canonical', message: `serialOnly item ${serial}.` };
  const others = leases.map(lease => ({ lease, scopes: parsed(lease.lease.scopes, 'whole'), serial: parsed(lease.lease.serialOnly, 'none') }));
  for (const other of others) {
    // A recorded lease that no longer parses cannot be proven disjoint.
    if (typeof other.scopes === 'string' || typeof other.serial === 'string') {
      return { code: 'scope_overlap', message: `The scopes of ${other.lease.assignmentId} cannot be compared.` };
    }
    const overlap = firstOverlap(mine, other.scopes);
    if (overlap !== undefined) return { code: 'scope_overlap', message: `${overlap[0].text} overlaps ${overlap[1].text} held by ${other.lease.assignmentId}.` };
  }
  const union = [...serial, ...others.flatMap(other => (typeof other.serial === 'string' ? [] : other.serial))];
  for (const path of union) {
    if (!mine.some(scope => reaches(scope, path))) continue;
    const holder = others.find(other => typeof other.scopes !== 'string' && other.scopes.some(scope => reaches(scope, path)));
    if (holder !== undefined) return { code: 'serial_path', message: `${path.text} is serial-only and ${holder.lease.assignmentId} already writes under it.` };
  }
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
        // The dispatch mode is not known yet: a writer in Lead's workspace excludes both modes,
        // and `agent.create-requested` decides the rest once the mode is recorded.
        ?? need(!writable || leadWorkspaceWriter(state) === undefined, 'Another writer still owns this project.');
    case 'ownership.reserved':
      return need(writable, 'A read-only assignment reserves no writer ownership.')
        ?? inState(assignment, ['dispatching'], 'reserve ownership')
        ?? need(leadWorkspaceWriter(state) === undefined, 'Another writer still owns this project.');
    case 'agent.create-requested': {
      const lease = owner?.lease;
      return inState(assignment, ['dispatching'], 'create the Peer')
        ?? need(!writable || owner?.state === 'reserved', 'A writable Peer is created only after ownership is reserved.')
        ?? need(assignment.peerAgentId === undefined, 'This assignment already has a Peer.')
        // A writer in Lead's workspace excludes every other writer, leased or not.
        ?? need(!writable || lease !== undefined || activeWriter(state, assignment.id) === undefined, 'Another writer still owns this project.')
        ?? need(lease === undefined || (state.workspaces.get(assignment.id)?.create === 'succeeded' && event.data.workspaceId === lease.workspaceId), 'A leased Peer is created only in its proven worktree.');
    }
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
    case 'lease.reserved': {
      const collision = leaseCollision(state, assignment.id, event.data);
      return need(writable, 'A read-only assignment holds no lease.')
        ?? inState(assignment, ['dispatching'], 'reserve a lease')
        ?? need(owner?.state === 'reserved' && owner.lease === undefined && owner.agentId === undefined, 'A lease extends a fresh reservation.')
        ?? need(owner?.workspaceId === event.data.workspaceId && owner.baseCommit === event.data.baseCommit, 'The lease names a different workspace or base than the reservation.')
        ?? (collision === undefined ? undefined : `${collision.code}: ${collision.message}`);
    }
    case 'workspace.create-requested':
      return inState(assignment, ['dispatching'], 'request a worktree')
        ?? need(owner?.state === 'reserved' && owner.lease?.workspaceId === event.data.workspaceId && owner.lease.baseCommit === event.data.baseCommit, 'A worktree is requested only for its reserved lease.')
        ?? need(!state.workspaces.has(assignment.id), 'This assignment already requested its worktree.');
    case 'workspace.create-succeeded': case 'workspace.create-failed': case 'workspace.create-uncertain': case 'workspace.create-refused': {
      const record = state.workspaces.get(assignment.id);
      const from = event.type === 'workspace.create-uncertain' ? ['requested'] : ['requested', 'uncertain'];
      return need(record !== undefined && record.createIntentId === event.data.intentId && from.includes(record.create), 'No unresolved worktree create matches.')
        ?? need(!('workspaceId' in event.data) || event.data.workspaceId === record?.workspaceId, 'The result names a different workspace.');
    }
    case 'lease.reclaimed': {
      const check = reclaimCheck(state, assignment.id);
      if (!check.ok) return check.message;
      return need(event.data.fromEpoch === check.value.lease.epoch && event.data.toEpoch === event.data.fromEpoch + 1, 'A reclaim moves the lease to exactly the next epoch.')
        ?? need(event.data.priorAgentId === check.value.prior, 'The reclaim names a different writer than the lease holder.');
    }
    case 'scope.exceeded':
      return need(owner?.lease !== undefined, 'Only a leased candidate has scopes to exceed.')
        ?? need(assignment.candidate?.commit === event.data.candidateCommit, 'The evidence names a different candidate.');
    case 'workspace.close-requested': {
      const record = state.workspaces.get(assignment.id);
      return need(record?.workspaceId === event.data.workspaceId && (record.create === 'succeeded' || record.create === 'refused'), 'Only a created worktree is closed.')
        ?? need(record?.close === 'open' || record?.close === 'failed', 'The worktree is already closing or closed.')
        ?? need(owner?.state === 'released', 'A worktree closes only after its writer is proven released.')
        ?? need(!event.data.discardUncommitted || event.data.reason !== undefined, 'Discarding uncommitted work needs a reason.');
    }
    case 'workspace.close-succeeded': case 'workspace.close-failed': case 'workspace.close-uncertain': {
      const record = state.workspaces.get(assignment.id);
      const from = event.type === 'workspace.close-uncertain' ? ['requested'] : ['requested', 'uncertain'];
      return need(record !== undefined && record.closeIntentId === event.data.intentId && from.includes(record.close) && record.workspaceId === event.data.workspaceId, 'No unresolved worktree close matches.');
    }
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

function setLease(state: ProjectState, id: string, change: Partial<WriterLease>): void {
  const current = state.ownership.get(id);
  if (current?.lease !== undefined) state.ownership.set(id, { ...current, lease: { ...current.lease, ...change } });
}

function setWorkspace(state: ProjectState, id: string, change: Partial<WorkspaceRecord>, event: RuntimeEventV1): void {
  const current = state.workspaces.get(id);
  if (current !== undefined) state.workspaces.set(id, { ...current, ...change, eventIds: [...current.eventIds, event.id] });
}

/** A reclaim ends the prior Peer's binding: the assignment dispatches again inside its lease. */
function reclaimed(view: AssignmentView, event: RuntimeEventV1): AssignmentView {
  const copy: { -readonly [K in keyof AssignmentView]?: AssignmentView[K] } = { ...withoutPermission(view) };
  delete copy.peerAgentId;
  delete copy.observedProviderId;
  delete copy.observedModel;
  delete copy.observedThinking;
  return { ...(copy as AssignmentView), state: 'dispatching', reportingState: 'consumed', eventIds: [...view.eventIds, event.id] };
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
  // Scope evidence belongs to one candidate; a new candidate replaces it (or not, if in scope).
  const next = state.assignments.get(view.id);
  if (next?.scopeExceeded !== undefined && event.data.candidate !== undefined && event.data.candidate.commit !== next.scopeExceeded.candidateCommit) {
    const copy: { -readonly [K in keyof AssignmentView]?: AssignmentView[K] } = { ...next };
    delete copy.scopeExceeded;
    state.assignments.set(view.id, copy as AssignmentView);
  }
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
      update(state, id, {
        state: 'dispatching', peerProviderId: event.data.peerProviderId, workspaceId: event.data.workspaceId,
        ...(event.data.thinking === undefined ? {} : { chosenThinking: event.data.thinking }),
        ...(event.data.thinkingReason === undefined ? {} : { thinkingReason: event.data.thinkingReason }),
      }, event); return;
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
      update(state, id, {
        observedProviderId: event.data.providerId, observedModel: event.data.model, workspaceId: event.data.workspaceId,
        ...(event.data.thinking === undefined ? {} : { observedThinking: event.data.thinking }),
      }, event); return;
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
    case 'lease.reserved':
      setOwner(state, id, {
        lease: {
          workspaceId: event.data.workspaceId, branch: event.data.branch, baseCommit: event.data.baseCommit, scopes: event.data.scopes,
          serialOnly: event.data.serialOnly, epoch: event.data.epoch, priorAgentIds: [],
        },
      });
      update(state, id, {}, event); return;
    case 'workspace.create-requested':
      state.workspaces.set(id, {
        assignmentId: id, workspaceId: event.data.workspaceId, idempotencyKey: event.data.idempotencyKey, baseCommit: event.data.baseCommit,
        branchName: event.data.branchName, worktreeSlug: event.data.worktreeSlug, create: 'requested', createIntentId: event.data.intentId,
        close: 'open', eventIds: [event.id],
      });
      update(state, id, { openIntents: withIntent(view, event.data.intentId, event.type) }, event); return;
    case 'workspace.create-succeeded':
      setWorkspace(state, id, { create: 'succeeded', worktreePath: event.data.worktreePath, branch: event.data.branch, headCommit: event.data.headCommit }, event);
      setLease(state, id, { worktreePath: event.data.worktreePath, branch: event.data.branch });
      update(state, id, { openIntents: withIntent(view, event.data.intentId, undefined), ...(view.state === 'uncertain' ? { state: 'dispatching' } : {}) }, event); return;
    case 'workspace.create-failed': case 'workspace.create-refused':
      // No Peer was ever placed in the worktree, so the lease cannot still be writing.
      setWorkspace(state, id, { create: event.type === 'workspace.create-failed' ? 'failed' : 'refused' }, event);
      setOwner(state, id, { state: 'released' });
      update(state, id, { state: 'blocked', openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'workspace.create-uncertain':
      setWorkspace(state, id, { create: 'uncertain' }, event);
      setOwner(state, id, { state: 'uncertain' });
      update(state, id, { state: 'uncertain' }, event); return;
    case 'lease.reclaimed': {
      const owner = state.ownership.get(id);
      const lease = owner?.lease;
      if (owner === undefined || lease === undefined) return;
      const next: { -readonly [K in keyof WriterOwnership]?: WriterOwnership[K] } = { ...owner, state: 'reserved', lease: { ...lease, epoch: event.data.toEpoch, priorAgentIds: [...lease.priorAgentIds, event.data.priorAgentId] } };
      delete next.agentId;
      state.ownership.set(id, next as WriterOwnership);
      state.assignments.set(id, reclaimed(view, event));
      return;
    }
    case 'scope.exceeded':
      update(state, id, { scopeExceeded: { candidateCommit: event.data.candidateCommit, paths: event.data.paths, eventId: event.id } }, event); return;
    case 'workspace.close-requested':
      setWorkspace(state, id, { close: 'requested', closeIntentId: event.data.intentId, discardUncommitted: event.data.discardUncommitted }, event);
      update(state, id, { openIntents: withIntent(view, event.data.intentId, event.type) }, event); return;
    case 'workspace.close-succeeded':
      setWorkspace(state, id, { close: 'succeeded', archivedAt: event.data.archivedAt, directoryRemoved: event.data.directoryRemoved }, event);
      update(state, id, { openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'workspace.close-failed':
      setWorkspace(state, id, { close: 'failed' }, event);
      update(state, id, { openIntents: withIntent(view, event.data.intentId, undefined) }, event); return;
    case 'workspace.close-uncertain':
      setWorkspace(state, id, { close: 'uncertain' }, event);
      update(state, id, {}, event); return;
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

export interface ReclaimableLease {
  readonly view: AssignmentView;
  readonly lease: WriterLease;
  readonly worktreePath: string;
  readonly prior: string;
  readonly provider: string;
}

export type ReclaimCheck =
  | { readonly ok: true; readonly value: ReclaimableLease }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * The one projection rule for a lease reclaim, shared by replay (`lease.reclaimed`), the controller
 * and the panel. What remains after it passes is live proof that the prior Peer stopped.
 */
export function reclaimCheck(state: ProjectState, assignmentId: string): ReclaimCheck {
  const refused = (code: string, message: string): ReclaimCheck => ({ ok: false, code, message });
  const view = state.assignments.get(assignmentId);
  const owner = state.ownership.get(assignmentId);
  const lease = owner?.lease;
  const record = state.workspaces.get(assignmentId);
  if (view === undefined || owner === undefined || lease === undefined || record === undefined) return refused('lease_missing', `Assignment ${assignmentId} holds no worktree lease.`);
  if (owner.state === 'released' || owner.state === 'reserved') return refused('lease_state', 'Only a held or uncertain lease is reclaimed.');
  const prior = owner.agentId;
  if (prior === undefined || view.peerAgentId !== prior) return refused('lease_state', 'The reclaim names a different writer than the lease holder.');
  if (TERMINAL_STATES.includes(view.state) || view.state === 'draft' || view.state === 'dispatching') return refused('assignment_state', `Cannot reclaim while the assignment is ${view.state}.`);
  if (view.closure !== 'open') return refused('assignment_state', 'A closing assignment is not reclaimed.');
  if (Object.keys(view.openIntents).length > 0) return refused('effect_unresolved', 'Settle every unresolved effect before a reclaim.');
  if (record.create !== 'succeeded' || record.close !== 'open' || record.worktreePath === undefined) return refused('worktree_unavailable', 'The lease\'s worktree is not open.');
  if (view.peerProviderId === undefined) return refused('lease_state', 'The assignment names no Peer provider.');
  return { ok: true, value: { view, lease, worktreePath: record.worktreePath, prior, provider: view.peerProviderId } };
}
