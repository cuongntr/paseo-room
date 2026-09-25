/**
 * Role-filtered status views (docs/design/runtime-coordination.md D8, D9, §8.1, §8.2).
 *
 * Every claim carries its evidence class. "Healthy" means no known enforced or detected failure;
 * it never means a model obeyed its prompt or that the operating system contained anything.
 * Every degraded or pending item names one bounded recovery action. Peer receives no view.
 */
import type { RuntimeEventV1 } from '../events/schema.js';
import { canonicalJson, sha256 } from './receipts.js';
import {
  activeLeases, leadWorkspaceWriter, reclaimCheck, settled, TERMINAL_STATES, type AssignmentView, type ProjectState, type Violation, type WorkspaceRecord,
} from './state.js';

export type EvidenceClass = 'enforced' | 'detected' | 'procedural' | 'unverifiable';
export type ViewerRole = 'operator' | 'supervisor' | 'lead';

export interface Claim<T> {
  readonly value: T;
  readonly evidence: EvidenceClass;
}

export type FindingKind =
  | 'project-paused' | 'ownership-conflict' | 'uncertain-effect' | 'report-missing' | 'report-uncertain'
  | 'awaiting-permission' | 'notice-failed' | 'worktree-retained' | 'worktree-cleanup' | 'scope-exceeded';

export interface Finding {
  readonly kind: FindingKind;
  readonly evidence: EvidenceClass;
  readonly message: string;
  readonly recoveryAction: string;
  readonly sourceEventIds: readonly string[];
  readonly assignmentId?: string;
}

export interface ReplayHealth {
  readonly status: 'ok' | 'paused';
  readonly problems: readonly { readonly file: string; readonly reason: string; readonly detail: string }[];
}

export interface StatusInput {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly replay: ReplayHealth;
  readonly violations: readonly Violation[];
  readonly state: ProjectState;
  readonly events: readonly RuntimeEventV1[];
  /** False while Paseo is unreachable: live facts are then labelled stale, never fresh. */
  readonly liveAvailable: boolean;
  /**
   * Whether a directory still exists, for worktrees Paseo archived but left behind. Callers with
   * a filesystem pass it; without it a left-behind directory is assumed still there.
   */
  readonly present?: (path: string) => boolean;
}

export interface AssignmentSummary {
  readonly id: string;
  readonly mode: string;
  readonly kind: string;
  readonly outcome: string;
  readonly state: Claim<string>;
  readonly closure: Claim<string>;
  readonly peerProviderId?: string;
  readonly candidate?: Claim<string>;
}

/** A worktree writer lease (Phase 2). Scopes are scheduling evidence, never containment. */
export interface LeaseView {
  readonly assignmentId: string;
  readonly state: Claim<string>;
  readonly epoch: number;
  readonly scopes: readonly string[];
  readonly serialOnly: readonly string[];
  readonly workspaceId: string;
  readonly branch: string;
  readonly worktreePath?: string;
  readonly agentId?: string;
  /** The projection allows a reclaim; the prior Peer must still be proven stopped live. */
  readonly reclaimable: boolean;
}

/** A runtime-requested worktree, while it may still exist on disk. */
export interface WorktreeView {
  readonly assignmentId: string;
  readonly workspaceId: string;
  readonly path?: string;
  readonly branch: string;
  readonly create: Claim<string>;
  readonly close: Claim<string>;
  readonly disposition: WorktreeDisposition;
}

export interface ProjectStatusView {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly health: Claim<'healthy' | 'attention' | 'paused'>;
  readonly liveFacts: 'fresh' | 'stale';
  readonly writer?: { readonly assignmentId: string; readonly state: Claim<string> };
  readonly leases: readonly LeaseView[];
  readonly worktrees: readonly WorktreeView[];
  /** Said wherever scopes are shown (PRD REQ-011). */
  readonly scopeStatement: string;
  readonly assignments: readonly AssignmentSummary[];
  /** Present when settled assignments are counted instead of listed. */
  readonly settledAssignments?: number;
  readonly findings: readonly Finding[];
}

export const SCOPE_STATEMENT = 'Write scopes decide which isolated writers may run at the same time. They prevent collisions; they do not contain a Peer, which can still write anywhere its user can.';

