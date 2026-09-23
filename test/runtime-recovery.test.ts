import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../src/runtime-plugin/server/controller.js';
import { actionFingerprint } from '../src/runtime-plugin/server/domain/receipts.js';
import { project } from '../src/runtime-plugin/server/domain/state.js';
import { registerLifecycle } from '../src/runtime-plugin/server/lifecycle.js';
import { PaseoHandle, type PaseoApi } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function room(): Promise<Harness> {
  const h = await harness();
  open.push(h);
  return h;
}

async function create(h: Harness): Promise<string> {
  const result = await h.controller.createAssignment(h.lead, writableBrief(h.base, { gate: { command: 'true', timeoutSeconds: 30, runtimeRerun: 'optional', processContractVersion: 1 } }));
  if (!result.ok) throw new Error(result.message);
  return result.value.assignmentId;
}

/** A controller built fresh over the same state, as after a plugin restart. */
function restarted(h: Harness): Recovery {
  return new Recovery(new Controller({ ...h.controller.deps }));
}

async function state(h: Harness) {
  const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  return loaded.value;
}

describe('recovery of unresolved dispatch intents', () => {
  it('archives a child created before the crash instead of adopting it', async () => {
    const h = await room();
    const id = await create(h);
    h.paseo.faults.set('createAgent', { when: 'after' });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([expect.objectContaining({ assignmentId: id, outcome: 'archived-unbound' })]);
    const after = await state(h);
    expect(after.state.assignments.get(id)).toMatchObject({ closure: 'closed', openIntents: {} });
    expect(after.state.ownership.get(id)?.state).toBe('released');
    const child = [...h.paseo.agents.values()].find(agent => agent.id !== 'lead-1');
    expect(child?.prompts).toEqual([]);
    expect(child?.status).toBe('closed');
  });

  it('recovers a lost create response by the agent id recorded before the call, with no second agent', async () => {
    const h = await room();
    const id = await create(h);
    h.paseo.faults.set('createAgent', { when: 'after' });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    const requested = (await state(h)).events.find(event => event.type === 'agent.create-requested');
    const chosen = requested?.type === 'agent.create-requested' ? requested.data : undefined;
    expect(chosen).toMatchObject({ idempotencyKey: `${id}-g1-create`, agentId: expect.stringMatching(/^[0-9a-f-]{36}$/) as string });
    // A decoy with the same label must not matter once the exact id is known.
    h.paseo.addAgent({ id: 'decoy', provider: 'codex-peer', labels: { 'paseo-room.assignment': id, 'paseo.parent-agent-id': 'lead-1' } });
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([expect.objectContaining({ outcome: 'archived-unbound', detail: `Archived recovered child ${String(chosen?.agentId)}.` })]);
    expect([...h.paseo.agents.keys()].filter(agent => agent !== 'lead-1' && agent !== 'decoy')).toEqual([chosen?.agentId]);
    expect(h.paseo.agents.get('decoy')?.status).toBe('idle');
  });

  it('still recovers a create recorded without identities by its exact label', async () => {
    const h = await room();
    const id = await create(h);
    const loaded = await state(h);
    const plugin = { source: 'plugin' as const };
    await h.controller.append(loaded, { type: 'assignment.dispatch-requested', payloadVersion: 1, assignmentId: id, actor: plugin, data: { peerProviderId: 'codex-peer', workspaceId: 'ws-1' } });
    await h.controller.append(loaded, { type: 'ownership.reserved', payloadVersion: 1, assignmentId: id, actor: plugin, data: { workspaceId: 'ws-1', baseCommit: h.base } });
    await h.controller.append(loaded, { type: 'agent.create-requested', payloadVersion: 1, assignmentId: id, actor: plugin, data: { intentId: 'create-old', peerProviderId: 'codex-peer', workspaceId: 'ws-1', parentAgentId: 'lead-1', label: id } });
    h.paseo.addAgent({ id: 'phase1-child', provider: 'codex-peer', labels: { 'paseo-room.assignment': id, 'paseo.parent-agent-id': 'lead-1' } });
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions).toEqual([expect.objectContaining({ intent: 'create-old', outcome: 'archived-unbound', detail: 'Archived recovered child phase1-child.' })]);
  });

  it('records a create that never happened as failed and releases the reservation', async () => {
    const h = await room();
    const id = await create(h);
    h.paseo.faults.set('createAgent', { when: 'before' });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    await restarted(h).recoverAll();
    const after = await state(h);
    expect(after.state.assignments.get(id)?.state).toBe('blocked');
    expect(after.state.ownership.get(id)?.state).toBe('released');
  });

  it('leaves a labelled child that already received a prompt uncertain', async () => {
    const h = await room();
    const id = await create(h);
    h.paseo.faults.set('createAgent', { when: 'after' });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    const child = [...h.paseo.agents.values()].find(agent => agent.id !== 'lead-1');
    if (child) child.lastUserMessageAt = '2026-09-22T10:00:00Z';
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions[0]).toMatchObject({ outcome: 'uncertain' });
    expect((await state(h)).state.ownership.get(id)?.state).toBe('uncertain');
  });

  it('settles a prompt only from its exact message id in the timeline', async () => {
    for (const [fault, expected] of [['after', 'active'], ['before', 'blocked']] as const) {
      const h = await room();
      const id = await create(h);
      h.paseo.faults.set('run', { when: fault });
      await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
      expect((await state(h)).state.assignments.get(id)?.state).toBe('uncertain');
      await restarted(h).recoverAll();
      expect((await state(h)).state.assignments.get(id)?.state, fault).toBe(expected);
    }
    const h = await room();
    const id = await create(h);
    h.paseo.faults.set('run', { when: 'after' });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    h.paseo.timelineOverride = 'unknown';
    await restarted(h).recoverAll();
    expect((await state(h)).state.assignments.get(id)?.state).toBe('uncertain');
  });
});

