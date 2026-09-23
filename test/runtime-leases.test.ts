import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { activeLeases, activeWriter, checkEvent, leaseCollision, project, type ProjectState } from '../src/runtime-plugin/server/domain/state.js';
import { EVENT_PAYLOADS, readEvent, type RuntimeEventV1 } from '../src/runtime-plugin/server/events/schema.js';
import { A, B, BASE, candidate, created, DIGEST, dispatched, ev, HEAD, leased, PROJECT, R, receipt, wks } from './runtime-fixtures.js';

const C = 'asg_writable03';
const D = 'asg_writable04';

function fold(events: readonly RuntimeEventV1[]): ProjectState {
  const result = project(PROJECT, events);
  expect(result.violations).toEqual([]);
  return result.state;
}

/** Dispatch of `id` up to its reservation, so `lease.reserved` is the next event to check. */
function reservedOnly(id: string): RuntimeEventV1[] {
  return [
    created(id),
    ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: wks(id) }, id),
    ev('ownership.reserved', { workspaceId: wks(id), baseCommit: BASE }, id),
  ];
}

const leaseEvent = (id: string, scopes: string[], serialOnly: string[] = []): RuntimeEventV1 =>
  ev('lease.reserved', { workspaceId: wks(id), branch: `paseo-room/${id}`, baseCommit: BASE, scopes, serialOnly, epoch: 1 }, id);

const handedBack = (id: string, commit = HEAD): RuntimeEventV1 => ev('report.accepted', {
  generation: 1, tool: 'handoff', requestId: `req_${id}`, fingerprint: DIGEST, receipt: receipt('handoff', 'handed-back'), report: {},
  candidate: { ...candidate, commit, workspaceId: wks(id) },
}, id);

/** Close, proven archive and release of a leased Peer. */
function released(id: string, decision: RuntimeEventV1 = ev('assignment.abandoned', { reason: 'stop' }, id)): RuntimeEventV1[] {
  return [
    decision,
    ev('assignment.close-requested', {}, id),
    ev('archive.requested', { intentId: `arch-${id}`, agentId: `peer-${id}` }, id),
    ev('ownership.releasing', { agentId: `peer-${id}` }, id),
    ev('archive.succeeded', { intentId: `arch-${id}`, agentId: `peer-${id}`, archivedAt: '2026-09-22T11:00:00Z', liveStatus: 'closed' }, id),
    ev('ownership.released', { agentId: `peer-${id}`, archivedAt: '2026-09-22T11:00:00Z' }, id),
  ];
}

describe('Phase 2 events', () => {
  it('reads a Peer create with its chosen identity, and a Phase 1 reader ignores the additions', () => {
    const create = leased(A, ['src/api']).find(event => event.type === 'agent.create-requested');
    const read = readEvent(create);
    expect(read.ok && read.event.type === 'agent.create-requested' && read.event.data.idempotencyKey).toBe(`${A}-g1-create`);
    const phase1 = { intentId: z.string(), peerProviderId: z.string(), workspaceId: z.string(), parentAgentId: z.string(), label: z.string() };
    expect(z.object(phase1).parse(create?.data)).toEqual({ intentId: `create-${A}`, peerProviderId: 'codex-peer', workspaceId: wks(A), parentAgentId: 'lead-1', label: A });
    expect(Object.keys(EVENT_PAYLOADS['agent.create-requested'])).toEqual([...Object.keys(phase1), 'agentId', 'idempotencyKey']);
  });

  it('refuses a non-runtime workspace id, a wrong epoch and a missing reason field', () => {
    expect(() => ev('lease.reserved', { workspaceId: 'ws-1', branch: 'b', baseCommit: BASE, scopes: [], serialOnly: [], epoch: 1 }, A)).toThrow();
    expect(() => ev('lease.reserved', { workspaceId: wks(A), branch: 'b', baseCommit: BASE, scopes: [], serialOnly: [], epoch: 2 }, A)).toThrow();
    expect(() => ev('lease.reclaimed', { fromEpoch: 1, toEpoch: 2, priorAgentId: 'p', decidedBy: 'lead' }, A)).toThrow();
    expect(() => ev('workspace.close-succeeded', { intentId: 'c', workspaceId: wks(A), archivedAt: 'now', directoryRemoved: true }, A)).toThrow();
  });
});