export interface AssignmentDetailView extends AssignmentSummary {
  readonly brief: AssignmentView['input'];
  readonly leadAgentId: string;
  readonly peerAgentId?: string;
  readonly observedModel?: string;
  readonly reportingGeneration: number;
  readonly peerVerification: readonly Claim<{ readonly command: string; readonly outcome: string }>[];
  readonly runtimeGates: readonly Claim<{ readonly gateRunId: string; readonly status: string; readonly exitCode?: number }>[];
  readonly ownership?: Claim<string>;
  readonly lease?: LeaseView;
  readonly worktree?: WorktreeView;
  readonly scopeExceeded?: Claim<{ readonly candidateCommit: string; readonly paths: readonly string[] }>;
  readonly history: readonly string[];
}

const RECOVERY = {
  paused: 'Export the project, inspect the named event file, and quarantine it only if it is confirmed corrupt; the runtime never repairs it.',
  conflict: 'Supervisor or Human confirms the one Lead that owns this project; dispatch stays paused until then.',
  uncertain: 'Inspect the agent in Paseo; when its state is known, let recovery settle it or abandon after archive is requested.',
  missing: 'Lead answers with a follow-up turn or abandons the assignment; prose in the transcript is not a report.',
  reportUncertain: 'Wait for recovery to confirm whether the report was recorded; no later turn starts meanwhile.',
  permission: 'An operator approves or denies the reporting tool permission in Paseo; the runtime never answers it.',
  notice: 'Check the Lead seat is reachable; the notice is retried with the same id.',
  retained: 'Inspect the worktree, then Lead calls workspace_close — or a Human closes it here — with discardUncommitted and a reason to discard its work.',
  cleanup: 'Paseo archived the workspace but left its directory; remove it by hand once nothing in it is needed. The branch is kept.',
  exceeded: 'Review the named paths; accepting this candidate needs an override reason and a residual-risk acknowledgement, or ask for rework.',
} as const;

function leaseView(state: ProjectState, assignmentId: string): LeaseView | undefined {
  const owner = state.ownership.get(assignmentId);
  const lease = owner?.lease;
  if (owner === undefined || lease === undefined) return undefined;
  return {
    assignmentId, state: { value: owner.state, evidence: owner.state === 'uncertain' ? 'unverifiable' : 'enforced' },
    epoch: lease.epoch, scopes: lease.scopes, serialOnly: lease.serialOnly, workspaceId: lease.workspaceId, branch: lease.branch,
    ...(lease.worktreePath === undefined ? {} : { worktreePath: lease.worktreePath }),
    ...(owner.agentId === undefined ? {} : { agentId: owner.agentId }),
    reclaimable: reclaimCheck(state, assignmentId).ok,
  };
}

/**
 * What a runtime worktree record means on disk — the one rule every view, count and blocker uses.
 * `unresolved`: a create or close is unconfirmed. `active`: its writer is not released.
 * `retained`: writer released, worktree open, waiting for an explicit close. `leftover`: archived
 * by Paseo but its directory is still there. `gone`: never created, or closed and removed.
 */
export type WorktreeDisposition = 'unresolved' | 'active' | 'retained' | 'leftover' | 'gone';

export function worktreeDisposition(state: ProjectState, record: WorkspaceRecord, present: (path: string) => boolean = () => true): WorktreeDisposition {
  if (record.create === 'requested' || record.create === 'uncertain' || record.close === 'requested' || record.close === 'uncertain') return 'unresolved';
  if (record.create === 'failed') return 'gone';
  if (record.close === 'succeeded') {
    return record.directoryRemoved === false && (record.worktreePath === undefined || present(record.worktreePath)) ? 'leftover' : 'gone';
  }
  return state.ownership.get(record.assignmentId)?.state === 'released' ? 'retained' : 'active';
}

function worktreeView(record: WorkspaceRecord, disposition: WorktreeDisposition): WorktreeView {
  const claim = (value: string): Claim<string> => ({ value, evidence: value === 'uncertain' ? 'unverifiable' : 'detected' });
  return {
    assignmentId: record.assignmentId, workspaceId: record.workspaceId, branch: record.branch ?? record.branchName,
    ...(record.worktreePath === undefined ? {} : { path: record.worktreePath }),
    create: claim(record.create), close: claim(record.close), disposition,
  };
}

/** Every record's disposition, worked out once per view (each may check the disk). */
function dispositions(state: ProjectState, present?: (path: string) => boolean): Map<WorkspaceRecord, WorktreeDisposition> {
  return new Map([...state.workspaces.values()].map(record => [record, worktreeDisposition(state, record, present)]));
}