describe('recovery of archives and gates', () => {
  async function decided(h: Harness): Promise<string> {
    const id = await create(h);
    const dispatched = await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    if (!dispatched.ok) throw new Error(dispatched.message);
    const loaded = await state(h);
    const payload = { completion: 'blocked', blocker: 'x' };
    await h.controller.append(loaded, {
      type: 'report.accepted', payloadVersion: 1, assignmentId: id, actor: { source: 'seat', role: 'peer' },
      data: { generation: 1, tool: 'handoff', requestId: 'req_12345678', fingerprint: actionFingerprint(1, 'handoff', payload), receipt: { schema: 1, receipt: 'r', tool: 'handoff', status: 'accepted', assignmentState: 'blocked' }, report: payload },
    });
    h.paseo.endTurn(dispatched.value.agentId);
    await h.controller.abandon(h.lead, { assignmentId: id, reason: 'stop' });
    return id;
  }

  it('releases ownership when a lost archive response is later proven by a closed status', async () => {
    const h = await room();
    const id = await decided(h);
    h.paseo.faults.set('archive', { when: 'after' });
    expect((await h.controller.close(h.lead, { assignmentId: id })).ok).toBe(false);
    expect((await state(h)).state.ownership.get(id)?.state).toBe('uncertain');
    await restarted(h).recoverAll();
    expect((await state(h)).state.ownership.get(id)?.state).toBe('released');
  });

  it('records an archive that never happened, and lets Lead close again', async () => {
    const h = await room();
    const id = await decided(h);
    h.paseo.faults.set('archive', { when: 'before' });
    await h.controller.close(h.lead, { assignmentId: id });
    const [report] = await restarted(h).recoverAll();
    expect(report?.actions[0]).toMatchObject({ outcome: 'failed' });
    expect((await state(h)).state.ownership.get(id)?.state).toBe('uncertain');
    expect(await h.controller.close(h.lead, { assignmentId: id })).toMatchObject({ ok: true, value: { released: true } });
    expect((await state(h)).state.ownership.get(id)?.state).toBe('released');
  });

  it('settles an interrupted gate from its sidecar, or as uncertain without one', async () => {
    const h = await room();
    const id = await create(h);
    const dispatched = await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    if (!dispatched.ok) throw new Error(dispatched.message);
    const candidate = { kind: 'git-commit' as const, commit: h.base, baseCommit: h.base, changedPaths: [], workspaceId: 'ws-1' };
    const payload = { completion: 'complete', verification: [{ command: 'true', outcome: 'passed' }] };
    const loaded = await state(h);
    await h.controller.append(loaded, {
      type: 'report.accepted', payloadVersion: 1, assignmentId: id, actor: { source: 'seat', role: 'peer' },
      data: { generation: 1, tool: 'handoff', requestId: 'req_12345678', fingerprint: actionFingerprint(1, 'handoff', payload), receipt: { schema: 1, receipt: 'r', tool: 'handoff', status: 'accepted', assignmentState: 'handed-back' }, report: payload, candidate },
    });
    const requested = async (gateRunId: string): Promise<void> => {
      const current = await state(h);
      await h.controller.append(current, { type: 'gate.requested', payloadVersion: 1, assignmentId: id, actor: { source: 'plugin' }, data: { gateRunId, candidate, command: 'true', timeoutSeconds: 30, processContractVersion: 1, environmentPolicyVersion: 1 } });
    };

    // The plugin restarted before the first gate published anything.
    await requested('gate-lost');
    const [lost] = await restarted(h).recoverAll();
    expect(lost?.actions).toEqual([expect.objectContaining({ intent: 'gate-lost', outcome: 'uncertain' })]);

    // The second gate published its sidecar just before the restart.
    await requested('gate-done');
    await writeFile(join(loaded.store.gatesDirectory, 'gate-done.result.json'), JSON.stringify({
      id: 'gate-done', assignmentId: id, candidate, command: 'true', startedAt: '2026-09-22T10:00:00Z', finishedAt: '2026-09-22T10:00:01Z',
      exitCode: 0, timedOut: false, termination: 'exited', processContractVersion: 1, environmentPolicyVersion: 1, outputDigest: `sha256:${'0'.repeat(64)}`, workspaceMoved: false,
    }));
    const [done] = await restarted(h).recoverAll();
    expect(done?.actions).toEqual([expect.objectContaining({ intent: 'gate-done', outcome: 'succeeded' })]);
    expect((await state(h)).state.assignments.get(id)?.gates.map(gate => gate.status)).toEqual(['uncertain', 'finished']);
  });

  it('replays to the same projection after the cache is deleted', async () => {
    const h = await room();
    await decided(h);
    const store = await h.controller.projectFor(h.repo);
    const before = JSON.stringify([...project(store.meta.projectId, (await store.replay()).events).state.assignments]);
    await store.clearCache();
    expect(JSON.stringify([...project(store.meta.projectId, (await store.replay()).events).state.assignments])).toBe(before);
  });
});

