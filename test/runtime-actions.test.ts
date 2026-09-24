import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_SETTINGS } from '../src/runtime-plugin/shared/attention.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { createLeadHandlers, createSupervisorHandlers } from '../src/runtime-plugin/server/handlers/actions.js';
import { CORRELATION_ENV, handleSessionOpen, transformAgentCreate } from '../src/runtime-plugin/server/hooks.js';
import type { HandlerReply } from '../src/runtime-plugin/server/spool.js';
import { harness, writableBrief, type Harness } from './runtime-harness.js';
import { PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';

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

function attentionFor(h: Harness, now: () => Date = () => new Date()): AttentionEngine {
  return new AttentionEngine({
    paseo: h.paseo, recognition: h.hooks.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot,
    now, settings: () => DEFAULT_ATTENTION_SETTINGS, log: () => undefined,
  });
}

async function room() {
  const h = await harness();
  open.push(h);
  h.paseo.addAgent({ id: 'sup-1', provider: 'codex-supervisor', cwd: h.repo });
  const leadCorrelation = await bind(h, 'lead-1', 'codex-lead');
  const supervisorCorrelation = await bind(h, 'sup-1', 'codex-supervisor');
  const attention = attentionFor(h);
  return { h, attention, lead: createLeadHandlers(h.controller), supervisor: createSupervisorHandlers(h.controller, attention), leadCorrelation, supervisorCorrelation };
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

  it('lets only the assignment\'s own Lead close a worktree or reclaim a lease', async () => {
    const { h, lead, leadCorrelation, supervisorCorrelation } = await room();
    const created = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    const assignmentId = created.ok ? created.value.assignmentId : '';
    h.paseo.addAgent({ id: 'lead-2', provider: 'claude-lead', cwd: h.repo });
    const otherCorrelation = await bind(h, 'lead-2', 'claude-lead');
    for (const [name, payload] of [['workspace_close', { assignmentId }], ['lease_reclaim', { assignmentId, reason: 'Peer died' }]] as const) {
      const other = body(await lead[name]?.(request(otherCorrelation, name, payload), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} });
      expect(other).toMatchObject({ error: { code: 'unauthorized' } });
      const supervisor = body(await lead[name]?.(request(supervisorCorrelation, name, payload), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} });
      expect(supervisor).toMatchObject({ error: { code: 'unauthorized' } });
      const own = body(await lead[name]?.(request(leadCorrelation, name, payload), { kind: 'action', role: 'lead' }) ?? { ok: false, result: {} });
      expect((own.error as { code?: string } | undefined)?.code).not.toBe('unauthorized');
    }
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
    expect(Object.keys(supervisor).sort()).toEqual(['attention_feedback', 'message_lead', 'room_status', 'runtime_findings']);
  });
});

