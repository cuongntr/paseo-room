import { describe, expect, it } from 'vitest';
import type { RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';
import { project } from '../src/runtime-plugin/server/domain/state.js';
import {
  assignmentDetailView, findings, projectStatusView, quiescence, revision, type StatusInput,
} from '../src/runtime-plugin/server/domain/views.js';
import { A, candidate, DIGEST, dispatched, ev, PROJECT, receipt } from './runtime-fixtures.js';

function input(events: readonly RuntimeEventV1[], change: Partial<StatusInput> = {}): StatusInput {
  const { state, violations } = project(PROJECT, events);
  return { projectId: PROJECT, canonicalRoot: '/repo', replay: { status: 'ok', problems: [] }, violations, state, events, liveAvailable: true, ...change };
}

const handedBack = (): RuntimeEventV1[] => [
  ...dispatched(A),
  ev('report.accepted', {
    generation: 1, tool: 'handoff', requestId: 'req_00000001', fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'),
    report: { verification: [{ command: 'npm run verify', outcome: 'passed' }] }, candidate,
  }, A),
];

describe('runtime status views', () => {
  it('reports a healthy project with evidence classes on every claim', () => {
    const view = projectStatusView(input(handedBack()));
    expect(view.health).toEqual({ value: 'healthy', evidence: 'detected' });
    expect(view.liveFacts).toBe('fresh');
    expect(view.writer).toEqual({ assignmentId: A, state: { value: 'held', evidence: 'enforced' } });
    expect(view.assignments[0]).toMatchObject({ id: A, state: { value: 'handed-back', evidence: 'enforced' }, candidate: { value: candidate.commit, evidence: 'detected' } });
    expect(projectStatusView(input(handedBack(), { liveAvailable: false })).liveFacts).toBe('stale');
  });

  it('labels the Peer gate as procedural and hides detail from Supervisor', () => {
    const { state } = project(PROJECT, handedBack());
    const detail = assignmentDetailView(state, A, 'lead');
    expect(detail?.peerVerification).toEqual([{ value: { command: 'npm run verify', outcome: 'passed' }, evidence: 'procedural' }]);
    expect(detail?.ownership).toEqual({ value: 'held', evidence: 'enforced' });
    expect(assignmentDetailView(state, A, 'operator')?.brief.outcome).toBe('Do it');
    expect(assignmentDetailView(state, A, 'supervisor')).toBeUndefined();
  });

  it('derives Phase 1 findings with source events and a recovery action', () => {
    const missing = [...dispatched(A), ev('report.missing', { generation: 1 }, A)];
    const missingFindings = findings(input(missing));
    expect(missingFindings).toEqual([expect.objectContaining({ kind: 'report-missing', assignmentId: A, sourceEventIds: [missing.at(-1)?.id] })]);
    expect(missingFindings[0]?.recoveryAction).toMatch(/not a report/);

    const permission = [...dispatched(A), ev('permission.awaiting', { generation: 1, permissionRequestId: 'p1', tool: 'ask' }, A)];
    expect(findings(input(permission)).map(finding => finding.kind)).toEqual(['awaiting-permission']);

    const uncertain = [...dispatched(A).slice(0, -1), ev('run.uncertain', { intentId: `run-${A}-1`, generation: 1, reason: 'x' }, A)];
    expect(findings(input(uncertain))[0]).toMatchObject({ kind: 'report-uncertain', evidence: 'unverifiable' });

    const conflict = [ev('project.ownership-conflict', { leadAgentIds: ['l1', 'l2'], leadProviderIds: ['codex-lead'] })];
    expect(projectStatusView(input(conflict)).health.value).toBe('paused');

    const notice = [ev('notice.pending', { noticeId: 'n1', kind: 'question', class: 'owner', disposition: 'lead-now', text: 'Q' }), ev('notice.failed', { noticeId: 'n1', reason: 'Lead gone.' })];
    expect(findings(input(notice))[0]).toMatchObject({ kind: 'notice-failed', evidence: 'detected' });

    const paused = projectStatusView(input([], { replay: { status: 'paused', problems: [{ file: '000000000002.json', reason: 'invalid', detail: 'x' }] } }));
    expect(paused.health.value).toBe('paused');
    expect(paused.findings[0]?.message).toContain('000000000002.json');
  });

  it('keeps an unchanged view on the same revision and changes it on any event', () => {
    const events = handedBack();
    expect(revision(projectStatusView(input(events)))).toBe(revision(projectStatusView(input(events))));
    const more = [...events, ev('assignment.rework-requested', { instructions: 'Tighten it.' }, A)];
    expect(revision(projectStatusView(input(more)))).not.toBe(revision(projectStatusView(input(events))));
  });

  it('is quiescent only when no assignment, writer, archive, gate, intent or delivery is outstanding', () => {
    expect(quiescence(project(PROJECT, []).state)).toEqual({ quiescent: true, blockers: [] });
    const active = quiescence(project(PROJECT, dispatched(A)).state);
    expect(active.quiescent).toBe(false);
    expect(active.blockers.map(blocker => blocker.kind).sort()).toEqual(['archive', 'assignment', 'ownership']);

    const done = quiescence(project(PROJECT, [
      ...handedBack(),
      ev('assignment.accepted', { candidate, reason: 'ok' }, A),
      ev('assignment.close-requested', {}, A),
      ev('archive.requested', { intentId: 'arch', agentId: `peer-${A}` }, A),
      ev('ownership.releasing', { agentId: `peer-${A}` }, A),
      ev('archive.succeeded', { intentId: 'arch', agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z', liveStatus: 'closed' }, A),
      ev('ownership.released', { agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z' }, A),
    ]).state);
    expect(done).toEqual({ quiescent: true, blockers: [] });

    const pendingNotice = quiescence(project(PROJECT, [ev('notice.pending', { noticeId: 'n1', kind: 'k', class: 'owner', disposition: 'lead-now', text: 'x' })]).state);
    expect(pendingNotice.blockers).toEqual([expect.objectContaining({ kind: 'delivery', id: 'n1' })]);
  });
});