describe('lifecycle adapter', () => {
  it('supplies the Paseo handle, runs start-up recovery once and recovers the named agent\'s project', async () => {
    const h = await room();
    const handlers = new Map<string, (event: unknown, context: { paseo: PaseoApi }) => unknown>();
    const handle = new PaseoHandle();
    const recovered: string[] = [];
    const recovery = restarted(h);
    const original = recovery.recoverAll.bind(recovery);
    recovery.recoverAll = () => { recovered.push('all'); return original(); };
    registerLifecycle({ on: ((name: string, handler: (event: unknown, context: { paseo: PaseoApi }) => unknown) => { handlers.set(name, handler); return () => undefined; }) as never }, handle, recovery, {}, () => undefined);
    expect([...handlers.keys()].sort()).toEqual(['agent.archived', 'agent.created', 'agent.permission_requested', 'agent.permission_resolved', 'agent.turn_ended', 'agent.turn_started']);
    const api = {} as PaseoApi;
    await handlers.get('agent.archived')?.({ agent: { id: 'nobody' }, archivedAt: 'x' }, { paseo: api });
    await handlers.get('agent.created')?.({ agent: { id: 'x' } }, { paseo: api });
    expect(handle.available).toBe(true);
    expect(recovered).toEqual(['all']);
  });
});