describe('Supervisor portfolio (attention delta §9.4)', () => {
  async function portfolioRoom() {
    const h = await harness();
    open.push(h);
    const desk = join(h.root, 'desk');
    const other = join(h.root, 'billing');
    await mkdir(desk);
    await mkdir(other);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: other });
    git('init', '-q', '-b', 'main');
    await writeFile(join(other, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // One Supervisor in a neutral directory; Leads in two repositories, both its children.
    h.paseo.addAgent({ id: 'sup-p', provider: 'claude-supervisor', cwd: desk });
    const lead = h.paseo.agents.get('lead-1');
    if (lead !== undefined) lead.labels = { [PARENT_AGENT_ID_LABEL]: 'sup-p' };
    h.paseo.addAgent({ id: 'lead-b', provider: 'claude-lead', cwd: other, labels: { [PARENT_AGENT_ID_LABEL]: 'sup-p' } });
    h.paseo.addAgent({ id: 'sup-q', provider: 'codex-supervisor', cwd: desk });
    let clock = new Date('2026-09-24T08:00:00.000Z');
    const attention = attentionFor(h, () => clock);
    const correlation = await bind(h, 'sup-p', 'claude-supervisor');
    const stranger = await bind(h, 'sup-q', 'codex-supervisor');
    return { h, attention, supervisor: createSupervisorHandlers(h.controller, attention), correlation, stranger, advance: (ms: number) => { clock = new Date(clock.getTime() + ms); } };
  }
  const call = async (handlers: ReturnType<typeof createSupervisorHandlers>, correlation: string, name: string, payload: unknown) =>
    body(await handlers[name]?.(request(correlation, name, payload), { kind: 'action', role: 'supervisor' }) ?? { ok: false, result: {} });

  it('routes message_lead by project name across a two-project portfolio', async () => {
    const { h, supervisor, correlation } = await portfolioRoom();
    expect(await call(supervisor, correlation, 'message_lead', { message: 'x' })).toMatchObject({ error: { code: 'project_required', message: expect.stringContaining('billing') as unknown } });
    expect(await call(supervisor, correlation, 'message_lead', { message: 'Status of billing?', project: 'billing' })).toMatchObject({ noticeId: expect.any(String) as unknown });
    expect(h.paseo.agents.get('lead-b')?.prompts.at(-1)?.text).toContain('Supervisor: Status of billing?');
    expect(await call(supervisor, correlation, 'message_lead', { message: 'Status of repo?', project: 'REPO' })).toMatchObject({ noticeId: expect.any(String) as unknown });
    expect(h.paseo.agents.get('lead-1')?.prompts.at(-1)?.text).toContain('Supervisor: Status of repo?');
    expect(await call(supervisor, correlation, 'message_lead', { message: 'x', project: 'payroll' })).toMatchObject({ error: { code: 'project_unknown' } });
  });

  it('keeps another Supervisor out of the portfolio, and shows the portfolio in room_status', async () => {
    const { supervisor, correlation, stranger } = await portfolioRoom();
    expect(await call(supervisor, stranger, 'message_lead', { message: 'x', project: 'billing' })).toMatchObject({ error: { code: 'project_unknown' } });
    const status = await call(supervisor, correlation, 'room_status', {});
    expect((status.observed as { name: string }[]).map(project => project.name).sort()).toEqual(['billing', 'repo']);
    const theirs = await call(supervisor, stranger, 'room_status', {});
    expect(theirs.observed).toEqual([]);
  });

  it('keeps room_status and findings to the portfolio, and counts settled assignments instead of listing them', async () => {
    const { h, supervisor, correlation, stranger } = await portfolioRoom();
    const kept = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    const settled = await h.controller.createAssignment(h.lead, writableBrief(h.base));
    await h.controller.abandon(h.lead, { assignmentId: settled.ok ? settled.value.assignmentId : '', reason: 'Superseded.' });
    const status = await call(supervisor, correlation, 'room_status', {});
    expect(status.projects).toMatchObject([{ assignments: [{ id: kept.ok ? kept.value.assignmentId : '' }], terminalAssignments: 1 }]);
    // Another Supervisor sees no runtime project it does not supervise or stand in.
    const theirs = await call(supervisor, stranger, 'room_status', {});
    expect(theirs.projects).toEqual([]);
    expect(await call(supervisor, stranger, 'runtime_findings', {})).toMatchObject({ findings: [], incidents: [] });
  });

  it('rates only the caller\'s own attention items', async () => {
    const { h, attention, supervisor, correlation, stranger, advance } = await portfolioRoom();
    await attention.run(() => attention.sweep());
    h.paseo.agents.get('lead-b')?.pendingPermissions.push({ id: 'perm-1', name: 'Bash' });
    await attention.onPermissionRequested('lead-b', 'perm-1');
    advance(6 * 60_000);
    await attention.run(() => attention.sweep());
    const found = await call(supervisor, correlation, 'runtime_findings', {});
    const [incident] = found.incidents as { id: string; kind: string }[];
    expect(incident?.kind).toBe('permission-waiting');
    expect(await call(supervisor, stranger, 'attention_feedback', { id: incident?.id, verdict: 'noise' })).toMatchObject({ error: { code: 'unauthorized' } });
    expect(await call(supervisor, correlation, 'attention_feedback', { id: incident?.id, verdict: 'useful' })).toMatchObject({ recorded: true });
    expect(await call(supervisor, correlation, 'attention_feedback', { id: 'att_unknownitem1', verdict: 'useful' })).toMatchObject({ error: { code: 'attention_unknown' } });
  });
});
