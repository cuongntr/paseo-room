import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { Controller, type LoadedProject } from '../src/runtime-plugin/server/controller.js';
import { createPeerHandlers } from '../src/runtime-plugin/server/handlers/peer.js';
import { PaseoHandle } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { createRpcHandlers } from '../src/runtime-plugin/server/rpc.js';
import type { HandlerReply } from '../src/runtime-plugin/server/spool.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function room(): Promise<Harness> {
  const h = await harness({ worktrees: true });
  open.push(h);
  return h;
}

const gate = { command: 'true', timeoutSeconds: 30, runtimeRerun: 'optional', processContractVersion: 1 };
const complete = { completion: 'complete', summary: 'Done.', deliverables: [], verification: [{ command: 'true', outcome: 'passed' }], residualRisks: [], evidence: [], details: { kind: 'engineer' } };
let counter = 0;

interface Seat { readonly id: string; readonly peer: string; readonly correlation: string; readonly worktree: string; readonly workspaceId: string }

async function ledger(h: Harness): Promise<LoadedProject> {
  const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.value;
}

async function seat(h: Harness, scope: string[] = ['src']): Promise<Seat> {
  const created = await h.controller.createAssignment(h.lead, writableBrief(h.base, { writeScope: scope, gate }));
  if (!created.ok) throw new Error(created.message);
  const id = created.value.assignmentId;
  const dispatched = await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer', isolation: 'worktree' });
  if (!dispatched.ok) throw new Error(dispatched.message);
  const record = (await ledger(h)).state.workspaces.get(id);
  const association = await h.hooks.correlations.findByAssignment(id, dispatched.value.agentId);
  return { id, peer: dispatched.value.agentId, correlation: association?.correlationId ?? '', worktree: record?.worktreePath ?? '', workspaceId: record?.workspaceId ?? '' };
}

async function report(h: Harness, correlation: string, payload: unknown = complete): Promise<HandlerReply> {
  const capability = (await latestCapability(join(h.runtimeRoot, 'capabilities'), correlation))?.capability;
  return await createPeerHandlers(h.controller).handoff({
    protocol: 1, requestId: `req_${String(++counter).padStart(8, '0')}`, operation: 'handoff', payload: JSON.parse(JSON.stringify(payload)) as unknown,
    correlation, ...(capability === undefined ? {} : { capability }),
  }, { kind: 'peer', role: 'peer' });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

async function commit(worktree: string, path = 'src/a.ts'): Promise<string> {
  await mkdir(join(worktree, path, '..'), { recursive: true });
  await writeFile(join(worktree, path), `${path}\n`);
  git(worktree, 'add', '.');
  git(worktree, 'commit', '-q', '-m', `write ${path}`);
  return git(worktree, 'rev-parse', 'HEAD');
}

/** Hand back a committed candidate, decide, and close the assignment. */
async function finish(h: Harness, s: Seat, decision: 'accept' | 'abandon' = 'accept', beforeClose?: () => Promise<void>): Promise<void> {
  await commit(s.worktree);
  expect(await report(h, s.correlation)).toMatchObject({ ok: true });
  await beforeClose?.();
  const decided = decision === 'accept'
    ? await h.controller.accept(h.lead, { assignmentId: s.id, reason: 'Good.' })
    : await h.controller.abandon(h.lead, { assignmentId: s.id, reason: 'Superseded.' });
  expect(decided.ok).toBe(true);
  expect(await h.controller.close(h.lead, { assignmentId: s.id })).toMatchObject({ ok: true, value: { released: true } });
}

/** Paseo's own view that a Peer died: archived and closed, with nobody asking the runtime. */
function kill(h: Harness, agentId: string): void {
  const agent = h.paseo.agents.get(agentId);
  if (agent === undefined) throw new Error(`no agent ${agentId}`);
  agent.archivedAt = '2026-09-22T10:30:00.000Z';
  agent.status = 'closed';
  agent.activeTurn = false;
}

const restarted = (h: Harness): Recovery => new Recovery(new Controller({ ...h.controller.deps }));

describe('closing worktrees', () => {
  it('closes a clean worktree after its writer is released and keeps the branch', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s);
    const loaded = await ledger(h);
    expect(loaded.state.workspaces.get(s.id)).toMatchObject({ close: 'succeeded', directoryRemoved: true, discardUncommitted: false });
    expect(loaded.events.filter(event => event.assignmentId === s.id).map(event => event.type).slice(-3)).toEqual(['ownership.released', 'workspace.close-requested', 'workspace.close-succeeded']);
    expect(await h.git('worktree', 'list')).not.toContain(s.worktree);
    expect(await h.git('log', '-1', '--format=%s', `paseo-room/${s.id}`)).toBe('write src/a.ts');
  });

  it('retains a dirty worktree with a notice, and closes it only on an explicit discard with a reason', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s, 'abandon', async () => { await writeFile(join(s.worktree, 'scratch.txt'), 'unsaved'); });
    const retained = await ledger(h);
    expect(retained.state.workspaces.get(s.id)?.close).toBe('open');
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('was retained: it has uncommitted changes');
    expect(await h.controller.workspaceClose(h.lead, { assignmentId: s.id })).toMatchObject({ ok: false, code: 'workspace_retained' });
    expect(await h.controller.workspaceClose(h.lead, { assignmentId: s.id, discardUncommitted: true })).toMatchObject({ ok: false, code: 'reason_missing' });
    expect(git(s.worktree, 'status', '--porcelain')).toBe('?? scratch.txt');
    expect(await h.controller.workspaceClose(h.lead, { assignmentId: s.id, discardUncommitted: true, reason: 'The scratch file is not needed.' }))
      .toMatchObject({ ok: true, value: { directoryRemoved: true } });
    const closed = await ledger(h);
    expect(closed.state.workspaces.get(s.id)).toMatchObject({ close: 'succeeded', discardUncommitted: true });
    const request = closed.events.find(event => event.type === 'workspace.close-requested');
    expect(request?.actor).toMatchObject({ source: 'seat', role: 'lead' });
  });

  it('retains a worktree whose commits no handoff recorded', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s, 'abandon', async () => { await commit(s.worktree, 'src/late.ts'); });
    expect((await ledger(h)).state.workspaces.get(s.id)?.close).toBe('open');
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('commits no handoff recorded');
  });

  it('records a teardown failure as a closed worktree whose directory remains', async () => {
    const h = await room();
    h.paseo.teardownFails = true;
    const s = await seat(h);
    await finish(h, s);
    expect((await ledger(h)).state.workspaces.get(s.id)).toMatchObject({ close: 'succeeded', directoryRemoved: false });
  });

  it('refuses to close a worktree whose writer is not released', async () => {
    const h = await room();
    const s = await seat(h);
    expect(await h.controller.workspaceClose(h.lead, { assignmentId: s.id, discardUncommitted: true, reason: 'x' })).toMatchObject({ ok: false, code: 'writer_not_released' });
    expect(h.paseo.calls.some(call => call.operation === 'archiveWorkspace')).toBe(false);
  });
});