function eventIdsOf(events: readonly RuntimeEventV1[], assignmentId: string, type: RuntimeEventV1['type']): string[] {
  return events.filter(event => event.assignmentId === assignmentId && event.type === type).map(event => event.id);
}

export function findings(input: StatusInput): Finding[] {
  const found: Finding[] = [];
  if (input.replay.status === 'paused' || input.violations.length > 0) {
    found.push({
      kind: 'project-paused', evidence: 'detected',
      message: [...input.replay.problems.map(problem => `${problem.file}: ${problem.reason}`), ...input.violations.map(violation => `${violation.eventId}: ${violation.message}`)].join('; '),
      recoveryAction: RECOVERY.paused, sourceEventIds: input.violations.map(violation => violation.eventId),
    });
  }
  const conflict = input.state.ownershipConflict;
  if (conflict !== undefined) {
    found.push({ kind: 'ownership-conflict', evidence: 'detected', message: `Leads ${conflict.leadAgentIds.join(', ')} both claim this project.`, recoveryAction: RECOVERY.conflict, sourceEventIds: [conflict.eventId] });
  }
  const flagged = new Set<string>();
  for (const view of input.state.assignments.values()) {
    const owner = input.state.ownership.get(view.id);
    if (view.state === 'uncertain' || view.closure === 'uncertain' || owner?.state === 'uncertain' || view.gates.some(gate => gate.status === 'uncertain')) {
      flagged.add(view.id);
      found.push({
        kind: view.reportingState === 'uncertain' ? 'report-uncertain' : 'uncertain-effect', evidence: 'unverifiable', assignmentId: view.id,
        message: `Assignment ${view.id} has an effect whose outcome is not known.`,
        recoveryAction: view.reportingState === 'uncertain' ? RECOVERY.reportUncertain : RECOVERY.uncertain,
        sourceEventIds: view.eventIds.slice(-1),
      });
    }
    if (view.state === 'blocked') {
      const missing = eventIdsOf(input.events, view.id, 'report.missing');
      const last = view.eventIds.at(-1);
      if (last !== undefined && missing.includes(last)) {
        found.push({ kind: 'report-missing', evidence: 'detected', assignmentId: view.id, message: `The Peer turn for ${view.id} ended without an accepted report.`, recoveryAction: RECOVERY.missing, sourceEventIds: [last] });
      }
    }
    if (view.state === 'awaiting-permission') {
      found.push({ kind: 'awaiting-permission', evidence: 'detected', assignmentId: view.id, message: `The Peer for ${view.id} is waiting for permission to call its reporting tool.`, recoveryAction: RECOVERY.permission, sourceEventIds: eventIdsOf(input.events, view.id, 'permission.awaiting').slice(-1) });
    }
  }
  for (const [record, disposition] of dispositions(input.state, input.present)) {
    const ids = record.eventIds.slice(-1);
    if (record.create === 'uncertain' || record.close === 'uncertain') {
      if (!flagged.has(record.assignmentId)) {
        found.push({ kind: 'uncertain-effect', evidence: 'unverifiable', assignmentId: record.assignmentId, message: `The worktree ${record.create === 'uncertain' ? 'create' : 'close'} of ${record.assignmentId} is unconfirmed.`, recoveryAction: RECOVERY.uncertain, sourceEventIds: ids });
      }
    } else if (disposition === 'retained') {
      found.push({ kind: 'worktree-retained', evidence: 'detected', assignmentId: record.assignmentId, message: `The worktree of ${record.assignmentId} (${record.worktreePath ?? record.workspaceId}) was ${record.create === 'refused' ? 'refused and not closed' : 'retained after its writer was released'}.`, recoveryAction: RECOVERY.retained, sourceEventIds: ids });
    } else if (disposition === 'leftover') {
      found.push({ kind: 'worktree-cleanup', evidence: 'detected', assignmentId: record.assignmentId, message: `The worktree of ${record.assignmentId} is closed but ${record.worktreePath ?? 'its directory'} remains.`, recoveryAction: RECOVERY.cleanup, sourceEventIds: ids });
    }
  }
  for (const view of input.state.assignments.values()) {
    const exceeded = view.scopeExceeded;
    if (exceeded !== undefined && !TERMINAL_STATES.includes(view.state)) {
      found.push({ kind: 'scope-exceeded', evidence: 'detected', assignmentId: view.id, message: `The candidate of ${view.id} changes ${exceeded.paths.join(', ')} outside its write scope.`, recoveryAction: RECOVERY.exceeded, sourceEventIds: [exceeded.eventId] });
    }
  }
  for (const notice of input.state.notices.values()) {
    if (notice.state === 'failed' || notice.state === 'uncertain') {
      found.push({ kind: 'notice-failed', evidence: notice.state === 'failed' ? 'detected' : 'unverifiable', message: `Notice ${notice.noticeId} (${notice.kind}) was not confirmed delivered.`, recoveryAction: RECOVERY.notice, sourceEventIds: [notice.eventId], ...(notice.assignmentId === undefined ? {} : { assignmentId: notice.assignmentId }) });
    }
  }
  return found;
}

