import { describe, expect, it } from 'vitest';
import type { RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';
import { A, B, candidate, created, DIGEST, dispatched, ev, PROJECT, R, receipt } from './runtime-fixtures.js';
import { activeWriter, applyEvent, checkEvent, emptyProjectState, project, type ProjectState } from '../src/runtime-plugin/server/domain/state.js';

function fold(events: readonly RuntimeEventV1[]): ProjectState {
  const result = project(PROJECT, events);
  expect(result.violations).toEqual([]);
  return result.state;
}

function refused(state: ProjectState, event: RuntimeEventV1): string | undefined {
  return checkEvent(state, event);
}

describe('assignment state machine', () => {
  it('walks a writable assignment from draft to released ownership', () => {
    const events = [
      ev('project.bound', { canonicalRoot: '/r', gitCommonDir: '/r/.git' }),
      ...dispatched(A),
      ev('report.accepted', { generation: 1, tool: 'ask', requestId: 'req_00000001', fingerprint: DIGEST, receipt: receipt('ask', 'questioned'), report: { question: 'q' } }, A),
      ev('assignment.answered', { answer: 'Use main.' }, A),
      ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'answer' }, A),
      ev('run.requested', { intentId: 'run-2', generation: 2, promptDigest: DIGEST }, A),
      ev('run.succeeded', { intentId: 'run-2', generation: 2 }, A),
      ev('report.accepted', { generation: 2, tool: 'handoff', requestId: 'req_00000002', fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'), report: {}, candidate }, A),
      ev('assignment.accepted', { candidate, reason: 'Meets the outcome.' }, A),
      ev('assignment.close-requested', {}, A),
      ev('archive.requested', { intentId: 'arch-1', agentId: `peer-${A}` }, A),
      ev('ownership.releasing', { agentId: `peer-${A}` }, A),
      ev('archive.succeeded', { intentId: 'arch-1', agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z', liveStatus: 'closed' }, A),
      ev('ownership.released', { agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z' }, A),
    ];
    const state = fold(events);
    const view = state.assignments.get(A);
    expect(view).toMatchObject({ state: 'accepted', closure: 'closed', reportingGeneration: 2, reportingState: 'consumed', candidate });
    expect(view?.reports.map(report => report.tool)).toEqual(['ask', 'handoff']);
    expect(view?.openIntents).toEqual({});
    expect(state.ownership.get(A)?.state).toBe('released');
    expect(activeWriter(state)).toBeUndefined();
  });

  it('keeps writer ownership held through every technical decision until archive is proven', () => {
    for (const decision of [
      ev('assignment.accepted', { candidate, reason: 'ok' }, A),
      ev('assignment.rejected', { reason: 'no' }, A),
      ev('assignment.abandoned', { reason: 'stop' }, A),
    ]) {
      const state = fold([
        ...dispatched(A),
        ev('report.accepted', { generation: 1, tool: 'handoff', requestId: 'req_00000009', fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'), report: {}, candidate }, A),
        decision,
      ]);
      expect(state.ownership.get(A)?.state).toBe('held');
      expect(activeWriter(state)?.assignmentId).toBe(A);
      // Release without archive is refused.
      expect(refused(state, ev('ownership.released', { agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z' }, A))).toBeDefined();
    }
  });

  it('allows only one writer per project while ownership is not released', () => {
    const state = fold([...dispatched(A), created(B)]);
    expect(refused(state, ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: 'ws1' }, B))).toMatch(/Another writer/);
    // A read-only assignment is not a writer and may dispatch alongside.
    const withReader = fold([...dispatched(A), ...dispatched(R, 'read-only')]);
    expect(withReader.assignments.get(R)?.state).toBe('active');
    expect(withReader.ownership.has(R)).toBe(false);
  });

  it('refuses illegal edges', () => {
    const draft = fold([created(A)]);
    const active = fold(dispatched(A));
    const cases: [ProjectState, RuntimeEventV1][] = [
      [draft, ev('assignment.accepted', { reason: 'x' }, A)],
      [draft, ev('ownership.held', { agentId: 'x' }, A)],
      [draft, ev('reporting.generation-opened', { generation: 1, capabilityHash: DIGEST, turn: 'initial' }, A)],
      [draft, ev('assignment.created', created(A).data, A)],
      [active, ev('assignment.rework-requested', { instructions: 'x' }, A)],
      [active, ev('assignment.accepted', { reason: 'x' }, A)],
      [active, ev('assignment.abandoned', { reason: 'x' }, A)],
      [active, ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'answer' }, A)],
      [active, ev('report.accepted', { generation: 2, tool: 'ask', requestId: 'req_0000000a', fingerprint: DIGEST, receipt: receipt('ask', 'questioned'), report: {} }, A)],
      [active, ev('assignment.close-requested', {}, A)],
      [active, ev('run.requested', { intentId: 'again', generation: 1, promptDigest: DIGEST }, A)],
      [active, ev('agent.create-succeeded', { intentId: 'nope', agentId: 'x' }, A)],
      [active, ev('gate.requested', { gateRunId: 'g', candidate, command: 'x', timeoutSeconds: 1, processContractVersion: 1, environmentPolicyVersion: 1 }, A)],
      [active, ev('ownership.held', { agentId: 'x' }, 'asg_unknown000')],
    ];
    for (const [state, event] of cases) expect(refused(state, event), event.type).toBeDefined();
  });

  it('opens generations one at a time, only from the matching state', () => {
    const questioned = fold([
      ...dispatched(A),
      ev('report.accepted', { generation: 1, tool: 'ask', requestId: 'req_0000000b', fingerprint: DIGEST, receipt: receipt('ask', 'questioned'), report: {} }, A),
    ]);
    expect(refused(questioned, ev('reporting.generation-opened', { generation: 3, capabilityHash: DIGEST, turn: 'answer' }, A))).toMatch(/exactly one/);
    expect(refused(questioned, ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'rework' }, A))).toBeDefined();
    expect(refused(questioned, ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'answer' }, A))).toBeUndefined();
    // A second accepted report for a consumed generation is refused.
    expect(refused(questioned, ev('report.accepted', { generation: 1, tool: 'ask', requestId: 'req_0000000c', fingerprint: DIGEST, receipt: receipt('ask', 'questioned'), report: {} }, A))).toBeDefined();
  });

  it('holds the generation open while a reporting permission is pending, then blocks on a missing report', () => {
    const state = fold([
      ...dispatched(A),
      ev('permission.awaiting', { generation: 1, permissionRequestId: 'perm-1', tool: 'handoff' }, A),
    ]);
    expect(state.assignments.get(A)).toMatchObject({ state: 'awaiting-permission', reportingState: 'open', awaitingPermissionId: 'perm-1' });
    const resolved = fold([
      ...dispatched(A),
      ev('permission.awaiting', { generation: 1, permissionRequestId: 'perm-1', tool: 'handoff' }, A),
      ev('permission.resolved', { generation: 1, permissionRequestId: 'perm-1', outcome: 'denied' }, A),
      ev('report.missing', { generation: 1 }, A),
    ]);
    expect(resolved.assignments.get(A)).toMatchObject({ state: 'blocked', reportingState: 'consumed' });
    expect(resolved.assignments.get(A)?.awaitingPermissionId).toBeUndefined();
  });

  it('leaves uncertain only on bounded evidence and never opens a generation from it', () => {
    const uncertain = fold([
      ...dispatched(A).slice(0, -1),
      ev('run.uncertain', { intentId: `run-${A}-1`, generation: 1, reason: 'Delivery unknown.' }, A),
    ]);
    expect(uncertain.assignments.get(A)).toMatchObject({ state: 'uncertain', reportingState: 'uncertain' });
    expect(refused(uncertain, ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'follow-up' }, A))).toBeDefined();
    expect(refused(uncertain, ev('assignment.abandoned', { reason: 'x' }, A))).toBeDefined();

    const reported = fold([...dispatched(A).slice(0, -1),
      ev('run.uncertain', { intentId: `run-${A}-1`, generation: 1, reason: 'x' }, A),
      ev('report.accepted', { generation: 1, tool: 'handoff', requestId: 'req_0000000d', fingerprint: DIGEST, receipt: receipt('handoff', 'blocked'), report: {} }, A),
    ]);
    expect(reported.assignments.get(A)?.state).toBe('blocked');

    const missing = fold([...dispatched(A).slice(0, -1),
      ev('run.uncertain', { intentId: `run-${A}-1`, generation: 1, reason: 'x' }, A),
      ev('report.missing', { generation: 1 }, A),
    ]);
    expect(missing.assignments.get(A)?.state).toBe('blocked');

    const failedCreate = fold([
      ...dispatched(A).slice(0, 4),
      ev('agent.create-uncertain', { intentId: `create-${A}`, reason: 'x' }, A),
      ev('agent.create-failed', { intentId: `create-${A}`, reason: 'No such agent.' }, A),
    ]);
    expect(failedCreate.assignments.get(A)?.state).toBe('blocked');
    expect(failedCreate.ownership.get(A)?.state).toBe('released');
  });

  it('stops folding at the first illegal event in a ledger', () => {
    const events = [created(A), ev('assignment.accepted', { reason: 'x' }, A), ev('assignment.abandoned', { reason: 'y' }, A)];
    const result = project(PROJECT, events);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.type).toBe('assignment.accepted');
    expect(result.state.assignments.get(A)?.state).toBe('draft');
  });

  it('pauses dispatch while a Lead ownership conflict is open', () => {
    const state = emptyProjectState(PROJECT);
    for (const event of [created(A), ev('project.ownership-conflict', { leadAgentIds: ['lead-1', 'lead-2'], leadProviderIds: ['codex-lead'] })]) {
      expect(checkEvent(state, event)).toBeUndefined();
      applyEvent(state, event);
    }
    expect(refused(state, ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: 'ws1' }, A))).toMatch(/conflict/);
  });
});