describe('lease reclaim', () => {
  it('refuses while the Peer may still write, then moves to the next epoch in the same worktree', async () => {
    const h = await room();
    const s = await seat(h);
    const other = await seat(h, ['docs']);
    expect(await h.controller.leaseReclaim(h.lead, { assignmentId: s.id, reason: 'It went quiet.' })).toMatchObject({ ok: false, code: 'writer_not_proven_stopped' });

    kill(h, s.peer);
    const reclaimed = await h.controller.leaseReclaim(h.lead, { assignmentId: s.id, reason: 'The Peer was archived mid-turn.' });
    expect(reclaimed).toMatchObject({ ok: true, value: { epoch: 2, generation: 2 } });
    const agentId = reclaimed.ok ? reclaimed.value.agentId : '';
    const loaded = await ledger(h);
    expect(loaded.state.ownership.get(s.id)).toMatchObject({ state: 'held', agentId, lease: { epoch: 2, priorAgentIds: [s.peer], worktreePath: s.worktree } });
    const successor = h.paseo.agents.get(agentId);
    expect(successor).toMatchObject({ workspaceId: s.workspaceId, cwd: s.worktree, labels: { 'paseo.parent-agent-id': 'lead-1' } });
    expect(successor?.workspaceId).not.toBe(other.workspaceId);
    expect(successor?.prompts[0]?.text).toContain('after the previous Peer stopped (The Peer was archived mid-turn.)');
    expect(successor?.prompts[0]?.messageId).toBe(`${s.id}-g2`);
    expect(loaded.events.find(event => event.type === 'lease.reclaimed')?.data).toEqual({
      fromEpoch: 1, toEpoch: 2, priorAgentId: s.peer, decidedBy: 'lead', reason: 'The Peer was archived mid-turn.',
    });

    // The old Peer's late call belongs to an earlier epoch.
    const stale = await report(h, s.correlation);
    expect((stale.result as { error?: { code: string } }).error?.code).toBe('report_stale');
    // The new Peer reports normally.
    const correlation = (await h.hooks.correlations.findByAssignment(s.id, agentId))?.correlationId ?? '';
    await commit(s.worktree);
    expect(await report(h, correlation)).toMatchObject({ ok: true, result: { assignmentState: 'handed-back' } });
  });

  it('lets a Human reclaim from a Peer Paseo no longer knows, but never Lead, and never a live one', async () => {
    const h = await room();
    const s = await seat(h);
    h.paseo.agents.delete(s.peer);
    expect(await h.controller.leaseReclaim(h.lead, { assignmentId: s.id, reason: 'gone' })).toMatchObject({ ok: false, code: 'writer_not_proven_stopped' });
    const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle() });
    const loaded = await ledger(h);
    const projectId = loaded.store.meta.projectId;
    const first = await rpc.leaseReclaim({ projectId, assignmentId: s.id, reason: 'Paseo lost the Peer.', idempotencyKey: 'reclaim-0001' });
    expect(first).toMatchObject({ data: { epoch: 2 } });
    expect(await rpc.leaseReclaim({ projectId, assignmentId: s.id, reason: 'Paseo lost the Peer.', idempotencyKey: 'reclaim-0001' })).toEqual(first);
    expect((await ledger(h)).events.find(event => event.type === 'lease.reclaimed')?.actor).toEqual({ source: 'human' });

    const live = await seat(h, ['docs']);
    expect(await rpc.leaseReclaim({ projectId, assignmentId: live.id, reason: 'x', idempotencyKey: 'reclaim-0002' })).toMatchObject({ error: { code: 'writer_not_proven_stopped' } });
  });

  it('refuses to reclaim a decided or unleased assignment', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s);
    expect(await h.controller.leaseReclaim(h.lead, { assignmentId: s.id, reason: 'x' })).toMatchObject({ ok: false, code: 'lease_state' });
    const shared = await h.controller.createAssignment(h.lead, writableBrief(h.base, { gate }));
    const sharedId = shared.ok ? shared.value.assignmentId : '';
    expect(await h.controller.leaseReclaim(h.lead, { assignmentId: sharedId, reason: 'x' })).toMatchObject({ ok: false, code: 'lease_missing' });
  });
});

