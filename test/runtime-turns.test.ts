import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { createPeerHandlers } from '../src/runtime-plugin/server/handlers/peer.js';
import { createTurnHandlers, reportingToolOf } from '../src/runtime-plugin/server/handlers/turns.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { Spool } from '../src/runtime-plugin/server/spool.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
const spools: Spool[] = [];
afterEach(async () => {
  for (const spool of spools.splice(0)) spool.stop();
  await Promise.all(open.splice(0).map(entry => entry.cleanup()));
});

async function dispatched() {
  const h = await harness();
  open.push(h);
  const created = await h.controller.createAssignment(h.lead, writableBrief(h.base));
  if (!created.ok) throw new Error(created.message);
  const result = await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'claude-peer' });
  if (!result.ok) throw new Error(result.message);
  const spool = new Spool({ root: join(h.runtimeRoot, 'spool'), resolve: () => Promise.resolve(undefined), registries: { supervisor: {}, lead: {}, peer: {} } });
  spools.push(spool);
  await spool.start();
  return { h, id: created.value.assignmentId, peer: result.value.agentId, spool, turns: createTurnHandlers(h.controller, spool) };
}

async function view(h: Harness, id: string) {
  const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  return { view: loaded.value.state.assignments.get(id), types: loaded.value.events.filter(event => event.assignmentId === id).map(event => event.type) };
}

const agent = (id: string) => ({ id, workspaceId: 'ws-1', parentAgentId: 'lead-1', provider: 'claude-peer', cwd: '/repo', title: null });
const ended = (id: string, text = 'Done.') => ({ agent: agent(id), turnId: 't1', outcome: { kind: 'completed' as const }, timeline: [{ type: 'assistant_message' as const, text }] });

describe('turn end without a report', () => {
  it('blocks the assignment and tells Lead, ignoring any report-looking prose', async () => {
    const { h, id, peer, turns } = await dispatched();
    const prose = '```json\n{"completion":"complete","summary":"all done"}\n```';
    expect(await turns.turnEnded(ended(peer, prose))).toBe('missing');
    const after = (await view(h, id)).view;
    expect(after).toMatchObject({ state: 'blocked', reportingState: 'consumed', reports: [] });
    expect(after?.candidate).toBeUndefined();
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('without an accepted ask or handoff');
  });

  it('does nothing when the turn already produced an accepted report', async () => {
    const { h, id, peer, turns } = await dispatched();
    const association = await h.hooks.correlations.findByAssignment(id);
    const capability = (await latestCapability(join(h.runtimeRoot, 'capabilities'), association?.correlationId ?? ''))?.capability;
    await createPeerHandlers(h.controller).ask({ protocol: 1, requestId: 'req_turnask1', operation: 'ask', payload: { question: 'q', blockingContext: 'c', evidence: [] }, correlation: association?.correlationId ?? '', ...(capability === undefined ? {} : { capability }) }, { kind: 'peer', role: 'peer' });
    expect(await turns.turnEnded(ended(peer))).toBe('none');
    expect((await view(h, id)).view?.state).toBe('questioned');
  });

  it('holds the fence as uncertain while a report from the turn is unrecorded', async () => {
    const { h, id, peer, spool } = await dispatched();
    const stuck = Object.assign(Object.create(spool) as Spool, { unresolvedFor: () => Promise.resolve(['req_pending01']), schedule: () => Promise.resolve() });
    expect(await createTurnHandlers(h.controller, stuck).turnEnded(ended(peer))).toBe('uncertain');
    expect((await view(h, id)).view).toMatchObject({ state: 'uncertain', reportingState: 'uncertain' });
  });
});

