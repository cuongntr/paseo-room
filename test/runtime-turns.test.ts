import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { createPeerHandlers } from '../src/runtime-plugin/server/handlers/peer.js';
import { createTurnHandlers, reportingToolOf, TurnStarts } from '../src/runtime-plugin/server/handlers/turns.js';
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
  return { h, id: created.value.assignmentId, peer: result.value.agentId, spool, turns: createTurnHandlers(h.controller, spool, new TurnStarts()) };
}

async function view(h: Harness, id: string) {
  const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  return { view: loaded.value.state.assignments.get(id), types: loaded.value.events.filter(event => event.assignmentId === id).map(event => event.type) };
}

/** The Peer asks Lead through its reporting bridge, as the `ask` tool would. */
async function askLead(h: Harness, id: string, requestId = 'req_turnask1'): Promise<void> {
  const association = await h.hooks.correlations.findByAssignment(id);
  const capability = (await latestCapability(join(h.runtimeRoot, 'capabilities'), association?.correlationId ?? ''))?.capability;
  await createPeerHandlers(h.controller).ask({ protocol: 1, requestId, operation: 'ask', payload: { question: 'q', blockingContext: 'c', evidence: [] }, correlation: association?.correlationId ?? '', ...(capability === undefined ? {} : { capability }) }, { kind: 'peer', role: 'peer' });
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
    await askLead(h, id);
    expect(await turns.turnEnded(ended(peer))).toBe('none');
    expect((await view(h, id)).view?.state).toBe('questioned');
  });

  it('holds the fence as uncertain while a report from the turn is unrecorded', async () => {
    const { h, id, peer, spool } = await dispatched();
    const stuck = Object.assign(Object.create(spool) as Spool, { unresolvedFor: () => Promise.resolve(['req_pending01']), schedule: () => Promise.resolve() });
    expect(await createTurnHandlers(h.controller, stuck, new TurnStarts()).turnEnded(ended(peer))).toBe('uncertain');
    expect((await view(h, id)).view).toMatchObject({ state: 'uncertain', reportingState: 'uncertain' });
  });

  // cmdb, 2026-10-01: a handoff sent while the runtime was stalled was still in the spool when the
  // turn ended. Once answered it was refused as uncertain, and the Peer's retries too, for good.
  it('accepts the unrecorded report once it is answered', async () => {
    const { h, id, peer, spool } = await dispatched();
    const stuck = Object.assign(Object.create(spool) as Spool, { unresolvedFor: () => Promise.resolve(['req_pending01']), schedule: () => Promise.resolve() });
    await createTurnHandlers(h.controller, stuck, new TurnStarts()).turnEnded(ended(peer));
    await askLead(h, id);
    const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
    const refused = loaded.ok ? loaded.value.events.flatMap(event => (event.type === 'report.refused' ? [event.data.reason] : [])) : ['unloaded'];
    expect(refused).toEqual([]);
    expect((await view(h, id)).view).toMatchObject({ state: 'questioned', reportingState: 'consumed' });
  });

  it('settles as missing, and tells Lead, once nothing from the turn is left in the spool', async () => {
    const { h, id, peer, spool } = await dispatched();
    const stuck = Object.assign(Object.create(spool) as Spool, { unresolvedFor: () => Promise.resolve(['req_pending01']), schedule: () => Promise.resolve() });
    await createTurnHandlers(h.controller, stuck, new TurnStarts()).turnEnded(ended(peer));
    const recover = (spoolUsed: Spool) => new Recovery(h.controller, spoolUsed).recoverAll();
    // Still pending: recovery leaves the fence closed.
    await recover(stuck);
    expect((await view(h, id)).view?.state).toBe('uncertain');
    // Every entry terminal and none accepted: the turn produced no report.
    const [report] = await recover(spool);
    expect(report?.actions).toContainEqual(expect.objectContaining({ assignmentId: id, outcome: 'failed' }));
    expect((await view(h, id)).view).toMatchObject({ state: 'blocked', reportingState: 'consumed' });
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('without an accepted ask or handoff');
  });
});