describe('Human worktree close', () => {
  it('closes a retained worktree through the RPC with the same refusals as Lead, idempotently', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s, 'abandon', async () => { await writeFile(join(s.worktree, 'scratch.txt'), 'unsaved'); });
    const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle() });
    const projectId = (await ledger(h)).store.meta.projectId;
    expect(await rpc.workspaceClose({ projectId, assignmentId: s.id, idempotencyKey: 'close-0001' })).toMatchObject({ error: { code: 'workspace_retained' } });
    const closed = await rpc.workspaceClose({ projectId, assignmentId: s.id, discardUncommitted: true, reason: 'Reviewed; not needed.', idempotencyKey: 'close-0002' });
    expect(closed).toMatchObject({ data: { directoryRemoved: true } });
    expect(await rpc.workspaceClose({ projectId, assignmentId: s.id, discardUncommitted: true, reason: 'Reviewed; not needed.', idempotencyKey: 'close-0002' })).toEqual(closed);
    expect((await ledger(h)).events.filter(event => event.type === 'workspace.close-requested').at(-1)?.actor).toEqual({ source: 'human' });
  });
});

describe('recovery of Phase 2 intents', () => {
  async function reserved(h: Harness): Promise<{ id: string; loaded: LoadedProject; workspaceId: string }> {
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base, { writeScope: ['src'], gate }));
    const id = created.ok ? created.value.assignmentId : '';
    const loaded = await ledger(h);
    const plugin = { source: 'plugin' as const };
    const workspaceId = 'wks_00000000000000c1';
    await h.controller.append(loaded, { type: 'assignment.dispatch-requested', payloadVersion: 1, assignmentId: id, actor: plugin, data: { peerProviderId: 'codex-peer', workspaceId } });
    await h.controller.append(loaded, { type: 'ownership.reserved', payloadVersion: 1, assignmentId: id, actor: plugin, data: { workspaceId, baseCommit: h.base } });
    await h.controller.append(loaded, { type: 'lease.reserved', payloadVersion: 1, assignmentId: id, actor: plugin, data: { workspaceId, branch: `paseo-room/${id}`, baseCommit: h.base, scopes: ['src'], serialOnly: [], epoch: 1 } });
    await h.controller.append(loaded, {
      type: 'workspace.create-requested', payloadVersion: 1, assignmentId: id, actor: plugin,
      data: { intentId: 'wsc-crash', workspaceId, idempotencyKey: `ws-${id}-e1`, baseCommit: h.base, branchName: `paseo-room/${id}`, worktreeSlug: id.toLowerCase() },
    });
    return { id, loaded, workspaceId };
  }

  it('reissues a worktree request that crashed before the call, then closes it rather than adopting it', async () => {
    const h = await room();
    const { id, workspaceId } = await reserved(h);
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([expect.objectContaining({ intent: 'wsc-crash', outcome: 'archived-unbound' })]);
    const after = await ledger(h);
    expect(after.state.workspaces.get(id)).toMatchObject({ create: 'refused', close: 'succeeded', directoryRemoved: true });
    expect(after.state.ownership.get(id)?.state).toBe('released');
    expect(after.state.assignments.get(id)).toMatchObject({ state: 'blocked', openIntents: {} });
    expect(h.paseo.workspaces.size).toBe(1);
    expect(h.paseo.workspaces.get(workspaceId)?.archivedAt).not.toBeNull();
    expect((await h.git('worktree', 'list')).split('\n')).toHaveLength(1);
  });

  it('replays the receipt of a worktree whose response was lost, so no second worktree appears', async () => {
    const h = await room();
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base, { writeScope: ['src'], gate }));
    const id = created.ok ? created.value.assignmentId : '';
    h.paseo.faults.set('createWorktreeWorkspace', { when: 'after' });
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer', isolation: 'worktree' })).toMatchObject({ code: 'workspace_uncertain' });
    await restarted(h).recoverAll();
    expect(h.paseo.calls.filter(call => call.operation === 'createWorktreeWorkspace')).toHaveLength(2);
    expect(h.paseo.workspaces.size).toBe(1);
    expect((await ledger(h)).state.workspaces.get(id)).toMatchObject({ create: 'refused', close: 'succeeded' });
  });

  it('archives a leased Peer whose create response was lost, releases the lease and closes its worktree', async () => {
    const h = await room();
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base, { writeScope: ['src'], gate }));
    const id = created.ok ? created.value.assignmentId : '';
    h.paseo.faults.set('createAgentInWorkspace', { when: 'after' });
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer', isolation: 'worktree' })).toMatchObject({ code: 'create_uncertain' });
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([expect.objectContaining({ outcome: 'archived-unbound' })]);
    const after = await ledger(h);
    expect(after.state.ownership.get(id)?.state).toBe('released');
    expect(after.state.workspaces.get(id)).toMatchObject({ create: 'succeeded', close: 'succeeded', directoryRemoved: true });
    expect([...h.paseo.agents.values()].filter(agent => agent.id !== 'lead-1')).toHaveLength(1);
  });

  it('settles a close from the live workspace: still active fails, gone succeeds with directory evidence', async () => {
    const h = await room();
    const s = await seat(h);
    await finish(h, s, 'abandon', async () => { await writeFile(join(s.worktree, 'scratch.txt'), 'unsaved'); });
    const loaded = await ledger(h);
    const plugin = { source: 'plugin' as const };
    await h.controller.append(loaded, { type: 'workspace.close-requested', payloadVersion: 1, assignmentId: s.id, actor: plugin, data: { intentId: 'close-crash', workspaceId: s.workspaceId, discardUncommitted: true, reason: 'discard' } });
    const [stillOpen] = await restarted(h).recoverAll();
    expect(stillOpen?.actions).toEqual([expect.objectContaining({ intent: 'close-crash', outcome: 'failed' })]);
    expect((await ledger(h)).state.workspaces.get(s.id)?.close).toBe('failed');

    const again = await ledger(h);
    await h.controller.append(again, { type: 'workspace.close-requested', payloadVersion: 1, assignmentId: s.id, actor: plugin, data: { intentId: 'close-crash-2', workspaceId: s.workspaceId, discardUncommitted: true, reason: 'discard' } });
    await h.paseo.archiveWorkspace(s.workspaceId);
    const [gone] = await restarted(h).recoverAll();
    expect(gone?.actions).toEqual([expect.objectContaining({ intent: 'close-crash-2', outcome: 'succeeded' })]);
    expect((await ledger(h)).state.workspaces.get(s.id)).toMatchObject({ close: 'succeeded', directoryRemoved: true });
  });

  it('reconstructs three held leases unchanged after a restart and never reclaims on its own', async () => {
    const h = await room();
    for (const scope of [['src/api'], ['src/web'], ['docs']]) await seat(h, scope);
    const before = await ledger(h);
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([]);
    const after = await ledger(h);
    expect([...after.state.ownership.values()]).toEqual([...before.state.ownership.values()]);
    expect([...after.state.workspaces.values()]).toEqual([...before.state.workspaces.values()]);
    expect(after.events).toHaveLength(before.events.length);
  });
});