describe('a turn that ended while the runtime was down', () => {
  // Paseo announces a turn end once, fire-and-forget; a plugin that was not running never hears it.
  const recover = (h: Harness, spool: Spool) => new Recovery(h.controller, spool).recoverAll();

  it('is judged on recovery as a missing report once live evidence proves the turn is over', async () => {
    const { h, id, peer, spool } = await dispatched();
    h.paseo.endTurn(peer);
    const [report] = await recover(h, spool);
    expect(report?.actions).toEqual([expect.objectContaining({ assignmentId: id, intent: 'turn-g1', outcome: 'failed' })]);
    expect((await view(h, id)).view).toMatchObject({ state: 'blocked', reportingState: 'consumed' });
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('without an accepted ask or handoff');
    // Settled once: a second pass finds nothing left to judge and never prompts the Peer again.
    expect((await recover(h, spool))[0]?.actions).toEqual([]);
    expect(h.paseo.agents.get(peer)?.prompts).toHaveLength(1);
  });

  it('leaves a turn alone while it runs, or before Paseo has recorded anything after the prompt', async () => {
    const { h, id, peer, spool } = await dispatched();
    expect((await recover(h, spool))[0]?.actions).toEqual([]);
    const live = h.paseo.agents.get(peer);
    if (live === undefined) throw new Error('missing');
    live.activeTurn = false;
    live.status = 'idle';
    expect((await recover(h, spool))[0]?.actions).toEqual([]);
    expect((await view(h, id)).view?.state).toBe('active');
  });

  it('does not judge a turn whose prompt it cannot find in the timeline', async () => {
    const { h, id, peer, spool } = await dispatched();
    h.paseo.endTurn(peer);
    h.paseo.timelineOverride = 'unknown';
    expect((await recover(h, spool))[0]?.actions).toEqual([]);
    expect((await view(h, id)).view?.state).toBe('active');
  });

  it('records uncertain, never missing, while a report from the turn is still in the spool', async () => {
    const { h, id, peer, spool } = await dispatched();
    h.paseo.endTurn(peer);
    const stuck = Object.assign(Object.create(spool) as Spool, { unresolvedFor: () => Promise.resolve(['req_pending01']) });
    const [report] = await recover(h, stuck);
    expect(report?.actions).toEqual([expect.objectContaining({ outcome: 'uncertain' })]);
    expect((await view(h, id)).view).toMatchObject({ state: 'uncertain', reportingState: 'uncertain' });
  });
});

describe('reporting-tool permission', () => {
  it('recognizes only the reporting tools of the room bridge', () => {
    expect(reportingToolOf('mcp__paseo_room__ask')).toBe('ask');
    expect(reportingToolOf('mcp__paseo_room__handoff')).toBe('handoff');
    expect(reportingToolOf('paseo_room__ask')).toBe('ask');
    expect(reportingToolOf('mcp__other__ask')).toBeUndefined();
    expect(reportingToolOf('Bash')).toBeUndefined();
  });

  it('waits while a permission is pending, never answers it, and blocks only after a denied turn ends', async () => {
    const { h, id, peer, turns } = await dispatched();
    const live = h.paseo.agents.get(peer);
    if (live === undefined) throw new Error('missing');
    live.pendingPermissions = [{ id: 'perm-1', name: 'mcp__paseo_room__handoff' }];
    expect(await turns.permissionRequested({ agent: agent(peer), request: { id: 'perm-1', provider: 'claude', name: 'mcp__paseo_room__handoff', kind: 'tool' } as never })).toBe(true);
    expect((await view(h, id)).view).toMatchObject({ state: 'awaiting-permission', awaitingPermissionId: 'perm-1', reportingState: 'open' });
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('waiting for someone to allow');
    expect(await turns.turnEnded(ended(peer))).toBe('waiting');
    expect((await view(h, id)).view?.state).toBe('awaiting-permission');

    live.pendingPermissions = [];
    expect(await turns.permissionResolved({ agent: agent(peer), requestId: 'perm-1', resolution: { behavior: 'deny', message: 'no' } as never })).toBe(true);
    expect((await view(h, id)).view?.state).toBe('active');
    expect(await turns.turnEnded(ended(peer))).toBe('missing');
    expect((await view(h, id)).types).toEqual(expect.arrayContaining(['permission.awaiting', 'permission.resolved', 'report.missing']));
    // The runtime's Paseo port has no way to answer a permission at all.
    expect(h.paseo.calls.map(call => call.operation)).not.toContain('respondToPermission');
  });

  it('ignores permissions for other tools and for seats that are not runtime Peers', async () => {
    const { h, id, peer, turns } = await dispatched();
    expect(await turns.permissionRequested({ agent: agent(peer), request: { id: 'p', provider: 'claude', name: 'Bash', kind: 'tool' } as never })).toBe(false);
    expect(await turns.permissionRequested({ agent: agent('lead-1'), request: { id: 'p', provider: 'codex', name: 'mcp__paseo_room__ask', kind: 'tool' } as never })).toBe(false);
    expect((await view(h, id)).view?.state).toBe('active');
  });
});
