import { afterEach, describe, expect, it } from 'vitest';
import { createLeadHandlers, createSupervisorHandlers } from '../src/runtime-plugin/server/handlers/actions.js';
import { CORRELATION_ENV, handleSessionOpen, transformAgentCreate } from '../src/runtime-plugin/server/hooks.js';
import type { HandlerReply } from '../src/runtime-plugin/server/spool.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

/** Runs the creation and session-open hooks for an existing seat, as Paseo would. */
async function bind(h: Harness, agentId: string, provider: string): Promise<string> {
  const decorated = transformAgentCreate({ config: { provider, cwd: h.repo } }, h.hooks);
  const id = decorated?.env?.[CORRELATION_ENV] ?? '';
  await handleSessionOpen({ agentId, workspaceId: 'ws-1', provider, cwd: h.repo, reason: 'create', purpose: 'interactive', env: { [CORRELATION_ENV]: id } }, h.hooks);
  return id;
}

let counter = 0;
function request(correlation: string, operation: string, payload: unknown) {
  return { protocol: 1 as const, requestId: `req_${String(++counter).padStart(8, '0')}`, operation, payload, correlation };
}

const body = (reply: HandlerReply): Record<string, unknown> => reply.result as Record<string, unknown>;

async function room() {
  const h = await harness();
  open.push(h);
  h.paseo.addAgent({ id: 'sup-1', provider: 'codex-supervisor', cwd: h.repo });
  const leadCorrelation = await bind(h, 'lead-1', 'codex-lead');
  const supervisorCorrelation = await bind(h, 'sup-1', 'codex-supervisor');
  return { h, lead: createLeadHandlers(h.controller), supervisor: createSupervisorHandlers(h.controller), leadCorrelation, supervisorCorrelation };
}

describe('Lead action handlers', () => {
  it('creates, dispatches and reads back its own assignment through the bridge surface', async () => {
    const { h, lead, leadCorrelation } = await room();
    const created = await lead.assignment_create?.(request(leadCorrelation, 'assignment_create', writableBrief(h.base)), { kind: 'action', role: 'lead' });
    expect(created?.ok).toBe(true);
    const assignmentId = body(created ?? { ok: false, result: {} }).assignmentId as string;
    const dispatched = await lead.assignment_dispatch?.(request(leadCorrelation, 'assignment_dispatch', { assignmentId, peerProvider: 'codex-peer' }), { kind: 'action', role: 'lead' });
    expect(dispatched).toMatchObject({ ok: true, result: { schema: 1, generation: 1 } });
    const status = await lead.assignment_status?.(request(leadCorrelation, 'assignment_status', { assignmentId }), { kind: 'action', role: 'lead' });
    expect(body(status ?? { ok: false, result: {} })).toMatchObject({ assignment: { id: assignmentId, state: { value: 'active', evidence: 'enforced' } } });
  });

  it('refuses unknown fields, another seat\'s correlation and a seat that no longer matches', async () => {
    const { h, lead, leadCorrelation, supervisorCorrelation } = await room();
    expect(body(await lead.assignment_create?.(request(leadCorrelation, 'assignment_create', { ...writableBrief(h.base), model: 'x' }), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} }))
      .toMatchObject({ error: { code: 'invalid_input' } });
    expect(body(await lead.assignment_create?.(request(supervisorCorrelation, 'assignment_create', writableBrief(h.base)), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} }))
      .toMatchObject({ error: { code: 'unauthorized' } });
    const agent = h.paseo.agents.get('lead-1');
    if (agent) agent.archivedAt = '2026-09-22T12:00:00Z';
    expect(body(await lead.assignment_status?.(request(leadCorrelation, 'assignment_status', {}), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} }))
      .toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('shows Lead only its own assignments', async () => {
    const { h, lead, leadCorrelation } = await room();
    await h.controller.createAssignment(h.lead, writableBrief(h.base));
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    const otherCorrelation = await bind(h, 'lead-2', 'claude-lead');
    const mine = body(await lead.assignment_status?.(request(leadCorrelation, 'assignment_status', {}), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} });
    const theirs = body(await lead.assignment_status?.(request(otherCorrelation, 'assignment_status', {}), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} });
    expect((mine.assignments as unknown[])).toHaveLength(1);
    expect((theirs.assignments as unknown[])).toHaveLength(0);
  });
});

describe('Supervisor action handlers', () => {
  it('reads status and findings and routes one message to the project\'s Lead', async () => {
    const { h, supervisor, supervisorCorrelation } = await room();
    await h.controller.createAssignment(h.lead, writableBrief(h.base));
    const status = body(await supervisor.room_status?.(request(supervisorCorrelation, 'room_status', {}), { kind: 'action', role: 'supervisor' }) ?? { ok: false, result: {} });
    expect(status).toMatchObject({ schema: 1, projects: [{ health: { value: 'healthy' }, assignments: [{ state: { value: 'draft' } }] }] });
    // Supervisor sees summaries, never the full brief.
    expect(JSON.stringify(status)).not.toContain('No docs change');
    const found = body(await supervisor.runtime_findings?.(request(supervisorCorrelation, 'runtime_findings', {}), { kind: 'action', role: 'supervisor' }) ?? { ok: false, result: {} });
    expect(found).toMatchObject({ findings: [] });
    const sent = await supervisor.message_lead?.(request(supervisorCorrelation, 'message_lead', { message: 'Please check the release branch.' }), { kind: 'action', role: 'supervisor' });
    expect(sent?.ok).toBe(true);
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('Supervisor: Please check the release branch.');
  });

  it('refuses a Lead correlation and an ambiguous Lead', async () => {
    const { h, supervisor, leadCorrelation, supervisorCorrelation } = await room();
    expect(body(await supervisor.room_status?.(request(leadCorrelation, 'room_status', {}), { kind: 'action', role: 'supervisor' }) ?? { ok: false, result: {} }))
      .toMatchObject({ error: { code: 'unauthorized' } });
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    expect(body(await supervisor.message_lead?.(request(supervisorCorrelation, 'message_lead', { message: 'x' }), { kind: 'action', role: 'supervisor' }) ?? { ok: false, result: {} }))
      .toMatchObject({ error: { code: 'lead_ambiguous' } });
    // Supervisor holds no handler that changes an assignment.
    expect(Object.keys(supervisor).sort()).toEqual(['message_lead', 'room_status', 'runtime_findings']);
  });
});
