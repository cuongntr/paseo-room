import { describe, expect, it } from 'vitest';
import { evaluateAcceptance } from '../src/runtime-plugin/server/domain/acceptance.js';
import { actionFingerprint, canonicalJson, resolveReceipt } from '../src/runtime-plugin/server/domain/receipts.js';
import type { AcceptedReport, AssignmentView, GateRun } from '../src/runtime-plugin/server/domain/state.js';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const candidate = { kind: 'git-commit' as const, commit: HEAD, baseCommit: BASE, changedPaths: ['src/a.ts'], workspaceId: 'ws1' };

function view(change: Partial<AssignmentView> = {}): AssignmentView {
  return {
    id: 'asg_abcdefgh', leadAgentId: 'lead', leadProviderId: 'codex-lead', state: 'active', closure: 'open',
    reportingGeneration: 1, reportingState: 'open', runGeneration: 1, reports: [], gates: [], openIntents: {}, eventIds: [],
    input: {
      mode: 'writable', kind: 'engineer', outcome: 'x', prerequisites: [], writeScope: ['src/'], exclusions: ['none'],
      invariants: [], acceptanceEvidence: [], expectedHandoff: ['commit'], reopenConditions: [], baseCommit: BASE,
      gate: { command: 'npm run verify', timeoutSeconds: 600, runtimeRerun: 'optional', processContractVersion: 1 },
    },
    ...change,
  };
}

function accepted(generation: number, requestId: string, payload: unknown, tool: 'ask' | 'handoff' = 'ask'): AcceptedReport {
  return {
    generation, tool, requestId, fingerprint: actionFingerprint(generation, tool, payload),
    receipt: { schema: 1, receipt: `rcpt_${requestId}`, tool, status: 'accepted', assignmentState: tool === 'ask' ? 'questioned' : 'handed-back' },
    report: payload as Record<string, unknown>, eventId: `evt_${requestId}`,
  };
}

describe('report receipts', () => {
  const payload = { question: 'Which base?', blockingContext: 'two', evidence: ['log'] };

  it('fingerprints canonically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(actionFingerprint(1, 'ask', { evidence: ['log'], blockingContext: 'two', question: 'Which base?' }))
      .toBe(actionFingerprint(1, 'ask', payload));
    expect(actionFingerprint(2, 'ask', payload)).not.toBe(actionFingerprint(1, 'ask', payload));
    expect(actionFingerprint(1, 'handoff', payload)).not.toBe(actionFingerprint(1, 'ask', payload));
  });

  it('proceeds only for a fresh action on the open generation', () => {
    expect(resolveReceipt(view(), { generation: 1, requestId: 'req_1', fingerprint: actionFingerprint(1, 'ask', payload) })).toEqual({ kind: 'proceed' });
  });

  it('replays the receipt for the same request id or the same accepted fingerprint under a new id', () => {
    const report = accepted(1, 'req_1', payload);
    const consumed = view({ state: 'questioned', reportingState: 'consumed', reports: [report] });
    expect(resolveReceipt(consumed, { generation: 1, requestId: 'req_1', fingerprint: report.fingerprint })).toEqual({ kind: 'replay', receipt: report.receipt });
    expect(resolveReceipt(consumed, { generation: 1, requestId: 'req_2', fingerprint: report.fingerprint })).toEqual({ kind: 'replay', receipt: report.receipt });
  });

  it('refuses a reused id with another payload, a different action for a consumed turn, and stale turns', () => {
    const report = accepted(1, 'req_1', payload);
    const consumed = view({ state: 'questioned', reportingState: 'consumed', reports: [report] });
    const other = actionFingerprint(1, 'ask', { ...payload, question: 'Other?' });
    expect(resolveReceipt(consumed, { generation: 1, requestId: 'req_1', fingerprint: other })).toMatchObject({ kind: 'refuse', code: 'report_conflict' });
    expect(resolveReceipt(consumed, { generation: 1, requestId: 'req_3', fingerprint: other })).toMatchObject({ kind: 'refuse', code: 'report_stale' });

    const later = view({ reportingGeneration: 3 });
    expect(resolveReceipt(later, { generation: 2, requestId: 'req_4', fingerprint: other })).toMatchObject({ kind: 'refuse', code: 'report_stale' });
    expect(resolveReceipt(view({ reportingState: 'closed' }), { generation: 1, requestId: 'req_5', fingerprint: other })).toMatchObject({ kind: 'refuse', code: 'report_stale' });
    expect(resolveReceipt(view({ reportingState: 'uncertain' }), { generation: 1, requestId: 'req_6', fingerprint: other })).toMatchObject({ kind: 'refuse', code: 'report_uncertain' });
    // An old generation's accepted receipt still replays after the turn moved on.
    const moved = view({ reportingGeneration: 2, reports: [report] });
    expect(resolveReceipt(moved, { generation: 1, requestId: 'req_1', fingerprint: report.fingerprint })).toMatchObject({ kind: 'replay' });
  });
});

