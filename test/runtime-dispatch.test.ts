import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { harness, readOnlyBrief, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
async function room(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const created = await harness(options);
  open.push(created);
  return created;
}
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function assignment(h: Harness, brief = writableBrief(h.base)): Promise<string> {
  const result = await h.controller.createAssignment(h.lead, brief);
  if (!result.ok) throw new Error(result.message);
  return result.value.assignmentId;
}

async function ledger(h: Harness, id: string) {
  const store = await h.controller.projectFor(h.repo);
  const loaded = await h.controller.load(store);
  if (!loaded.ok) throw new Error(loaded.message);
  return { state: loaded.value.state, view: loaded.value.state.assignments.get(id), types: loaded.value.events.filter(event => event.assignmentId === id).map(event => event.type) };
}

describe('two-step writable dispatch', () => {
  it('reserves, creates without a prompt, proves the binding, then sends the brief', async () => {
    const h = await room();
    const id = await assignment(h);
    const result = await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    expect(result).toMatchObject({ ok: true, value: { generation: 1 } });
    const { view, state, types } = await ledger(h, id);
    expect(types).toEqual([
      'assignment.created', 'assignment.dispatch-requested', 'ownership.reserved', 'agent.create-requested',
      'agent.create-succeeded', 'binding.published', 'ownership.held', 'reporting.generation-opened', 'run.requested', 'run.succeeded',
    ]);
    expect(view).toMatchObject({ state: 'active', reportingGeneration: 1, reportingState: 'open', observedProviderId: 'codex-peer', observedModel: 'model-x' });
    expect(state.ownership.get(id)?.state).toBe('held');

    const createCall = h.paseo.calls.find(call => call.operation === 'createAgent');
    expect(createCall?.args[0]).toMatchObject({ provider: 'codex-peer', parentAgentId: 'lead-1', labels: { 'paseo-room.assignment': id } });
    expect(createCall?.args[0]).not.toHaveProperty('prompt');
    const peer = h.paseo.agents.get(result.ok ? result.value.agentId : '');
    expect(peer?.prompts).toHaveLength(1);
    expect(peer?.prompts[0]?.text).toContain('Add the feature');
    expect(peer?.prompts[0]?.text).toContain('npm run verify');
    expect(peer?.prompts[0]?.messageId).toBe(`${id}-g1`);

    const association = await h.hooks.correlations.findByAssignment(id);
    expect(association?.agentId).toBe(peer?.id);
    const capability = await latestCapability(join(h.runtimeRoot, 'capabilities'), association?.correlationId ?? '');
    expect(capability?.generation).toBe(1);
  });

  it('refuses a dirty, moved or foreign base without touching the repository', async () => {
    const h = await room();
    const id = await assignment(h);
    await writeFile(join(h.repo, 'README.md'), 'changed\n');
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'base_dirty' });
    expect(await h.git('status', '--porcelain')).toContain('README.md');
    await h.git('checkout', '--', 'README.md');
    await writeFile(join(h.repo, 'a.ts'), 'a');
    await h.git('add', 'a.ts');
    await h.git('commit', '-q', '-m', 'moved');
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'base_moved' });
    expect((await ledger(h, id)).view?.state).toBe('draft');
    expect(h.paseo.calls.some(call => call.operation === 'createAgent')).toBe(false);
  });

  it('refuses a second writer, a non-Lead, another Lead and an ineligible provider', async () => {
    const h = await room();
    const first = await assignment(h);
    const second = await assignment(h);
    expect((await h.controller.dispatch(h.lead, { assignmentId: first, peerProvider: 'codex-peer' })).ok).toBe(true);
    expect(await h.controller.dispatch(h.lead, { assignmentId: second, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'dispatch_refused' });
    expect(await h.controller.dispatch({ ...h.lead, role: 'supervisor' }, { assignmentId: second, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await h.controller.dispatch({ ...h.lead, agentId: 'lead-2' }, { assignmentId: second, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'unauthorized' });
    expect(await h.controller.dispatch(h.lead, { assignmentId: second, peerProvider: 'codex-lead' })).toMatchObject({ ok: false, code: 'peer_provider_ineligible' });
    expect(await h.controller.createAssignment({ ...h.lead, role: 'peer' }, writableBrief(h.base))).toMatchObject({ ok: false, code: 'unauthorized' });
  });

  it('dispatches a read-only reviewer alongside the writer without reserving ownership', async () => {
    const h = await room();
    const writer = await assignment(h);
    expect((await h.controller.dispatch(h.lead, { assignmentId: writer, peerProvider: 'codex-peer' })).ok).toBe(true);
    await writeFile(join(h.repo, 'wip.ts'), 'in progress');
    const reviewer = await assignment(h, readOnlyBrief(h.base));
    expect((await h.controller.dispatch(h.lead, { assignmentId: reviewer, peerProvider: 'claude-peer' })).ok).toBe(true);
    const { state, types } = await ledger(h, reviewer);
    expect(types).not.toContain('ownership.reserved');
    expect(state.ownership.has(reviewer)).toBe(false);
  });

  it('archives a created Peer that fails its fresh-snapshot proof and never prompts it', async () => {
    const h = await room();
    h.paseo.workspaceFor = () => 'ws-elsewhere';
    const id = await assignment(h);
    const result = await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    expect(result).toMatchObject({ ok: false, code: 'binding_refused' });
    const peer = [...h.paseo.agents.values()].find(agent => agent.id !== 'lead-1');
    expect(peer?.prompts).toEqual([]);
    expect(peer?.status).toBe('closed');
    const { view, state, types } = await ledger(h, id);
    expect(types.slice(-5)).toEqual(['binding.refused', 'assignment.close-requested', 'archive.requested', 'archive.succeeded', 'ownership.released']);
    expect(view).toMatchObject({ state: 'uncertain', closure: 'closed' });
    expect(state.ownership.get(id)?.state).toBe('released');
  });

  it('refuses the binding when the bridge never associated, and records uncertainty for unconfirmed effects', async () => {
    const silent = await room({ associationWaitMs: 50 });
    silent.paseo.onCreate = () => Promise.resolve();
    const quiet = await assignment(silent);
    expect(await silent.controller.dispatch(silent.lead, { assignmentId: quiet, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'binding_refused' });

    const lost = await room();
    lost.paseo.faults.set('createAgent', { when: 'after' });
    const id = await assignment(lost);
    expect(await lost.controller.dispatch(lost.lead, { assignmentId: id, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'create_uncertain', retryable: true });
    const created = await ledger(lost, id);
    expect(created.view?.state).toBe('uncertain');
    expect(created.state.ownership.get(id)?.state).toBe('uncertain');

    const unsent = await room();
    unsent.paseo.faults.set('run', { when: 'after' });
    const other = await assignment(unsent);
    expect(await unsent.controller.dispatch(unsent.lead, { assignmentId: other, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'run_uncertain' });
    expect((await ledger(unsent, other)).view).toMatchObject({ state: 'uncertain', reportingState: 'uncertain' });
  });

  it('creates the Peer on the operator-owned model and mode, and refuses when no model is configured', async () => {
    const h = await room();
    h.paseo.peerModels['codex-peer'] = 'gpt-operator';
    // A dispatched Peer runs unattended, so the seat's own launch mode has to reach creation:
    // the provider's interactive default would stall it on its first tool call.
    h.paseo.peerModes['codex-peer'] = 'full-access';
    const id = await assignment(h);
    expect((await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' })).ok).toBe(true);
    expect(h.paseo.calls.find(call => call.operation === 'createAgent')?.args[0])
      .toMatchObject({ provider: 'codex-peer', model: 'gpt-operator', modeId: 'full-access' });
    expect((await ledger(h, id)).view?.observedModel).toBe('gpt-operator');

    const none = await room();
    none.paseo.peerModels['claude-peer'] = null;
    const other = await assignment(none);
    expect(await none.controller.dispatch(none.lead, { assignmentId: other, peerProvider: 'claude-peer' })).toMatchObject({ ok: false, code: 'peer_model_unresolved' });
    expect((await ledger(none, other)).types).toEqual(['assignment.created']);
  });

  it('keeps runtime state inside the room home only', async () => {
    const h = await room();
    await h.controller.dispatch(h.lead, { assignmentId: await assignment(h), peerProvider: 'codex-peer' });
    expect((await readdir(h.repo)).sort()).toEqual(['.git', 'README.md']);
  });
});
