/**
 * Writable acceptance rules (docs/design/runtime-coordination.md D6, §5.1).
 *
 * A pass is never acceptance and a red result never forbids it: acceptance is Lead's explicit
 * decision, bound to the exact candidate and carrying an override when the evidence is red. A
 * missing Peer gate produces no candidate at all, and a missing required rerun keeps acceptance
 * disabled — neither can be waived after handoff.
 */
import type { AssignmentView, GateRun } from './state.js';

export type AcceptanceCode =
  | 'not_handed_back' | 'reason_missing' | 'candidate_missing' | 'candidate_moved' | 'peer_gate_missing'
  | 'rerun_required' | 'rerun_pending' | 'override_required';

export interface AcceptanceRequest {
  readonly reason: string;
  readonly override?: { readonly reason: string; readonly residualRiskAcknowledged: true };
  /** HEAD the Git port observed in the assigned workspace just now, when writable. */
  readonly observedHead?: string;
}

export type AcceptanceDecision =
  | { readonly ok: true; readonly red: boolean; readonly gate?: GateRun }
  | { readonly ok: false; readonly code: AcceptanceCode; readonly message: string };

function peerVerification(view: AssignmentView): 'passed' | 'failed' | 'not-run' | undefined {
  const handoff = [...view.reports].reverse().find(report => report.tool === 'handoff');
  const command = view.input.gate?.command;
  const entries = handoff?.report.verification;
  if (command === undefined || !Array.isArray(entries)) return undefined;
  const match = (entries as readonly { command?: unknown; outcome?: unknown }[]).filter(entry => entry.command === command).at(-1);
  const outcome = match?.outcome;
  return outcome === 'passed' || outcome === 'failed' || outcome === 'not-run' ? outcome : undefined;
}

function rerunIsRed(gate: GateRun): boolean {
  const result = gate.result;
  return result === undefined || result.timedOut || result.termination !== 'exited' || result.exitCode !== 0 || result.workspaceMoved;
}

export function evaluateAcceptance(view: AssignmentView, request: AcceptanceRequest): AcceptanceDecision {
  const refuse = (code: AcceptanceCode, message: string): AcceptanceDecision => ({ ok: false, code, message });
  if (view.state !== 'handed-back') return refuse('not_handed_back', `Only a handed-back assignment can be accepted; this one is ${view.state}.`);
  if (request.reason.trim() === '') return refuse('reason_missing', 'State the technical reason for accepting.');
  if (view.input.mode === 'read-only') return { ok: true, red: false };

  const candidate = view.candidate;
  if (candidate === undefined) return refuse('candidate_missing', 'There is no validated candidate to accept.');
  if (request.observedHead !== undefined && request.observedHead !== candidate.commit) {
    return refuse('candidate_moved', `The workspace moved from ${candidate.commit} to ${request.observedHead}; request a new handoff.`);
  }
  const peer = peerVerification(view);
  if (peer === undefined || peer === 'not-run') return refuse('peer_gate_missing', 'The Peer did not report the named gate; there is nothing to accept.');

  const bound = view.gates.filter(gate => gate.candidate.commit === candidate.commit);
  const finished = bound.filter(gate => gate.status === 'finished').at(-1);
  if (finished?.result?.workspaceMoved === true) return refuse('candidate_moved', 'The workspace moved during the runtime gate; request a new handoff.');
  const required = view.input.gate?.runtimeRerun === 'required';
  if (required && finished === undefined) {
    return bound.some(gate => gate.status === 'running')
      ? refuse('rerun_pending', 'The required runtime gate is still running.')
      : refuse('rerun_required', 'This assignment requires a runtime gate rerun on the candidate before acceptance.');
  }
  const red = peer === 'failed' || (required && finished !== undefined && rerunIsRed(finished));
  if (red && (request.override === undefined || request.override.reason.trim() === '')) {
    return refuse('override_required', 'The gate evidence is red: accepting it needs an override reason and a residual-risk acknowledgement.');
  }
  return { ok: true, red, ...(finished === undefined ? {} : { gate: finished }) };
}
