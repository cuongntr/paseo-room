import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../src/runtime-plugin/server/controller.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

async function room(): Promise<Harness> {
  const h = await harness();
  open.push(h);
  return h;
}

async function loaded(h: Harness) {
  const result = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

async function draft(h: Harness): Promise<string> {
  const result = await h.controller.createAssignment(h.lead, writableBrief(h.base));
  if (!result.ok) throw new Error(result.message);
  return result.value.assignmentId;
}

describe('notices', () => {
  it('delivers an owner notice to Lead with its stable id in the text', async () => {
    const h = await room();
    const id = await draft(h);
    const project = await loaded(h);
    const noticeId = await h.controller.notices.notify(project, { kind: 'peer-question', class: 'owner', disposition: 'lead-now', assignmentId: id, text: 'Peer asked a question.', recipient: { agentId: 'lead-1', role: 'lead' } });
    const prompt = h.paseo.agents.get('lead-1')?.prompts.at(-1);
    expect(prompt).toEqual({ text: `[paseo-room notice ${noticeId}] Peer asked a question.`, messageId: noticeId, behavior: 'steer' });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
  });

  it('records operator notices as delivered to status without messaging any seat', async () => {
    const h = await room();
    const project = await loaded(h);
    const before = h.paseo.calls.filter(call => call.operation === 'run' || call.operation === 'send').length;
    const noticeId = await h.controller.notices.notify(project, { kind: 'manifest-drift', class: 'operator', disposition: 'operator-now', text: 'Reload the runtime plugin.' });
    expect(h.paseo.calls.filter(call => call.operation === 'run' || call.operation === 'send')).toHaveLength(before);
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
  });

  it('never addresses a Peer', async () => {
    const h = await room();
    h.paseo.addAgent({ id: 'peer-x', provider: 'codex-peer' });
    const noticeId = await h.controller.notices.notify(await loaded(h), { kind: 'k', class: 'owner', disposition: 'lead-now', text: 'x', recipient: { agentId: 'peer-x', role: 'lead' } });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('failed');
    expect(h.paseo.agents.get('peer-x')?.prompts).toEqual([]);
  });

  it('retries an undelivered notice with the same id, and never resends a confirmed one', async () => {
    const h = await room();
    h.paseo.faults.set('send', { when: 'before' });
    const noticeId = await h.controller.notices.notify(await loaded(h), { kind: 'k', class: 'owner', disposition: 'lead-now', text: 'Hello', recipient: { agentId: 'lead-1', role: 'lead' } });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('failed');
    await new Recovery(new Controller({ ...h.controller.deps })).recoverAll();
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
    expect(h.paseo.agents.get('lead-1')?.prompts.filter(prompt => prompt.messageId === noticeId)).toHaveLength(1);

    // Lost response: delivered but unconfirmed. Retry finds it in the timeline and does not resend.
    h.paseo.faults.set('send', { when: 'after' });
    h.paseo.timelineOverride = 'unknown';
    const second = await h.controller.notices.notify(await loaded(h), { kind: 'k', class: 'owner', disposition: 'lead-now', text: 'Again', recipient: { agentId: 'lead-1', role: 'lead' } });
    expect((await loaded(h)).state.notices.get(second)?.state).toBe('uncertain');
    delete h.paseo.timelineOverride;
    await new Recovery(new Controller({ ...h.controller.deps })).recoverAll();
    expect((await loaded(h)).state.notices.get(second)?.state).toBe('sent');
    expect(h.paseo.agents.get('lead-1')?.prompts.filter(prompt => prompt.messageId === second)).toHaveLength(1);
  });
});

describe('notice delivery never interrupts (attention delta §7.4)', () => {
  it('steers into a running recipient instead of cancelling its turn', async () => {
    const h = await room();
    const lead = h.paseo.agents.get('lead-1');
    if (lead === undefined) throw new Error('no lead');
    lead.status = 'running';
    lead.activeTurn = true;
    const noticeId = await h.controller.notices.notify(await loaded(h), { kind: 'k', class: 'owner', disposition: 'lead-now', text: 'While you work', recipient: { agentId: 'lead-1', role: 'lead' } });
    expect(lead.interrupted).toBe(0);
    expect(lead.prompts.at(-1)).toMatchObject({ messageId: noticeId, behavior: 'steer' });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
  });

  it('holds a notice while the recipient has a pending permission, and delivers it after', async () => {
    const h = await room();
    const lead = h.paseo.agents.get('lead-1');
    if (lead === undefined) throw new Error('no lead');
    lead.pendingPermissions = [{ id: 'perm-1', name: 'Bash' }];
    const noticeId = await h.controller.notices.notify(await loaded(h), { kind: 'k', class: 'owner', disposition: 'lead-now', text: 'Held', recipient: { agentId: 'lead-1', role: 'lead' } });
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('pending');
    expect(lead.prompts).toEqual([]);
    expect(lead.clearedPermissions).toEqual([]);

    // Still pending: a retry sends nothing.
    expect(await h.controller.notices.retryFor('lead-1')).toBe(1);
    expect(lead.prompts).toEqual([]);

    lead.pendingPermissions = [];
    await h.controller.notices.retryFor('lead-1');
    expect((await loaded(h)).state.notices.get(noticeId)?.state).toBe('sent');
    expect(lead.prompts.filter(prompt => prompt.messageId === noticeId)).toHaveLength(1);
    expect(lead.clearedPermissions).toEqual([]);
  });
});

describe('duplicate Lead handling', () => {
  it('pauses dispatch, preserves everything and pages the Supervisor', async () => {
    const h = await room();
    const id = await draft(h);
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    h.paseo.addAgent({ id: 'sup-1', provider: 'codex-supervisor', cwd: '/elsewhere' });
    expect(await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' })).toMatchObject({ ok: false, code: 'ownership_conflict' });
    const project = await loaded(h);
    expect(project.state.ownershipConflict?.leadAgentIds).toEqual(['lead-1', 'lead-2']);
    expect(project.state.assignments.get(id)?.state).toBe('draft');
    const page = h.paseo.agents.get('sup-1')?.prompts.at(-1);
    expect(page?.text).toContain('lead-1, lead-2');
    expect(h.paseo.calls.some(call => call.operation === 'createAgent')).toBe(false);
    // The same conflict is paged once, not on every attempt.
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    expect(h.paseo.agents.get('sup-1')?.prompts).toHaveLength(1);
  });

  it('pages the project\'s own Supervisor when the room has several', async () => {
    const h = await room();
    const id = await draft(h);
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    h.paseo.addAgent({ id: 'sup-a', provider: 'codex-supervisor', cwd: '/elsewhere' });
    h.paseo.addAgent({ id: 'sup-b', provider: 'claude-supervisor', cwd: '/elsewhere' });
    h.controller.supervisorFor = () => 'sup-b';
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    expect(h.paseo.agents.get('sup-b')?.prompts.at(-1)?.text).toContain('lead-1, lead-2');
    expect(h.paseo.agents.get('sup-a')?.prompts).toEqual([]);
  });

  it('clears the conflict only when one corroborated owner remains', async () => {
    const h = await room();
    const id = await draft(h);
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' });
    const other = h.paseo.agents.get('lead-2');
    if (other) { other.status = 'closed'; other.archivedAt = '2026-09-22T12:00:00Z'; }
    expect((await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' })).ok).toBe(true);
    const events = (await loaded(h)).events.map(event => event.type);
    expect(events).toContain('project.ownership-resolved');
  });

  it('keeps the conflict when the remaining Lead is not the owner of recorded work', async () => {
    const h = await room();
    await draft(h);
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    await new Recovery(h.controller).recoverAll();
    const lead1 = h.paseo.agents.get('lead-1');
    if (lead1) { lead1.status = 'closed'; lead1.archivedAt = '2026-09-22T12:00:00Z'; }
    await new Recovery(h.controller).recoverAll();
    expect((await loaded(h)).state.ownershipConflict).toBeDefined();
  });
});
