import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actionFingerprint } from '../src/runtime-plugin/server/domain/receipts.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

interface Dispatched { readonly h: Harness; readonly id: string; readonly peer: string }

async function dispatched(change: Record<string, unknown> = {}): Promise<Dispatched> {
  const h = await harness();
  open.push(h);
  const created = await h.controller.createAssignment(h.lead, writableBrief(h.base, { gate: { command: 'true', timeoutSeconds: 30, runtimeRerun: 'optional', processContractVersion: 1 }, ...change }));
  if (!created.ok) throw new Error(created.message);
  const result = await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'codex-peer' });
  if (!result.ok) throw new Error(result.message);
  return { h, id: created.value.assignmentId, peer: result.value.agentId };
}

async function loaded(h: Harness) {
  const result = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

/** Stands in for an accepted Peer report, which the reporting bridge records in production. */
async function report(d: Dispatched, tool: 'ask' | 'handoff', options: { outcome?: string; commit?: boolean; completion?: string } = {}): Promise<void> {
  const { h, id } = d;
  if (options.commit !== false && tool === 'handoff') {
    await writeFile(join(h.repo, `work-${String(Date.now())}.ts`), 'x');
    await h.git('add', '.');
    await h.git('commit', '-q', '-m', 'peer work');
  }
  const project = await loaded(h);
  const view = project.state.assignments.get(id);
  if (view === undefined) throw new Error('missing assignment');
  const derived = tool === 'handoff' ? await h.controller.deps.git.deriveCandidate(h.repo, { gitCommonDir: project.store.meta.gitCommonDir, baseCommit: h.base, workspaceId: 'ws-1' }) : undefined;
  const payload = tool === 'ask' ? { question: 'Which?', blockingContext: 'x', evidence: [] } : { completion: options.completion ?? 'complete', verification: [{ command: 'true', outcome: options.outcome ?? 'passed' }] };
  const state = tool === 'ask' ? 'questioned' : (options.completion ?? 'complete') === 'complete' ? 'handed-back' : 'blocked';
  await h.controller.append(project, {
    type: 'report.accepted', payloadVersion: 1, assignmentId: id, actor: { source: 'seat', role: 'peer', agentId: d.peer },
    data: {
      generation: view.reportingGeneration, tool, requestId: `req_${String(view.reportingGeneration)}abcdefg`,
      fingerprint: actionFingerprint(view.reportingGeneration, tool, payload),
      receipt: { schema: 1, receipt: `rcpt_${String(view.reportingGeneration)}`, tool, status: 'accepted', assignmentState: state },
      report: payload, ...(derived?.ok === true ? { candidate: derived.candidate } : {}),
    },
  });
  h.paseo.endTurn(d.peer);
}

async function view(d: Dispatched) {
  const project = await loaded(d.h);
  return { view: project.state.assignments.get(d.id), owner: project.state.ownership.get(d.id), types: project.events.filter(event => event.assignmentId === d.id).map(event => event.type) };
}

describe('Lead turn operations', () => {
  it('answers a question with a new generation and prompt', async () => {
    const d = await dispatched();
    await report(d, 'ask');
    const answered = await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'Use the main branch.' });
    expect(answered).toMatchObject({ ok: true, value: { generation: 2 } });
    const prompts = d.h.paseo.agents.get(d.peer)?.prompts ?? [];
    expect(prompts.map(prompt => prompt.messageId)).toEqual([`${d.id}-g1`, `${d.id}-g2`]);
    expect(prompts[1]?.text).toContain('Use the main branch.');
    expect((await view(d)).view).toMatchObject({ state: 'active', reportingGeneration: 2 });
  });

  it('refuses a turn while the Peer is busy, has drifted, or is gone', async () => {
    const d = await dispatched();
    await report(d, 'ask');
    const agent = d.h.paseo.agents.get(d.peer);
    if (agent === undefined) throw new Error('missing peer');
    agent.activeTurn = true;
    expect(await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'x' })).toMatchObject({ ok: false, code: 'peer_busy', retryable: true });
    agent.activeTurn = false;
    agent.status = 'idle';
    agent.model = 'other-model';
    expect(await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'x' })).toMatchObject({ ok: false, code: 'peer_drift' });
    agent.model = 'model-x';
    agent.archivedAt = '2026-09-22T12:00:00Z';
    expect(await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'x' })).toMatchObject({ ok: false, code: 'peer_gone' });
    expect((await view(d)).view?.state).toBe('questioned');
  });

  it('follows up on a blocked handback and sends a candidate back for rework', async () => {
    const blocked = await dispatched();
    await report(blocked, 'handoff', { completion: 'blocked', commit: false });
    expect((await blocked.h.controller.answer(blocked.h.lead, { assignmentId: blocked.id, answer: 'Try again.' })).ok).toBe(true);

    const d = await dispatched();
    await report(d, 'handoff');
    expect(await d.h.controller.answer(d.h.lead, { assignmentId: d.id, answer: 'x' })).toMatchObject({ ok: false, code: 'assignment_state' });
    expect(await d.h.controller.rework(d.h.lead, { assignmentId: d.id, instructions: 'Add a test.' })).toMatchObject({ ok: true, value: { generation: 2 } });
    expect(d.h.paseo.agents.get(d.peer)?.prompts[1]?.text).toContain('Add a test.');
  });
});