describe('writable acceptance', () => {
  const handoff = (outcome: 'passed' | 'failed' | 'not-run', command = 'npm run verify'): AcceptedReport =>
    accepted(1, 'req_h', { completion: 'complete', verification: [{ command, outcome }] }, 'handoff');
  const handedBack = (outcome: 'passed' | 'failed' | 'not-run', change: Partial<AssignmentView> = {}): AssignmentView =>
    view({ state: 'handed-back', reportingState: 'consumed', candidate, reports: [handoff(outcome)], ...change });
  const gate = (exitCode: number, status: GateRun['status'] = 'finished', moved = false): GateRun => ({
    gateRunId: 'g1', candidate, command: 'npm run verify', status,
    ...(status === 'finished' ? { result: {
      id: 'g1', assignmentId: 'asg_abcdefgh', candidate, command: 'npm run verify', startedAt: '2026-09-22T10:00:00Z',
      timedOut: false, termination: 'exited' as const, exitCode, processContractVersion: 1 as const, environmentPolicyVersion: 1 as const,
      outputDigest: `sha256:${'0'.repeat(64)}`, workspaceMoved: moved,
    } } : {}),
  });
  const required = (change: Partial<AssignmentView> = {}): AssignmentView => {
    const base = handedBack('passed', change);
    const gateSpec = base.input.gate;
    if (gateSpec === undefined) throw new Error('fixture needs a gate');
    return { ...base, input: { ...base.input, gate: { ...gateSpec, runtimeRerun: 'required' } } };
  };

  it('accepts green evidence with a reason and refuses a blank reason or wrong state', () => {
    expect(evaluateAcceptance(handedBack('passed'), { reason: 'Meets the outcome.', observedHead: HEAD })).toEqual({ ok: true, red: false });
    expect(evaluateAcceptance(handedBack('passed'), { reason: ' ' })).toMatchObject({ ok: false, code: 'reason_missing' });
    expect(evaluateAcceptance(view(), { reason: 'x' })).toMatchObject({ ok: false, code: 'not_handed_back' });
  });

  it('binds acceptance to the exact candidate and a reported Peer gate', () => {
    expect(evaluateAcceptance(handedBack('passed'), { reason: 'x', observedHead: BASE })).toMatchObject({ code: 'candidate_moved' });
    expect(evaluateAcceptance(handedBack('passed', { candidate: undefined as never }), { reason: 'x' })).toMatchObject({ code: 'candidate_missing' });
    expect(evaluateAcceptance(handedBack('not-run'), { reason: 'x' })).toMatchObject({ code: 'peer_gate_missing' });
    expect(evaluateAcceptance(handedBack('passed', { reports: [handoff('passed', 'npm test')] }), { reason: 'x' })).toMatchObject({ code: 'peer_gate_missing' });
  });

  it('requires an override for red evidence but never forbids acceptance', () => {
    expect(evaluateAcceptance(handedBack('failed'), { reason: 'x' })).toMatchObject({ code: 'override_required' });
    expect(evaluateAcceptance(handedBack('failed'), { reason: 'x', override: { reason: 'Known flake, tracked.', residualRiskAcknowledged: true } }))
      .toEqual({ ok: true, red: true });
  });

  it('keeps acceptance disabled until a required rerun is terminal, and treats its red result as an override case', () => {
    expect(evaluateAcceptance(required(), { reason: 'x' })).toMatchObject({ code: 'rerun_required' });
    expect(evaluateAcceptance(required({ gates: [gate(0, 'running')] }), { reason: 'x' })).toMatchObject({ code: 'rerun_pending' });
    expect(evaluateAcceptance(required({ gates: [gate(0)] }), { reason: 'x' })).toMatchObject({ ok: true, red: false });
    expect(evaluateAcceptance(required({ gates: [gate(1)] }), { reason: 'x' })).toMatchObject({ code: 'override_required' });
    expect(evaluateAcceptance(required({ gates: [gate(0, 'finished', true)] }), { reason: 'x' })).toMatchObject({ code: 'candidate_moved' });
    // An optional rerun that never ran does not block.
    expect(evaluateAcceptance(handedBack('passed'), { reason: 'x' }).ok).toBe(true);
  });

  it('accepts read-only work on a reason alone', () => {
    const readOnly = view({ state: 'handed-back', input: { ...view().input, mode: 'read-only', kind: 'reviewer', writeScope: [] } });
    expect(evaluateAcceptance(readOnly, { reason: 'Findings are sound.' })).toEqual({ ok: true, red: false });
  });
});
