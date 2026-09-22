/**
 * Role-filtered status views (docs/design/runtime-coordination.md D8, D9, §8.1, §8.2).
 *
 * Every claim carries its evidence class. "Healthy" means no known enforced or detected failure;
 * it never means a model obeyed its prompt or that the operating system contained anything.
 * Every degraded or pending item names one bounded recovery action. Peer receives no view.
 */
import type { RuntimeEventV1 } from '../events/schema.js';
import { canonicalJson, sha256 } from './receipts.js';
import { TERMINAL_STATES, type AssignmentView, type ProjectState, type Violation } from './state.js';

export type EvidenceClass = 'enforced' | 'detected' | 'procedural' | 'unverifiable';
export type ViewerRole = 'operator' | 'supervisor' | 'lead';

export interface Claim<T> {
  readonly value: T;
  readonly evidence: EvidenceClass;
}

export type FindingKind =
  | 'project-paused' | 'ownership-conflict' | 'uncertain-effect' | 'report-missing' | 'report-uncertain'
  | 'awaiting-permission' | 'notice-failed';

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

export interface ProjectStatusView {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly health: Claim<'healthy' | 'attention' | 'paused'>;
  readonly liveFacts: 'fresh' | 'stale';
  readonly writer?: { readonly assignmentId: string; readonly state: Claim<string> };
  readonly assignments: readonly AssignmentSummary[];
  readonly findings: readonly Finding[];
}

export interface AssignmentDetailView extends AssignmentSummary {
  readonly brief: AssignmentView['input'];
  readonly leadAgentId: string;
  readonly peerAgentId?: string;
  readonly observedModel?: string;
  readonly reportingGeneration: number;
  readonly peerVerification: readonly Claim<{ readonly command: string; readonly outcome: string }>[];
  readonly runtimeGates: readonly Claim<{ readonly gateRunId: string; readonly status: string; readonly exitCode?: number }>[];
  readonly ownership?: Claim<string>;
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
} as const;

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
  for (const view of input.state.assignments.values()) {
    const owner = input.state.ownership.get(view.id);
    if (view.state === 'uncertain' || view.closure === 'uncertain' || owner?.state === 'uncertain' || view.gates.some(gate => gate.status === 'uncertain')) {
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
 * operator. `ViewerRole` has no Peer member, so a Peer cannot be handed a view at all.
 */
export function projectStatusView(input: StatusInput): ProjectStatusView {
  const found = findings(input);
  const paused = found.some(finding => finding.kind === 'project-paused' || finding.kind === 'ownership-conflict');
  const writer = [...input.state.ownership.values()].find(owner => owner.state !== 'released');
  return {
    projectId: input.projectId,
    canonicalRoot: input.canonicalRoot,
    health: { value: paused ? 'paused' : found.length > 0 ? 'attention' : 'healthy', evidence: 'detected' },
    liveFacts: input.liveAvailable ? 'fresh' : 'stale',
    ...(writer === undefined ? {} : { writer: { assignmentId: writer.assignmentId, state: { value: writer.state, evidence: writer.state === 'uncertain' ? 'unverifiable' : 'enforced' } } }),
    assignments: [...input.state.assignments.values()].map(summary),
    findings: found,
  };
}

/** Full assignment detail is for Lead and the operator; Supervisor observes summaries only. */
export function assignmentDetailView(state: ProjectState, assignmentId: string, role: ViewerRole): AssignmentDetailView | undefined {
  if (role === 'supervisor') return undefined;
  const view = state.assignments.get(assignmentId);
  if (view === undefined) return undefined;
  const owner = state.ownership.get(view.id);
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
    history: view.eventIds,
  };
}

/** A stable content revision: unchanged views keep the same revision. */
export function revision(view: unknown): string {
  return sha256(canonicalJson(view)).slice('sha256:'.length, 'sha256:'.length + 24);
}

export interface QuiescenceBlocker {
  readonly kind: 'assignment' | 'ownership' | 'archive' | 'gate' | 'delivery' | 'intent';
  readonly id: string;
  readonly detail: string;
}

/**
 * True when nothing the runtime started is still active or uncertain, so deselection cannot
 * strand a writer, a managed Peer, a gate or a delivery (docs/design/runtime-coordination.md §10).
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
    if (owner.state !== 'released') blockers.push({ kind: 'ownership', id: owner.assignmentId, detail: `writer ownership is ${owner.state}` });
  }
  for (const notice of state.notices.values()) {
    if (notice.state === 'pending' || notice.state === 'uncertain') blockers.push({ kind: 'delivery', id: notice.noticeId, detail: `notice is ${notice.state}` });
  }
  return { quiescent: blockers.length === 0, blockers };
}
