/** Regression tests for the Phase 1 code review findings. */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { quiescence } from '../src/runtime-plugin/server/domain/views.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { dispatchAndHandBack, harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function room(options?: Parameters<typeof harness>[0]): Promise<Harness> {
  const h = await harness(options);
  open.push(h);
  return h;
}

async function loaded(h: Harness) {
  const result = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const gateBrief = (base: string) => writableBrief(base, { gate: { command: 'sleep 1', timeoutSeconds: 30, runtimeRerun: 'optional', processContractVersion: 1 } });

const handedBack = (h: Harness) => dispatchAndHandBack(h, gateBrief(h.base));

describe('gate_run review fixes', () => {
  it('refuses a second gate while the first runs, and never leaves an unhandled failure', async () => {
    const h = await room();
    const { id } = await handedBack(h);
    const [first, second] = await Promise.all([h.controller.gateRun(h.lead, { assignmentId: id }), h.controller.gateRun(h.lead, { assignmentId: id })]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first, second].find(result => !result.ok)).toMatchObject({ code: 'gate_running' });
    const started = [first, second].find(result => result.ok);
    if (started?.ok !== true) throw new Error('no gate started');
    expect(await h.controller.gates.get(started.value.gateRunId)).toMatchObject({ status: 'finished' });
    expect((await loaded(h)).events.filter(event => event.type === 'gate.requested')).toHaveLength(1);
  });

  it('refuses a gate on a moved workspace to Lead instead of reporting success', async () => {
    const h = await room();
    const { id } = await handedBack(h);
    await writeFile(join(h.repo, 'late.ts'), 'x');
    expect(await h.controller.gateRun(h.lead, { assignmentId: id })).toMatchObject({ ok: false, code: 'workspace_moved' });
    expect((await loaded(h)).events.some(event => event.type === 'gate.requested')).toBe(false);
  });

  it('records a gate runner failure as uncertain', async () => {
    const h = await room();
    const { id } = await handedBack(h);
    // The runner cannot write its evidence: the gates directory has become a file.
    const project = await loaded(h);
    await rm(project.store.gatesDirectory, { recursive: true, force: true });
    await writeFile(project.store.gatesDirectory, 'not a directory');
    const started = await h.controller.gateRun(h.lead, { assignmentId: id });
    if (!started.ok) throw new Error(started.message);
    expect(await h.controller.gates.get(started.value.gateRunId)).toMatchObject({ status: 'uncertain' });
    expect((await loaded(h)).state.assignments.get(id)?.gates.map(gate => gate.status)).toEqual(['uncertain']);
  });

  it('lets an uncertain gate settle from a late sidecar and stops it blocking once the Peer is archived', async () => {
    const h = await room();
    const { id } = await handedBack(h);
    const project = await loaded(h);
    const view = project.state.assignments.get(id);
    if (view?.candidate === undefined) throw new Error('missing candidate');
    await h.controller.append(project, { type: 'gate.requested', payloadVersion: 1, assignmentId: id, actor: { source: 'plugin' }, data: { gateRunId: 'gate-late', candidate: view.candidate, command: 'sleep 1', timeoutSeconds: 30, processContractVersion: 1, environmentPolicyVersion: 1 } });
    await h.controller.append(project, { type: 'gate.uncertain', payloadVersion: 1, assignmentId: id, actor: { source: 'plugin' }, data: { gateRunId: 'gate-late', reason: 'restart' } });
    await h.controller.accept(h.lead, { assignmentId: id, reason: 'ok' });
    await h.controller.close(h.lead, { assignmentId: id });
    expect(quiescence((await loaded(h)).state)).toEqual({ quiescent: true, blockers: [] });

    await writeFile(join(project.store.gatesDirectory, 'gate-late.result.json'), JSON.stringify({
      id: 'gate-late', assignmentId: id, candidate: view.candidate, command: 'sleep 1', startedAt: '2026-09-22T10:00:00Z',
      exitCode: 0, timedOut: false, termination: 'exited', processContractVersion: 1, environmentPolicyVersion: 1, outputDigest: `sha256:${'0'.repeat(64)}`, workspaceMoved: false,
    }));
    await new Recovery(h.controller).recoverAll();
    expect((await loaded(h)).state.assignments.get(id)?.gates.map(gate => gate.status)).toEqual(['finished']);
  });
});

describe('dispatch review fixes', () => {
  it('archives rather than strands a Peer whose read-back fails, and frees the project for the next writer', async () => {
    const h = await room();
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    if (!created.ok) throw new Error(created.message);
    h.paseo.faults.set('getAgent', { when: 'before' });
    expect(await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'binding_refused' });
    const state = (await loaded(h)).state;
    expect(state.assignments.get(created.value.assignmentId)).toMatchObject({ state: 'uncertain', closure: 'closed' });
    expect(state.ownership.get(created.value.assignmentId)?.state).toBe('released');
    const next = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    if (!next.ok) throw new Error(next.message);
    expect((await h.controller.dispatch(h.lead, { assignmentId: next.value.assignmentId, peerProvider: 'codex-peer' })).ok).toBe(true);
  });

  it('waits for a Peer that is still initializing instead of archiving it', async () => {
    const h = await room({ associationWaitMs: 1_000 });
    const hook = h.paseo.onCreate;
    h.paseo.onCreate = async (input, agentId) => {
      const agent = h.paseo.agents.get(agentId);
      if (agent) {
        agent.status = 'initializing';
        setTimeout(() => { agent.status = 'idle'; }, 150);
      }
      await hook?.(input, agentId);
    };
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    if (!created.ok) throw new Error(created.message);
    expect((await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'codex-peer' })).ok).toBe(true);
  });
});

describe('notice review fix', () => {
  it('keeps a notice to retry when reading the recipient fails', async () => {
    const h = await room();
    h.paseo.faults.set('getAgent', { when: 'before' });
    const noticeId = await h.controller.notices.notify(await loaded(h), { kind: 'handback', class: 'owner', disposition: 'lead-now', text: 'Peer handed back.', recipient: { agentId: 'lead-1', role: 'lead' } });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('uncertain');
    await new Recovery(h.controller).recoverAll();
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
    expect(h.paseo.agents.get('lead-1')?.prompts.filter(prompt => prompt.messageId === noticeId)).toHaveLength(1);
  });
});