describe('an answer sent before the asking turn is judged', () => {
  // The Peer asks and ends its turn; Lead answers at once, and the answer opens generation 2 before
  // the runtime has judged the asking turn's end (cmdb, 2026-09-27: 0.3 s later it was judged
  // against the answer, and the Peer's real handoff was refused as stale).
  async function answeredAsTurnEnds() {
    const d = await dispatched();
    let clock = 0;
    const starts = new TurnStarts(() => clock);
    const turns = createTurnHandlers(d.h.controller, d.spool, starts);
    await askLead(d.h, d.id);
    d.h.paseo.endTurn(d.peer);
    const answered = await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'Yes.' });
    if (!answered.ok) throw new Error(answered.message);
    const loaded = await d.h.controller.load(await d.h.controller.projectFor(d.h.repo));
    if (!loaded.ok) throw new Error(loaded.message);
    const answerSent = Date.parse(loaded.value.events.filter(event => event.type === 'run.requested').at(-1)?.occurredAt ?? '');
    // The asking turn began before the answer was sent; any later start began after it.
    clock = answerSent - 1_000;
    turns.turnStarted({ agent: agent(d.peer), turnId: 't1' });
    clock = answerSent + 1_000;
    return { ...d, starts, turns };
  }

  it('does not judge the asking turn against the answer, and still judges the answer turn', async () => {
    const { h, id, peer, turns } = await answeredAsTurnEnds();
    expect(await turns.turnEnded(ended(peer, 'I asked Lead and am waiting.'))).toBe('none');
    expect((await view(h, id)).view).toMatchObject({ state: 'active', reportingGeneration: 2, reportingState: 'open' });
    expect((await view(h, id)).types).not.toContain('report.missing');

    turns.turnStarted({ agent: agent(peer), turnId: 't2' });
    expect(await turns.turnEnded({ ...ended(peer), turnId: 't2' })).toBe('missing');
    expect((await view(h, id)).view).toMatchObject({ state: 'blocked', reportingState: 'consumed' });
  });

  it('keeps recovery from judging the answer before its turn has begun', async () => {
    const { h, id, peer, spool, starts } = await answeredAsTurnEnds();
    h.paseo.endTurn(peer);
    const recover = () => new Recovery(h.controller, spool, starts).recoverAll();
    expect((await recover())[0]?.actions).toEqual([]);
    expect((await view(h, id)).view).toMatchObject({ state: 'active', reportingState: 'open' });

    starts.started(peer, 't2');
    h.paseo.endTurn(peer);
    expect((await recover())[0]?.actions).toEqual([expect.objectContaining({ assignmentId: id, intent: 'turn-g2', outcome: 'failed' })]);
  });

  it('does not judge an asking turn that began before the plugin started against a later answer', async () => {
    // cmdb, 2026-09-28: the plugin reloaded while the Peer's turn ran, so its start was never
    // announced; the answer opened generation 2, the asking turn's end was judged against it, and
    // the Peer's real handoff was refused as stale.
    const d = await dispatched();
    await askLead(d.h, d.id);
    d.h.paseo.endTurn(d.peer);
    const answered = await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'Yes.' });
    if (!answered.ok) throw new Error(answered.message);
    const loaded = await d.h.controller.load(await d.h.controller.projectFor(d.h.repo));
    if (!loaded.ok) throw new Error(loaded.message);
    let clock = Date.parse(loaded.value.events.filter(event => event.type === 'run.requested').at(-1)?.occurredAt ?? '') - 500;
    const turns = createTurnHandlers(d.h.controller, d.spool, new TurnStarts(() => clock));
    expect(await turns.turnEnded(ended(d.peer, 'I asked Lead and am waiting.'))).toBe('none');
    expect((await view(d.h, d.id)).view).toMatchObject({ state: 'active', reportingGeneration: 2, reportingState: 'open' });

    clock += 1_000;
    turns.turnStarted({ agent: agent(d.peer), turnId: 't2' });
    expect(await turns.turnEnded({ ...ended(d.peer), turnId: 't2' })).toBe('missing');
  });

  it('still judges the answer once its Peer is archived before the turn could begin', async () => {
    const { h, id, peer, spool, starts } = await answeredAsTurnEnds();
    await h.paseo.archive(peer);
    const [report] = await new Recovery(h.controller, spool, starts).recoverAll();
    expect(report?.actions).toEqual(expect.arrayContaining([expect.objectContaining({ assignmentId: id, intent: 'turn-g2', outcome: 'failed' })]));
    expect((await view(h, id)).view).toMatchObject({ state: 'blocked', reportingState: 'consumed' });
  });
});

describe('a Lead refused as peer_busy', () => {
  // The Peer asks and takes a few more seconds to end its turn; Lead answers first and is refused
  // (cmdb, 2026-09-27..30: 32 refusals, and nothing woke Lead once the Peer was free).
  it('is told when the Peer\'s turn ends, and its answer then goes', async () => {
    const { h, id, peer, turns } = await dispatched();
    await askLead(h, id);
    const refused = await h.controller.answer(h.lead, { assignmentId: id, answer: 'Yes.' });
    expect(refused).toMatchObject({ ok: false, code: 'peer_busy', message: expect.stringContaining('The runtime tells you when it ends') as unknown });
    h.paseo.endTurn('lead-1');

    h.paseo.endTurn(peer);
    expect(await turns.turnEnded(ended(peer, 'I asked Lead and am waiting.'))).toBe('none');
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('has ended its turn, so the answer refused as peer_busy can go now');
    expect(await h.controller.answer(h.lead, { assignmentId: id, answer: 'Yes.' })).toMatchObject({ ok: true });

    // Told once: the answer turn's own end is judged, and wakes nobody for the old refusal.
    h.paseo.endTurn('lead-1');
    h.paseo.endTurn(peer);
    turns.turnStarted({ agent: agent(peer), turnId: 't2' });
    expect(await turns.turnEnded({ ...ended(peer), turnId: 't2' })).toBe('missing');
    expect(h.paseo.agents.get('lead-1')?.prompts.filter(prompt => prompt.text.includes('peer_busy'))).toHaveLength(1);
  });

  it('is not told once its retry went through, even when the answer turn asks again', async () => {
    const { h, id, peer, turns } = await dispatched();
    await askLead(h, id);
    expect(await h.controller.answer(h.lead, { assignmentId: id, answer: 'Yes.' })).toMatchObject({ ok: false, code: 'peer_busy' });
    h.paseo.endTurn(peer);
    // The retry went through before the asking turn's end was heard, and its turn asks again: the
    // assignment waits on Lead once more, but in a later generation than the refusal.
    expect(await h.controller.answer(h.lead, { assignmentId: id, answer: 'Yes.' })).toMatchObject({ ok: true });
    turns.turnStarted({ agent: agent(peer), turnId: 't2' });
    await askLead(h, id, 'req_turnask2');
    h.paseo.endTurn(peer);
    expect(await turns.turnEnded({ ...ended(peer), turnId: 't2' })).toBe('none');
    expect((await view(h, id)).view).toMatchObject({ state: 'questioned', reportingGeneration: 2 });
    const loaded = await h.controller.load(await h.controller.projectFor(h.repo));
    if (!loaded.ok) throw new Error(loaded.message);
    expect(loaded.value.events.some(event => event.type === 'notice.pending' && event.data.kind === 'peer-free')).toBe(false);
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