function stateClaim(view: AssignmentView): Claim<string> {
  return { value: view.state, evidence: view.state === 'uncertain' ? 'unverifiable' : 'enforced' };
}

function summary(view: AssignmentView): AssignmentSummary {
  return {
    id: view.id, mode: view.input.mode, kind: view.input.kind, outcome: view.input.outcome,
    state: stateClaim(view),
    closure: { value: view.closure, evidence: view.closure === 'uncertain' ? 'unverifiable' : view.closure === 'closed' ? 'detected' : 'enforced' },
    ...(view.peerProviderId === undefined ? {} : { peerProviderId: view.peerProviderId }),
    ...(view.candidate === undefined ? {} : { candidate: { value: view.candidate.commit, evidence: 'detected' as const } }),
  };
}

/**
 * Project status is the same for every viewer that may see it — Supervisor, Lead and the
 * operator — except that `countSettled` counts settled assignments instead of listing them, so a
 * long-lived project fits one Supervisor tool result. `ViewerRole` has no Peer member, so a Peer
 * cannot be handed a view at all.
 */
export function projectStatusView(input: StatusInput, options: { readonly countSettled?: boolean } = {}): ProjectStatusView {
  const found = findings(input);
  const paused = found.some(finding => finding.kind === 'project-paused' || finding.kind === 'ownership-conflict');
  // The one writer in Lead's workspace; isolated writers are listed under `leases`.
  const writer = leadWorkspaceWriter(input.state);
  const all = [...input.state.assignments.values()];
  const shown = options.countSettled === true ? all.filter(view => !settled(view)) : all;
  return {
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    health: { value: paused ? 'paused' : found.length > 0 ? 'attention' : 'healthy', evidence: 'detected' },
    liveFacts: input.liveAvailable ? 'fresh' : 'stale',
    ...(writer === undefined ? {} : { writer: { assignmentId: writer.assignmentId, state: { value: writer.state, evidence: writer.state === 'uncertain' ? 'unverifiable' : 'enforced' } } }),
    leases: activeLeases(input.state).flatMap(owner => leaseView(input.state, owner.assignmentId) ?? []),
    worktrees: [...dispositions(input.state, input.present)].filter(([, disposition]) => disposition !== 'gone').map(([record, disposition]) => worktreeView(record, disposition)),
    scopeStatement: SCOPE_STATEMENT,
    assignments: shown.map(summary),
    ...(options.countSettled === true ? { settledAssignments: all.length - shown.length } : {}),
    findings: found,
  };
}

/** Full assignment detail is for Lead and the operator; Supervisor observes summaries only. */
export function assignmentDetailView(state: ProjectState, assignmentId: string, role: ViewerRole, present?: (path: string) => boolean): AssignmentDetailView | undefined {
  if (role === 'supervisor') return undefined;
  const view = state.assignments.get(assignmentId);
  if (view === undefined) return undefined;
  const owner = state.ownership.get(view.id);
  const lease = leaseView(state, view.id);
  const record = state.workspaces.get(view.id);
  const handoff = [...view.reports].reverse().find(report => report.tool === 'handoff');
  const verification = Array.isArray(handoff?.report.verification) ? handoff.report.verification as readonly { command?: unknown; outcome?: unknown }[] : [];
  return {
    ...summary(view),
    brief: view.input,
    leadAgentId: view.leadAgentId,
    ...(view.peerAgentId === undefined ? {} : { peerAgentId: view.peerAgentId }),
    ...(view.observedModel === undefined ? {} : { observedModel: view.observedModel }),
    reportingGeneration: view.reportingGeneration,
    // The Peer's own gate report is a procedural claim: the runtime cannot prove it ran.
    peerVerification: verification.map(entry => ({ value: { command: String(entry.command), outcome: String(entry.outcome) }, evidence: 'procedural' as const })),
    runtimeGates: view.gates.map(gate => ({
      value: { gateRunId: gate.gateRunId, status: gate.status, ...(gate.result?.exitCode === undefined ? {} : { exitCode: gate.result.exitCode }) },
      evidence: gate.status === 'uncertain' ? 'unverifiable' as const : 'enforced' as const,
    })),
    ...(owner === undefined ? {} : { ownership: { value: owner.state, evidence: owner.state === 'uncertain' ? 'unverifiable' as const : 'enforced' as const } }),
    ...(lease === undefined ? {} : { lease }),
    ...(record === undefined ? {} : { worktree: worktreeView(record, worktreeDisposition(state, record, present)) }),
    ...(view.scopeExceeded === undefined ? {} : { scopeExceeded: { value: { candidateCommit: view.scopeExceeded.candidateCommit, paths: view.scopeExceeded.paths }, evidence: 'detected' as const } }),
    history: view.eventIds,
  };
}

