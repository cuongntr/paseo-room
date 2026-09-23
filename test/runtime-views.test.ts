import { describe, expect, it } from 'vitest';
import type { RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';
import { project } from '../src/runtime-plugin/server/domain/state.js';
import {
  assignmentDetailView, findings, projectStatusView, quiescence, revision, SCOPE_STATEMENT, worktreesOnDisk, type StatusInput,
} from '../src/runtime-plugin/server/domain/views.js';
import { A, B, BASE, candidate, created, DIGEST, dispatched, ev, HEAD, leased, PROJECT, receipt, wks } from './runtime-fixtures.js';

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

describe('Phase 2 status views', () => {
  const handoff = (id: string): RuntimeEventV1 => ev('report.accepted', {
    generation: 1, tool: 'handoff', requestId: `req_${id}`, fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'), report: {},
    candidate: { ...candidate, workspaceId: wks(id) },
  }, id);
  const release = (id: string): RuntimeEventV1[] => [
    ev('assignment.abandoned', { reason: 'stop' }, id),
    ev('assignment.close-requested', {}, id),
    ev('archive.requested', { intentId: `arch-${id}`, agentId: `peer-${id}` }, id),
    ev('ownership.releasing', { agentId: `peer-${id}` }, id),
    ev('archive.succeeded', { intentId: `arch-${id}`, agentId: `peer-${id}`, archivedAt: '2026-09-22T11:00:00Z', liveStatus: 'closed' }, id),
    ev('ownership.released', { agentId: `peer-${id}`, archivedAt: '2026-09-22T11:00:00Z' }, id),
  ];

  it('shows each lease with its scopes, epoch and evidence, and states that scopes are not containment', () => {
    const view = projectStatusView(input([...leased(A, ['src/api'], { serialOnly: ['generated'] }), ...leased(B, ['docs'])]));
    expect(view.leases).toEqual([
      expect.objectContaining({ assignmentId: A, state: { value: 'held', evidence: 'enforced' }, epoch: 1, scopes: ['src/api'], serialOnly: ['generated'], workspaceId: wks(A), worktreePath: `/wt/${A}` }),
      expect.objectContaining({ assignmentId: B, scopes: ['docs'] }),
    ]);
    expect(view.worktrees.map(worktree => [worktree.assignmentId, worktree.retained, worktree.create])).toEqual([
      [A, false, { value: 'succeeded', evidence: 'detected' }], [B, false, { value: 'succeeded', evidence: 'detected' }],
    ]);
    expect(view.scopeStatement).toBe(SCOPE_STATEMENT);
    expect(SCOPE_STATEMENT).toContain('do not contain a Peer');
    expect(view.health.value).toBe('healthy');
  });

  it('finds a retained worktree, a leftover directory and an exceeded scope, each with a recovery action', () => {
    const retained = input([...leased(A, ['src/api']), handoff(A), ...release(A)]);
    expect(findings(retained)).toEqual([expect.objectContaining({ kind: 'worktree-retained', evidence: 'detected', assignmentId: A })]);
    expect(projectStatusView(retained).worktrees[0]).toMatchObject({ retained: true, close: { value: 'open' } });
    expect(worktreesOnDisk(retained.state)).toEqual({ retained: 1, leftover: 0 });
    expect(quiescence(retained.state).quiescent).toBe(true);

    const leftover = input([...leased(A, ['src/api']), handoff(A), ...release(A),
      ev('workspace.close-requested', { intentId: 'c1', workspaceId: wks(A), discardUncommitted: false }, A),
      ev('workspace.close-succeeded', { intentId: 'c1', workspaceId: wks(A), archivedAt: '2026-09-22T12:00:00Z', directoryRemoved: false }, A)]);
    expect(findings(leftover).map(finding => finding.kind)).toEqual(['worktree-cleanup']);
    expect(worktreesOnDisk(leftover.state)).toEqual({ retained: 0, leftover: 1 });

    const exceeded = input([...leased(A, ['src/api']), handoff(A), ev('scope.exceeded', { candidateCommit: HEAD, paths: ['README.md'] }, A)]);
    expect(findings(exceeded)).toEqual([expect.objectContaining({ kind: 'scope-exceeded', message: expect.stringContaining('README.md') as string })]);
    expect(assignmentDetailView(exceeded.state, A, 'lead')).toMatchObject({
      lease: { epoch: 1 }, worktree: { path: `/wt/${A}` }, scopeExceeded: { value: { candidateCommit: HEAD, paths: ['README.md'] }, evidence: 'detected' },
    });
  });

  it('blocks deselection on a held lease or an unresolved worktree close', () => {
    expect(quiescence(input(leased(A, ['src/api'])).state).blockers).toContainEqual({ kind: 'lease', id: A, detail: 'worktree lease (epoch 1) is held' });
    const closing = input([...leased(A, ['src/api']), handoff(A), ...release(A),
      ev('workspace.close-requested', { intentId: 'c1', workspaceId: wks(A), discardUncommitted: false }, A)]);
    expect(quiescence(closing.state).blockers).toContainEqual(expect.objectContaining({ kind: 'worktree', id: wks(A) }));
  });
});

describe('Phase 2 status views after review', () => {
  const handoffAt = (id: string, commit: string, generation = 1): RuntimeEventV1 => ev('report.accepted', {
    generation, tool: 'handoff', requestId: `req_${id}_${String(generation)}`, fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'), report: {},
    candidate: { ...candidate, commit, workspaceId: wks(id) },
  }, id);
  const refusedOpen = (id: string): RuntimeEventV1[] => [
    created(id),
    ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: wks(id) }, id),
    ev('ownership.reserved', { workspaceId: wks(id), baseCommit: BASE }, id),
    ev('lease.reserved', { workspaceId: wks(id), branch: `paseo-room/${id}`, baseCommit: BASE, scopes: ['src'], serialOnly: [], epoch: 1 }, id),
    ev('workspace.create-requested', { intentId: 'w', workspaceId: wks(id), idempotencyKey: 'k', baseCommit: BASE, branchName: 'b', worktreeSlug: 's' }, id),
    ev('workspace.create-refused', { intentId: 'w', workspaceId: wks(id), reason: 'head-mismatch' }, id),
    ev('workspace.close-requested', { intentId: 'c', workspaceId: wks(id), discardUncommitted: false }, id),
    ev('workspace.close-failed', { intentId: 'c', workspaceId: wks(id), reason: 'busy' }, id),
  ];

  it('treats a refused worktree whose close failed as retained, everywhere', () => {
    const state = input(refusedOpen(A));
    expect(findings(state)).toEqual([expect.objectContaining({ kind: 'worktree-retained', message: expect.stringContaining('refused and not closed') as string })]);
    expect(worktreesOnDisk(state.state)).toEqual({ retained: 1, leftover: 0 });
    expect(projectStatusView(state).worktrees).toEqual([expect.objectContaining({ disposition: 'retained', retained: true })]);
  });

  it('clears a leftover directory once it is gone from disk', () => {
    const events = [...leased(A, ['src/api']), handoffAt(A, HEAD),
      ev('assignment.abandoned', { reason: 'stop' }, A), ev('assignment.close-requested', {}, A),
      ev('archive.requested', { intentId: 'a', agentId: `peer-${A}` }, A), ev('ownership.releasing', { agentId: `peer-${A}` }, A),
      ev('archive.succeeded', { intentId: 'a', agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z', liveStatus: 'closed' }, A),
      ev('ownership.released', { agentId: `peer-${A}`, archivedAt: '2026-09-22T11:00:00Z' }, A),
      ev('workspace.close-requested', { intentId: 'c', workspaceId: wks(A), discardUncommitted: false }, A),
      ev('workspace.close-succeeded', { intentId: 'c', workspaceId: wks(A), archivedAt: '2026-09-22T12:00:00Z', directoryRemoved: false }, A)];
    expect(findings(input(events)).map(finding => finding.kind)).toEqual(['worktree-cleanup']);
    const cleaned = input(events, { present: () => false });
    expect(findings(cleaned)).toEqual([]);
    expect(projectStatusView(cleaned).worktrees).toEqual([]);
    expect(worktreesOnDisk(cleaned.state, () => false)).toEqual({ retained: 0, leftover: 0 });
  });

  it('reports one finding for one unconfirmed worktree create', () => {
    const events = [...refusedOpen(A).slice(0, 5), ev('workspace.create-uncertain', { intentId: 'w', reason: 'lost' }, A)];
    expect(findings(input(events)).filter(finding => finding.kind === 'uncertain-effect')).toHaveLength(1);
  });

  it('names only the writer in Lead\'s workspace as the writer, and lists isolated ones as leases', () => {
    const view = projectStatusView(input([...leased(A, ['src/api']), ...leased(B, ['docs'])]));
    expect(view.writer).toBeUndefined();
    expect(view.leases.map(lease => lease.assignmentId)).toEqual([A, B]);
    expect(projectStatusView(input(dispatched(A))).writer?.assignmentId).toBe(A);
  });

  it('offers reclaim only where the projection allows it', () => {
    expect(projectStatusView(input(leased(A, ['src/api']))).leases[0]?.reclaimable).toBe(true);
    // An open run intent must settle first.
    expect(projectStatusView(input(leased(A, ['src/api']).slice(0, -1))).leases[0]?.reclaimable).toBe(false);
  });

  it('shows scope evidence only for the current candidate', () => {
    const exceeded = [...leased(A, ['src/api']), handoffAt(A, HEAD), ev('scope.exceeded', { candidateCommit: HEAD, paths: ['README.md'] }, A)];
    expect(assignmentDetailView(input(exceeded).state, A, 'lead')?.scopeExceeded).toBeDefined();
    const replaced = [...exceeded, ev('assignment.rework-requested', { instructions: 'narrow it' }, A),
      ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'rework' }, A),
      ev('run.requested', { intentId: 'r2', generation: 2, promptDigest: DIGEST }, A), ev('run.succeeded', { intentId: 'r2', generation: 2 }, A),
      handoffAt(A, 'd'.repeat(40), 2)];
    expect(assignmentDetailView(input(replaced).state, A, 'lead')?.scopeExceeded).toBeUndefined();
  });
});
