import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assignmentName, peerTitle } from '../src/runtime-plugin/server/brief.js';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { toolDefinitions } from '../src/runtime-plugin/server/tools.js';
import { assignmentDetailView } from '../src/runtime-plugin/server/domain/views.js';
import { DELEGATING_THINKING as PLUGIN_DELEGATING_THINKING } from '../src/runtime-plugin/shared/effort.js';
import { DELEGATING_THINKING } from '../src/roles.js';
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
    expect(createCall?.args[0]).toMatchObject({ provider: 'codex-peer', parentAgentId: 'lead-1', labels: { 'paseo-room.assignment': id }, idempotencyKey: `${id}-g1-create` });
    // The runtime chose the agent id before the call, and Paseo honoured it.
    expect(result.ok && result.value.agentId).toBe((createCall?.args[0] as { agentId?: string } | undefined)?.agentId);
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

  it('names an assignment by its disposition and a one-line gist of its outcome', () => {
    const named = { id: 'asg_12345678', input: { kind: 'reviewer' as const, outcome: 'Review the\n  Docker Compose dev environment for bead cmdb-469.8 before it lands on main' } };
    expect(peerTitle(named)).toBe('Reviewer · Review the Docker Compose dev environment for… · asg_12345678');
    expect(assignmentName(named)).toBe('Reviewer "Review the Docker Compose dev environment for…" (asg_12345678)');
    expect(peerTitle({ id: 'asg_12345678', input: { kind: 'scout', outcome: 'Map auth' } })).toBe('Scout · Map auth · asg_12345678');
  });

  it('lets Lead choose thinking only inside the operator\'s envelope and Paseo\'s options, with a reason', async () => {
    const h = await harness({ peerEffort: { allowedThinking: { 'codex-peer': ['high', 'max'] } } });
    open.push(h);
    h.paseo.peerModels['codex-peer'] = 'gpt-operator';
    h.paseo.peerThinking['codex-peer'] = 'medium';
    h.paseo.thinkingCatalog['codex-peer/gpt-operator'] = ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id }));
    // Read-only work, so several dispatches may hold Peers at once in Lead's workspace.
    const dispatch = async (thinking: string, thinkingReason?: string) => {
      const id = await assignment(h, readOnlyBrief(h.base));
      return { id, result: await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer', thinking, ...(thinkingReason === undefined ? {} : { thinkingReason }) }) };
    };
    // Each refusal comes before anything is recorded.
    const noReason = await dispatch('high');
    expect(noReason.result).toMatchObject({ ok: false, code: 'thinking_reason_missing' });
    expect((await ledger(h, noReason.id)).types).toEqual(['assignment.created']);
    expect((await dispatch('xhigh', 'Unfamiliar subsystem.')).result).toMatchObject({ ok: false, code: 'thinking_not_allowed', message: expect.stringContaining('medium, high, max') as unknown });
    expect((await dispatch('max', 'Unfamiliar subsystem.')).result).toMatchObject({ ok: false, code: 'thinking_unsupported', message: expect.stringContaining('low, medium, high, xhigh') as unknown });

    // The profile's own option needs no reason and records no choice.
    const kept = await dispatch('medium');
    expect(kept.result.ok).toBe(true);
    expect((await ledger(h, kept.id)).view).not.toHaveProperty('chosenThinking');

    const chosen = await dispatch('high', 'Reviews a migration that is hard to reverse.');
    expect(chosen.result.ok).toBe(true);
    expect(h.paseo.calls.filter(call => call.operation === 'createAgent').at(-1)?.args[0]).toMatchObject({ model: 'gpt-operator', thinkingOptionId: 'high' });
    const { state, view } = await ledger(h, chosen.id);
    expect(view).toMatchObject({ chosenThinking: 'high', thinkingReason: 'Reviews a migration that is hard to reverse.', observedThinking: 'high' });
    // Supervisor and the panel see the choice, its reason and what the Peer runs.
    expect(assignmentDetailView(state, chosen.id, 'lead')?.thinking).toEqual({ chosen: 'high', reason: 'Reviews a migration that is hard to reverse.', observed: 'high' });
  });

  it('never lets Lead choose a thinking option that delegates, whatever the operator allows', async () => {
    const h = await harness({ peerEffort: { allowedThinking: { 'codex-peer': ['high', 'ultra'] } } });
    open.push(h);
    h.paseo.thinkingCatalog['codex-peer/model-x'] = ['medium', 'high', 'ultra'].map(id => ({ id, label: id }));
    const id = await assignment(h, readOnlyBrief(h.base));
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer', thinking: 'ultra', thinkingReason: 'Hardest work.' }))
      .toMatchObject({ ok: false, code: 'thinking_delegates' });
    expect(toolDefinitions('lead', undefined, { allowedThinking: { 'codex-peer': ['high', 'ultra'] } }).find(tool => tool.name === 'assignment_dispatch')?.description)
      .toContain('the operator allows codex-peer: high.');
    // The plugin keeps its own copy of the CLI's list, since it may not import the CLI.
    expect(PLUGIN_DELEGATING_THINKING).toEqual(DELEGATING_THINKING);
  });

  it('takes the model\'s own default when the profile sets no thinking, and records Paseo\'s value only when it fits', async () => {
    const h = await harness();
    open.push(h);
    h.paseo.thinkingCatalog['codex-peer/model-x'] = [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium', isDefault: true }];
    const kept = await assignment(h, readOnlyBrief(h.base));
    expect((await h.controller.dispatch(h.lead, { assignmentId: kept, peerProvider: 'codex-peer', thinking: 'medium' })).ok).toBe(true);
    expect((await ledger(h, kept)).view).not.toHaveProperty('chosenThinking');

    // A value Paseo reports that the event cannot hold is left out rather than failing the binding.
    h.paseo.peerThinking['codex-peer'] = 'x'.repeat(70);
    const odd = await assignment(h, readOnlyBrief(h.base));
    expect((await h.controller.dispatch(h.lead, { assignmentId: odd, peerProvider: 'codex-peer' })).ok).toBe(true);
    expect((await ledger(h, odd)).view).toMatchObject({ state: 'active' });
    expect((await ledger(h, odd)).view).not.toHaveProperty('observedThinking');
  });

  it('describes the thinking the operator allows in Lead\'s dispatch tool', () => {
    const dispatchTool = (effort?: { allowedThinking: Record<string, string[]> }) => toolDefinitions('lead', undefined, effort).find(tool => tool.name === 'assignment_dispatch')?.description ?? '';
    expect(dispatchTool()).toContain('allows no other thinking yet');
    // The criteria are the contract's to state; the tool only points at it.
    expect(dispatchTool()).toContain('as your contract directs');
    expect(dispatchTool()).not.toContain('uncertainty');
    expect(dispatchTool({ allowedThinking: { 'claude-peer': ['low', 'high'], 'pi-peer': [] } })).toContain('the operator allows claude-peer: low, high.');
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
      .toMatchObject({ provider: 'codex-peer', model: 'gpt-operator', modeId: 'full-access', title: `Engineer · Add the feature · ${id}` });
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

describe('fake Paseo workspaces reproduce the Phase 2 probe', () => {
  const request = (h: Harness, change: Record<string, string> = {}) => ({
    workspaceId: 'wks_00000000000000aa', idempotencyKey: 'ws-asg_1-e1', title: 'room asg_1', cwd: h.repo, baseCommit: h.base,
    branchName: 'paseo-room/asg_1', worktreeSlug: 'asg_1', ...change,
  });

  it('replays a key, conflicts on a changed request or a reused id, and keeps one worktree', async () => {
    const h = await room();
    const first = await h.paseo.createWorktreeWorkspace(request(h));
    expect(first).toMatchObject({ id: 'wks_00000000000000aa', kind: 'worktree' });
    expect(await h.paseo.createWorktreeWorkspace(request(h))).toEqual(first);
    await expect(h.paseo.createWorktreeWorkspace(request(h, { title: 'different' }))).rejects.toThrow('workspace_request_key_conflict');
    await expect(h.paseo.createWorktreeWorkspace(request(h, { idempotencyKey: 'other' }))).rejects.toThrow('workspace_id_conflict');
    expect((await h.git('worktree', 'list')).split('\n')).toHaveLength(2);
    expect(await h.git('-C', first.directory ?? '', 'rev-parse', 'HEAD')).toBe(h.base);
  });

  it('branches from an existing branch under a renamed branch instead of the requested base', async () => {
    const h = await room();
    await h.git('branch', 'paseo-room/asg_1');
    await writeFile(join(h.repo, 'next.txt'), 'x');
    await h.git('add', '.');
    await h.git('commit', '-q', '-m', 'next');
    const moved = await h.git('rev-parse', 'HEAD');
    const created = await h.paseo.createWorktreeWorkspace(request(h, { baseCommit: moved }));
    expect(await h.git('-C', created.directory ?? '', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('paseo-room/asg_1-2');
    expect(await h.git('-C', created.directory ?? '', 'rev-parse', 'HEAD')).toBe(h.base);
  });

  it('places a parented child in the named workspace with no prompt, and archive removes the directory but keeps the branch', async () => {
    const h = await room();
    const workspace = await h.paseo.createWorktreeWorkspace(request(h));
    const input = { provider: 'codex-peer', model: 'm', parentAgentId: 'lead-1', title: 'Peer asg_1', labels: { 'paseo-room.assignment': 'asg_1' }, agentId: '0b8f6c2e-8f1a-4c1e-9a55-3c1d2e4f5a6b', idempotencyKey: 'asg_1-g1-create' };
    const { agentId } = await h.paseo.createAgentInWorkspace(workspace.id, input);
    expect(agentId).toBe(input.agentId);
    expect(await h.paseo.createAgentInWorkspace(workspace.id, input)).toEqual({ agentId });
    await expect(h.paseo.createAgentInWorkspace(workspace.id, { ...input, title: 'x' })).rejects.toThrow('agent_request_key_conflict');
    expect(await h.paseo.getAgent(agentId)).toMatchObject({
      workspaceId: workspace.id, cwd: workspace.directory, lastUserMessageAt: null, labels: { 'paseo.parent-agent-id': 'lead-1' },
    });
    expect(await h.paseo.archiveWorkspace(workspace.id)).toMatchObject({ archivedAt: expect.any(String) as string });
    expect(await h.paseo.getWorkspace(workspace.id)).toBeUndefined();
    expect((await h.paseo.getAgent(agentId))?.status).toBe('closed');
    expect(await h.git('worktree', 'list')).not.toContain('asg_1');
    expect(await h.git('rev-parse', '--verify', 'paseo-room/asg_1')).toBe(h.base);
  });
});