/** A stable content revision: unchanged views keep the same revision. */
export function revision(view: unknown): string {
  return sha256(canonicalJson(view)).slice('sha256:'.length, 'sha256:'.length + 24);
}

export interface QuiescenceBlocker {
  readonly kind: 'assignment' | 'ownership' | 'lease' | 'worktree' | 'archive' | 'gate' | 'delivery' | 'intent';
  readonly id: string;
  readonly detail: string;
}

/**
 * True when nothing the runtime started is still active or uncertain, so deselection cannot
 * strand a writer, a managed Peer, a gate or a delivery (docs/design/runtime-coordination.md §10),
 * a worktree lease or an unresolved worktree create or close (Phase 2 delta §8). A retained
 * worktree whose writer is released does not block: it is Paseo's, and stays for a decision.
 */
export function quiescence(state: ProjectState): { readonly quiescent: boolean; readonly blockers: readonly QuiescenceBlocker[] } {
  const blockers: QuiescenceBlocker[] = [];
  for (const view of state.assignments.values()) {
    if (view.state !== 'draft' && !TERMINAL_STATES.includes(view.state)) blockers.push({ kind: 'assignment', id: view.id, detail: `is ${view.state}` });
    if (view.peerAgentId !== undefined && view.closure !== 'closed') blockers.push({ kind: 'archive', id: view.id, detail: `managed Peer ${view.peerAgentId} is not archived (${view.closure})` });
    for (const gate of view.gates) {
      // A running gate always blocks. An uncertain one blocks until its Peer is proven archived:
      // after that nothing can act on it, and nothing could ever settle it further.
      if (gate.status === 'running' || (gate.status === 'uncertain' && view.closure !== 'closed')) {
        blockers.push({ kind: 'gate', id: gate.gateRunId, detail: `gate is ${gate.status}` });
      }
    }
    for (const [intent, type] of Object.entries(view.openIntents)) blockers.push({ kind: 'intent', id: intent, detail: `${type} has no result` });
  }
  for (const owner of state.ownership.values()) {
    if (owner.state === 'released') continue;
    blockers.push(owner.lease === undefined
      ? { kind: 'ownership', id: owner.assignmentId, detail: `writer ownership is ${owner.state}` }
      : { kind: 'lease', id: owner.assignmentId, detail: `worktree lease (epoch ${String(owner.lease.epoch)}) is ${owner.state}` });
  }
  for (const record of state.workspaces.values()) {
    if (worktreeDisposition(state, record) === 'unresolved') {
      blockers.push({ kind: 'worktree', id: record.workspaceId, detail: `worktree of ${record.assignmentId} is unresolved (create ${record.create}, close ${record.close})` });
    }
  }
  for (const notice of state.notices.values()) {
    if (notice.state === 'pending' || notice.state === 'uncertain') blockers.push({ kind: 'delivery', id: notice.noticeId, detail: `notice is ${notice.state}` });
  }
  return { quiescent: blockers.length === 0, blockers };
}

/** Runtime worktrees that may still be on disk: retained ones Paseo still lists, and leftover directories. */
export function worktreesOnDisk(state: ProjectState, present?: (path: string) => boolean): { readonly retained: number; readonly leftover: number } {
  const values = [...dispositions(state, present).values()];
  return { retained: values.filter(value => value === 'retained').length, leftover: values.filter(value => value === 'leftover').length };
}