describe('writer leases', () => {
  it('walks a worktree lease from reservation to a held writer in its own workspace', () => {
    const state = fold(leased(A, ['src/api']));
    const owner = state.ownership.get(A);
    expect(owner).toMatchObject({ state: 'held', agentId: `peer-${A}`, workspaceId: wks(A) });
    expect(owner?.lease).toEqual({
      workspaceId: wks(A), branch: `paseo-room/${A}`, baseCommit: BASE, scopes: ['src/api'], serialOnly: [], epoch: 1, worktreePath: `/wt/${A}`, priorAgentIds: [],
    });
    expect(state.workspaces.get(A)).toMatchObject({ create: 'succeeded', close: 'open', worktreePath: `/wt/${A}`, headCommit: BASE });
    expect(state.assignments.get(A)).toMatchObject({ state: 'active', workspaceId: wks(A), openIntents: {} });
  });

  it('holds three disjoint leases at once and refuses a fourth at the cap', () => {
    const state = fold([...leased(A, ['src/api']), ...leased(B, ['src/web']), ...leased(C, ['docs']), ...reservedOnly(D)]);
    expect(activeLeases(state).map(owner => owner.assignmentId)).toEqual([A, B, C]);
    expect(checkEvent(state, leaseEvent(D, ['test']))).toMatch(/^lease_cap/);
  });

  it('refuses overlapping, serial-path and uncertain collisions on replay', () => {
    const base = fold([...leased(A, ['src/api'], { serialOnly: ['package-lock.json'] }), ...reservedOnly(B)]);
    expect(checkEvent(base, leaseEvent(B, ['src']))).toMatch(/^scope_overlap: src overlaps src\/api held by/);
    expect(checkEvent(base, leaseEvent(B, ['SRC/API/v2']))).toMatch(/^scope_overlap/);
    expect(checkEvent(base, leaseEvent(B, []))).toMatch(/^scope_overlap: \*\* overlaps/);
    expect(checkEvent(base, leaseEvent(B, ['src/web']))).toBeUndefined();
    // A serial-only path admits one writer at a time, whoever declared it.
    const serial = fold([...leased(A, ['src/api', 'package-lock.json'], { serialOnly: [] }), ...reservedOnly(B)]);
    expect(checkEvent(serial, leaseEvent(B, ['src/web', 'package-lock.json'], ['package-lock.json']))).toMatch(/^scope_overlap/);
    const reach = fold([...leased(A, ['generated/a'], { serialOnly: ['generated'] }), ...reservedOnly(B)]);
    expect(checkEvent(reach, leaseEvent(B, ['generated/b']))).toMatch(/^serial_path: generated is serial-only/);
    const uncertain = fold([
      ...leased(A, ['src/api']), ev('ownership.uncertain', { reason: 'archive unconfirmed' }, A), ...reservedOnly(B),
    ]);
    expect(checkEvent(uncertain, leaseEvent(B, ['docs']))).toMatch(/^writer_uncertain/);
    expect(checkEvent(base, leaseEvent(B, ['/abs']))).toMatch(/^scope_not_canonical: writeScope item \/abs is absolute/);
  });

  it('keeps a writer in Lead\'s workspace exclusive in both directions', () => {
    const phase1 = fold([...dispatched(A), created(B)]);
    expect(checkEvent(phase1, ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: wks(B) }, B))).toMatch(/Another writer/);
    expect(leaseCollision(phase1, B, { scopes: ['docs'], serialOnly: [] })?.code).toBe('writer_exclusive');
    // A Lead-workspace writer's create is refused while any lease is active.
    const withLease = fold([
      ...leased(A, ['src/api']), created(B),
      ev('assignment.dispatch-requested', { peerProviderId: 'codex-peer', workspaceId: 'ws1' }, B),
      ev('ownership.reserved', { workspaceId: 'ws1', baseCommit: BASE }, B),
    ]);
    expect(checkEvent(withLease, ev('agent.create-requested', { intentId: 'c-b', peerProviderId: 'codex-peer', workspaceId: 'ws1', parentAgentId: 'lead-1', label: B }, B))).toMatch(/Another writer/);
    // Read-only work is never a writer.
    expect(fold([...leased(A, ['src/api']), ...dispatched(R, 'read-only')]).assignments.get(R)?.state).toBe('active');
  });

  it('creates a leased Peer only in its proven worktree', () => {
    const requested = fold([
      ...reservedOnly(A), leaseEvent(A, ['src']),
      ev('workspace.create-requested', { intentId: 'wsc', workspaceId: wks(A), idempotencyKey: 'k', baseCommit: BASE, branchName: 'b', worktreeSlug: 's' }, A),
    ]);
    const create = ev('agent.create-requested', { intentId: 'c', peerProviderId: 'codex-peer', workspaceId: wks(A), parentAgentId: 'lead-1', label: A }, A);
    expect(checkEvent(requested, create)).toMatch(/proven worktree/);
    expect(requested.assignments.get(A)?.openIntents).toEqual({ wsc: 'workspace.create-requested' });
    const proven = fold([...reservedOnly(A), leaseEvent(A, ['src']),
      ev('workspace.create-requested', { intentId: 'wsc', workspaceId: wks(A), idempotencyKey: 'k', baseCommit: BASE, branchName: 'b', worktreeSlug: 's' }, A),
      ev('workspace.create-succeeded', { intentId: 'wsc', workspaceId: wks(A), worktreePath: '/wt', branch: 'b-2', headCommit: BASE }, A)]);
    expect(checkEvent(proven, ev('agent.create-requested', { intentId: 'c', peerProviderId: 'codex-peer', workspaceId: 'ws1', parentAgentId: 'lead-1', label: A }, A))).toMatch(/proven worktree/);
    expect(checkEvent(proven, create)).toBeUndefined();
    expect(proven.ownership.get(A)?.lease?.branch).toBe('b-2');
  });

  it('releases a lease whose worktree failed or was refused, and blocks the assignment', () => {
    for (const result of ['workspace.create-failed', 'workspace.create-refused'] as const) {
      const state = fold([
        ...reservedOnly(A), leaseEvent(A, ['src']),
        ev('workspace.create-requested', { intentId: 'wsc', workspaceId: wks(A), idempotencyKey: 'k', baseCommit: BASE, branchName: 'b', worktreeSlug: 's' }, A),
        ev(result, { intentId: 'wsc', reason: 'no', ...(result === 'workspace.create-refused' ? { workspaceId: wks(A) } : {}) }, A),
      ]);
      expect(state.ownership.get(A)?.state).toBe('released');
      expect(state.assignments.get(A)).toMatchObject({ state: 'blocked', openIntents: {} });
      expect(activeWriter(state)).toBeUndefined();
    }
    const uncertain = fold([
      ...reservedOnly(A), leaseEvent(A, ['src']),
      ev('workspace.create-requested', { intentId: 'wsc', workspaceId: wks(A), idempotencyKey: 'k', baseCommit: BASE, branchName: 'b', worktreeSlug: 's' }, A),
      ev('workspace.create-uncertain', { intentId: 'wsc', reason: 'lost' }, A),
    ]);
    expect(uncertain.ownership.get(A)?.state).toBe('uncertain');
    expect(uncertain.assignments.get(A)?.state).toBe('uncertain');
    expect(checkEvent(uncertain, ev('workspace.create-uncertain', { intentId: 'wsc', reason: 'again' }, A))).toBeDefined();
  });

  it('reclaims a lease to exactly the next epoch and forgets the prior Peer\'s binding', () => {
    const held = fold(leased(A, ['src/api']));
    const reclaim = ev('lease.reclaimed', { fromEpoch: 1, toEpoch: 2, priorAgentId: `peer-${A}`, decidedBy: 'lead', reason: 'Peer died' }, A);
    expect(checkEvent(held, ev('lease.reclaimed', { fromEpoch: 1, toEpoch: 3, priorAgentId: `peer-${A}`, decidedBy: 'lead', reason: 'x' }, A))).toMatch(/next epoch/);
    expect(checkEvent(held, ev('lease.reclaimed', { fromEpoch: 1, toEpoch: 2, priorAgentId: 'someone', decidedBy: 'lead', reason: 'x' }, A))).toMatch(/different writer/);
    // An open run intent must settle first.
    const running = fold(leased(A, ['src/api']).slice(0, -1));
    expect(checkEvent(running, reclaim)).toMatch(/Settle every unresolved effect/);

    const state = fold([...leased(A, ['src/api']), reclaim]);
    expect(state.ownership.get(A)).toMatchObject({ state: 'reserved', lease: { epoch: 2, priorAgentIds: [`peer-${A}`] } });
    expect(state.ownership.get(A)?.agentId).toBeUndefined();
    const view = state.assignments.get(A);
    expect(view).toMatchObject({ state: 'dispatching', reportingState: 'consumed', reportingGeneration: 1 });
    expect(view?.peerAgentId).toBeUndefined();
    // The next Peer goes into the same worktree, and the next generation follows the last.
    const next = fold([
      ...leased(A, ['src/api']), reclaim,
      ev('agent.create-requested', { intentId: 'c2', peerProviderId: 'codex-peer', workspaceId: wks(A), parentAgentId: 'lead-1', label: A }, A),
      ev('agent.create-succeeded', { intentId: 'c2', agentId: 'peer-2' }, A),
      ev('binding.published', { agentId: 'peer-2', providerId: 'codex-peer', model: 'gpt-5', parentAgentId: 'lead-1', workspaceId: wks(A), roomGeneration: 'g1' }, A),
      ev('ownership.held', { agentId: 'peer-2' }, A),
      ev('reporting.generation-opened', { generation: 2, capabilityHash: DIGEST, turn: 'initial' }, A),
    ]);
    expect(next.ownership.get(A)).toMatchObject({ state: 'held', agentId: 'peer-2', lease: { epoch: 2 } });
    expect(next.assignments.get(A)).toMatchObject({ reportingGeneration: 2, reportingState: 'open' });
  });

  it('records scope evidence only for the projected candidate of a lease', () => {
    const state = fold([...leased(A, ['src/api']), handedBack(A)]);
    expect(checkEvent(state, ev('scope.exceeded', { candidateCommit: BASE, paths: ['README.md'] }, A))).toMatch(/different candidate/);
    const exceeded = fold([...leased(A, ['src/api']), handedBack(A), ev('scope.exceeded', { candidateCommit: HEAD, paths: ['README.md'] }, A)]);
    expect(exceeded.assignments.get(A)?.scopeExceeded).toMatchObject({ candidateCommit: HEAD, paths: ['README.md'] });
    const phase1 = fold([...dispatched(B), handedBack(B)]);
    expect(checkEvent(phase1, ev('scope.exceeded', { candidateCommit: HEAD, paths: ['x'] }, B))).toMatch(/leased candidate/);
  });

  it('closes a worktree only after its writer is released, and records whether the directory went', () => {
    const held = fold(leased(A, ['src/api']));
    const close = ev('workspace.close-requested', { intentId: 'close-1', workspaceId: wks(A), discardUncommitted: false }, A);
    expect(checkEvent(held, close)).toMatch(/proven released/);
    const after = fold([...leased(A, ['src/api']), handedBack(A), ...released(A)]);
    expect(checkEvent(after, ev('workspace.close-requested', { intentId: 'close-1', workspaceId: wks(A), discardUncommitted: true }, A))).toMatch(/needs a reason/);
    const closed = fold([
      ...leased(A, ['src/api']), handedBack(A), ...released(A), close,
      ev('workspace.close-uncertain', { intentId: 'close-1', workspaceId: wks(A), reason: 'lost' }, A),
      ev('workspace.close-succeeded', { intentId: 'close-1', workspaceId: wks(A), archivedAt: '2026-09-22T12:00:00Z', directoryRemoved: false }, A),
    ]);
    expect(closed.workspaces.get(A)).toMatchObject({ close: 'succeeded', directoryRemoved: false, discardUncommitted: false });
    expect(closed.assignments.get(A)?.openIntents).toEqual({});
    expect(checkEvent(closed, ev('workspace.close-requested', { intentId: 'close-2', workspaceId: wks(A), discardUncommitted: false }, A))).toMatch(/already closing or closed/);
    // A failed close may be requested again.
    const failed = fold([...leased(A, ['src/api']), handedBack(A), ...released(A), close, ev('workspace.close-failed', { intentId: 'close-1', workspaceId: wks(A), reason: 'busy' }, A)]);
    expect(checkEvent(failed, ev('workspace.close-requested', { intentId: 'close-2', workspaceId: wks(A), discardUncommitted: true, reason: 'Lead discards' }, A))).toBeUndefined();
  });
});
