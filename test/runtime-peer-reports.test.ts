import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { latestCapability } from '../src/runtime-plugin/server/capabilities.js';
import { Controller } from '../src/runtime-plugin/server/controller.js';
import { createPeerHandlers } from '../src/runtime-plugin/server/handlers/peer.js';
import type { HandlerReply } from '../src/runtime-plugin/server/spool.js';
import { harness, readOnlyBrief, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

interface Seat { readonly h: Harness; readonly id: string; readonly peer: string; readonly correlation: string }

async function seat(brief?: (base: string) => Record<string, unknown>): Promise<Seat> {
  const h = await harness();
  open.push(h);
  const created = await h.controller.createAssignment(h.lead, (brief ?? (base => writableBrief(base, { gate: { command: 'true', timeoutSeconds: 30, runtimeRerun: 'optional', processContractVersion: 1 } })))(h.base));
  if (!created.ok) throw new Error(created.message);
  const dispatched = await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'codex-peer' });
  if (!dispatched.ok) throw new Error(dispatched.message);
  const association = await h.hooks.correlations.findByAssignment(created.value.assignmentId);
  return { h, id: created.value.assignmentId, peer: dispatched.value.agentId, correlation: association?.correlationId ?? '' };
}

/** What arrives over the bridge: JSON, so an undefined field is absent rather than present. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

let counter = 0;
async function call(s: Seat, tool: 'ask' | 'handoff', payload: unknown, options: { requestId?: string; capability?: string | null; controller?: Controller } = {}): Promise<HandlerReply> {
  const capability = options.capability === null ? undefined : options.capability ?? (await latestCapability(join(s.h.runtimeRoot, 'capabilities'), s.correlation))?.capability;
  const handlers = createPeerHandlers(options.controller ?? s.h.controller);
  return await handlers[tool]({
    protocol: 1, requestId: options.requestId ?? `req_${String(++counter).padStart(8, '0')}`, operation: tool, payload: wire(payload),
    correlation: s.correlation, ...(capability === undefined ? {} : { capability }),
  }, { kind: 'peer', role: 'peer' });
}

async function snapshot(s: Seat) {
  const loaded = await s.h.controller.load(await s.h.controller.projectFor(s.h.repo));
  if (!loaded.ok) throw new Error(loaded.message);
  const view = loaded.value.state.assignments.get(s.id);
  return { view, owner: loaded.value.state.ownership.get(s.id)?.state, events: loaded.value.events };
}

const ask = { question: 'Which base?', blockingContext: 'Two branches exist.', evidence: ['git branch'] };
const complete = (outcome = 'passed') => ({ completion: 'complete', summary: 'Implemented.', deliverables: ['src/x.ts'], verification: [{ command: 'true', outcome }], residualRisks: [], evidence: ['true'], details: { kind: 'engineer' } });
const code = (reply: HandlerReply): string | undefined => (reply.result as { error?: { code: string } }).error?.code;

async function commitWork(s: Seat): Promise<string> {
  await writeFile(join(s.h.repo, 'feature.ts'), 'export const x = 1;\n');
  await s.h.git('add', '.');
  await s.h.git('commit', '-q', '-m', 'peer work');
  return await s.h.git('rev-parse', 'HEAD');
}

describe('accepted Peer reports', () => {
  it('records an ask, moves to questioned and tells Lead', async () => {
    const s = await seat();
    const reply = await call(s, 'ask', ask);
    expect(reply).toMatchObject({ ok: true, result: { schema: 1, tool: 'ask', status: 'accepted', assignmentState: 'questioned' } });
    expect(Object.keys(reply.result as object).sort()).toEqual(['assignmentState', 'receipt', 'schema', 'status', 'tool']);
    const { view } = await snapshot(s);
    expect(view).toMatchObject({ state: 'questioned', reportingState: 'consumed' });
    expect(s.h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain(`Engineer "Add the feature" (${s.id}) asks: Which base?`);
  });

  it('derives the candidate from the committed workspace on a complete writable handoff', async () => {
    const s = await seat();
    const head = await commitWork(s);
    expect(await call(s, 'handoff', complete())).toMatchObject({ ok: true, result: { assignmentState: 'handed-back' } });
    const { view } = await snapshot(s);
    expect(view?.candidate).toMatchObject({ commit: head, baseCommit: s.h.base, changedPaths: ['feature.ts'] });
  });

  it('records a blocked handback without a candidate and a read-only handback bound to the observed commit', async () => {
    const blocked = await seat();
    const blockedReply = await call(blocked, 'handoff', { ...complete(), completion: 'blocked', blocker: 'No access.', details: undefined });
    expect(blockedReply, JSON.stringify(blockedReply)).toMatchObject({ ok: true, result: { assignmentState: 'blocked' } });
    expect((await snapshot(blocked)).view?.candidate).toBeUndefined();

    const reviewer = await seat(readOnlyBrief);
    const reply = await call(reviewer, 'handoff', { ...complete(), details: undefined });
    expect(code(reply)).toBe('report_malformed');
    const review = { completion: 'complete', summary: 'Reviewed.', deliverables: [], verification: [], residualRisks: [], evidence: ['read'], details: { kind: 'reviewer', findings: [] } };
    // Engineer details are refused for a reviewer assignment: the kind is bound by the server.
    expect(code(await call(reviewer, 'handoff', { ...review, details: { kind: 'engineer' } }))).toBe('report_malformed');
    const accepted = await call(reviewer, 'handoff', review);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, result: { assignmentState: 'handed-back' } });
    expect((await snapshot(reviewer)).view?.inspectedCommit).toBe(reviewer.h.base);
  });
});

describe('idempotency and generation fencing', () => {
  it('replays one durable receipt for identical retries, even after a restart', async () => {
    const s = await seat();
    const first = await call(s, 'ask', ask, { requestId: 'req_same0001' });
    expect(await call(s, 'ask', ask, { requestId: 'req_same0001' })).toEqual(first);
    expect(await call(s, 'ask', { evidence: ['git branch'], blockingContext: 'Two branches exist.', question: 'Which base?' }, { requestId: 'req_other001' })).toEqual(first);
    const restarted = new Controller({ ...s.h.controller.deps });
    expect(await call(s, 'ask', ask, { requestId: 'req_same0001', controller: restarted })).toEqual(first);
    const { events } = await snapshot(s);
    expect(events.filter(event => event.type === 'report.accepted')).toHaveLength(1);
  });

  it('refuses a reused request id with a different report, and a different report for a consumed turn', async () => {
    const s = await seat();
    await call(s, 'ask', ask, { requestId: 'req_reuse001' });
    expect(code(await call(s, 'ask', { ...ask, question: 'Other?' }, { requestId: 'req_reuse001' }))).toBe('report_conflict');
    expect(code(await call(s, 'ask', { ...ask, question: 'Other?' }))).toBe('report_stale');
  });

  it('refuses a report under an earlier turn\'s capability once a new turn is open', async () => {
    const s = await seat();
    const old = (await latestCapability(join(s.h.runtimeRoot, 'capabilities'), s.correlation))?.capability;
    await call(s, 'ask', ask);
    s.h.paseo.endTurn(s.peer);
    expect((await s.h.controller.answer(s.h.lead, { assignmentId: s.id, answer: 'main' })).ok).toBe(true);
    expect(code(await call(s, 'handoff', complete(), { capability: old ?? '' }))).toBe('report_stale');
    expect(code(await call(s, 'ask', ask, { capability: null }))).toBe('report_stale');
    expect((await snapshot(s)).view).toMatchObject({ state: 'active', reportingGeneration: 2, reportingState: 'open' });
  });
});

describe('refusals change nothing', () => {
  it('refuses malformed, misattributed and failed-precondition reports without consuming the turn', async () => {
    const s = await seat();
    const other = await seat();
    const otherCapability = (await latestCapability(join(other.h.runtimeRoot, 'capabilities'), other.correlation))?.capability ?? '';
    const cases: [string, () => Promise<HandlerReply>][] = [
      ['report_malformed', () => call(s, 'ask', { ...ask, assignmentId: 'asg_forged01' })],
      ['report_malformed', () => call(s, 'ask', { question: 'q' })],
      ['report_malformed', () => call(s, 'handoff', { ...complete(), details: { kind: 'scout', evidence: [], remainingUnknowns: [], confidence: 'low' } })],
      ['report_stale', () => call(s, 'ask', ask, { capability: otherCapability })],
      ['report_precondition', () => call(s, 'handoff', complete('not-run'))],
      ['report_precondition', () => call(s, 'handoff', { ...complete(), verification: [{ command: 'npm test', outcome: 'passed' }] })],
    ];
    for (const [expected, run] of cases) expect(code(await run()), expected).toBe(expected);

    // A clean workspace with an uncommitted change is not a candidate.
    await writeFile(join(s.h.repo, 'dirty.ts'), 'x');
    expect(code(await call(s, 'handoff', complete()))).toBe('report_precondition');

    const { view, owner, events } = await snapshot(s);
    expect(view).toMatchObject({ state: 'active', reportingGeneration: 1, reportingState: 'open', reports: [] });
    expect(owner).toBe('held');
    expect(events.filter(event => event.type === 'report.refused')).toHaveLength(7);
    // Refusal evidence never stores the report payload.
    expect(JSON.stringify(events.filter(event => event.type === 'report.refused'))).not.toContain('Which base?');
  });

  it('refuses a Peer whose live provider or model drifted, or who is gone', async () => {
    const s = await seat();
    const agent = s.h.paseo.agents.get(s.peer);
    if (agent === undefined) throw new Error('missing');
    agent.model = 'swapped';
    expect(code(await call(s, 'ask', ask))).toBe('report_precondition');
    agent.model = 'model-x';
    agent.labels['paseo.parent-agent-id'] = 'someone-else';
    expect(code(await call(s, 'ask', ask))).toBe('report_precondition');
    agent.labels['paseo.parent-agent-id'] = 'lead-1';
    agent.archivedAt = '2026-09-22T12:00:00Z';
    expect(code(await call(s, 'ask', ask))).toBe('report_precondition');
    expect((await snapshot(s)).view?.state).toBe('active');
  });

  it('refuses a correlation that is not a bound Peer and a report outside an active turn', async () => {
    const s = await seat();
    const handlers = createPeerHandlers(s.h.controller);
    const forged = await handlers.ask({ protocol: 1, requestId: 'req_forged01', operation: 'ask', payload: ask, correlation: `cor_${'f'.repeat(32)}` }, { kind: 'peer', role: 'peer' });
    expect(code(forged)).toBe('report_unauthorized');
    await call(s, 'ask', ask);
    s.h.paseo.endTurn(s.peer);
    await s.h.controller.abandon(s.h.lead, { assignmentId: s.id, reason: 'stop' });
    expect(['report_stale', 'report_state']).toContain(code(await call(s, 'handoff', complete())));
  });
});