describe('gate, decisions and closure', () => {
  it('runs the independent gate on the candidate and binds a required rerun to acceptance', async () => {
    const d = await dispatched({ gate: { command: 'true', timeoutSeconds: 30, runtimeRerun: 'required', processContractVersion: 1 } });
    await report(d, 'handoff');
    expect(await d.h.controller.accept(d.h.lead, { assignmentId: d.id, reason: 'ok' })).toMatchObject({ ok: false, code: 'rerun_required' });
    const started = await d.h.controller.gateRun(d.h.lead, { assignmentId: d.id });
    if (!started.ok) throw new Error(started.message);
    expect(await d.h.controller.gates.get(started.value.gateRunId)).toMatchObject({ status: 'finished', result: { exitCode: 0, workspaceMoved: false } });
    expect((await view(d)).types).toEqual(expect.arrayContaining(['gate.requested', 'gate.finished']));
    expect(await d.h.controller.accept(d.h.lead, { assignmentId: d.id, reason: 'Meets the outcome.' })).toMatchObject({ ok: true, value: { red: false } });
    expect((await view(d)).view?.decision?.type).toBe('accepted');
  });

  it('refuses acceptance of a moved candidate and requires an override for red evidence', async () => {
    const moved = await dispatched();
    await report(moved, 'handoff');
    await writeFile(join(moved.h.repo, 'late.ts'), 'x');
    await moved.h.git('add', '.');
    await moved.h.git('commit', '-q', '-m', 'late');
    expect(await moved.h.controller.accept(moved.h.lead, { assignmentId: moved.id, reason: 'ok' })).toMatchObject({ ok: false, code: 'candidate_moved' });

    const red = await dispatched();
    await report(red, 'handoff', { outcome: 'failed' });
    expect(await red.h.controller.accept(red.h.lead, { assignmentId: red.id, reason: 'ok' })).toMatchObject({ ok: false, code: 'override_required' });
    expect(await red.h.controller.accept(red.h.lead, { assignmentId: red.id, reason: 'ok', override: { reason: 'Known flake.', residualRiskAcknowledged: true } }))
      .toMatchObject({ ok: true, value: { red: true } });
  });

  it('keeps ownership through a decision and releases it only on a proven archive', async () => {
    for (const decide of ['reject', 'abandon'] as const) {
      const d = await dispatched();
      await report(d, 'handoff');
      expect((await d.h.controller[decide](d.h.lead, { assignmentId: d.id, reason: 'Not needed.' })).ok).toBe(true);
      expect((await view(d)).owner?.state).toBe('held');
      expect(await d.h.controller.close(d.h.lead, { assignmentId: d.id })).toMatchObject({ ok: true, value: { released: true } });
      const after = await view(d);
      expect(after.owner?.state).toBe('released');
      expect(after.view?.closure).toBe('closed');
      expect(d.h.paseo.agents.get(d.peer)?.status).toBe('closed');
      // Lead's own agent is never archived.
      expect(d.h.paseo.agents.get('lead-1')?.status).toBe('idle');
    }
  });

  it('leaves ownership uncertain when the archive is not proven', async () => {
    const d = await dispatched();
    await report(d, 'handoff');
    await d.h.controller.reject(d.h.lead, { assignmentId: d.id, reason: 'no' });
    d.h.paseo.faults.set('archive', { when: 'before' });
    expect(await d.h.controller.close(d.h.lead, { assignmentId: d.id })).toMatchObject({ ok: false, code: 'archive_uncertain' });
    expect((await view(d)).owner?.state).toBe('uncertain');
    // A second writable dispatch stays refused while ownership is uncertain.
    const next = await d.h.controller.createAssignment(d.h.lead, writableBrief(await d.h.git('rev-parse', 'HEAD')));
    if (!next.ok) throw new Error(next.message);
    expect(await d.h.controller.dispatch(d.h.lead, { assignmentId: next.value.assignmentId, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'dispatch_refused' });
  });

  it('refuses a close before a decision and treats an agentless close as a no-op', async () => {
    const d = await dispatched();
    expect(await d.h.controller.close(d.h.lead, { assignmentId: d.id })).toMatchObject({ ok: false, code: 'assignment_state' });
    const draft = await d.h.controller.createAssignment(d.h.lead, writableBrief(d.h.base));
    if (!draft.ok) throw new Error(draft.message);
    await d.h.controller.abandon(d.h.lead, { assignmentId: draft.value.assignmentId, reason: 'Not needed.' });
    expect(await d.h.controller.close(d.h.lead, { assignmentId: draft.value.assignmentId })).toMatchObject({ ok: true, value: { released: false } });
  });
});
