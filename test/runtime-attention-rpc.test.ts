import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_ATTENTION_SETTINGS } from '../src/runtime-plugin/shared/attention.js';
import { AttentionEngine } from '../src/runtime-plugin/server/attention/engine.js';
import { PaseoHandle } from '../src/runtime-plugin/server/paseo-port.js';
import { Recovery } from '../src/runtime-plugin/server/recovery.js';
import { createRpcHandlers } from '../src/runtime-plugin/server/rpc.js';
import { harness, type Harness } from './runtime-harness.js';
import { PARENT_AGENT_ID_LABEL } from './runtime-fake-paseo.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(entry => entry.cleanup())); });

let keys = 0;
const key = (): string => `key_${String(++keys).padStart(8, '0')}`;

async function room() {
  const h = await harness();
  open.push(h);
  const desk = join(h.root, 'desk');
  await mkdir(desk);
  h.paseo.addAgent({ id: 'sup-1', provider: 'claude-supervisor', cwd: desk, title: 'Room Supervisor' });
  const attention = new AttentionEngine({
    paseo: h.paseo, recognition: h.hooks.recognition, git: h.controller.deps.git, runtimeRoot: h.runtimeRoot,
    now: () => new Date(), settings: () => DEFAULT_ATTENTION_SETTINGS, log: () => undefined,
  });
  const rpc = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle(), attention });
  return { h, desk, attention, rpc };
}

async function repository(h: Harness, name: string, options: { readonly commit?: boolean; readonly protocol?: boolean } = {}): Promise<string> {
  const path = join(h.root, name);
  await mkdir(path);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: path });
  git('init', '-q', '-b', 'main');
  if (options.protocol === true) await writeFile(join(path, 'WORKSPACE_PROTOCOL.md'), '# Protocol\n');
  if (options.commit !== false) {
    await writeFile(join(path, 'README.md'), 'x\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
  }
  return path;
}

const data = (answer: unknown): Record<string, unknown> => (answer as { data: Record<string, unknown> }).data;
const failure = (answer: unknown): { code: string } | undefined => (answer as { error?: { code: string } }).error;

describe('room RPCs (attention delta §8)', () => {
  it('shows the observed room with the room providers by role', async () => {
    const { rpc } = await room();
    const view = data(await rpc.room());
    expect((view.supervisors as { agentId: string }[]).map(seat => seat.agentId)).toEqual(['sup-1']);
    expect((view.projects as { name: string }[]).map(project => project.name)).toEqual(['repo']);
    expect((view.providers as { providerId: string; role: string }[]).filter(provider => provider.role === 'supervisor').map(provider => provider.providerId).sort())
      .toEqual(['claude-supervisor', 'codex-supervisor']);
  });

  it('starts a Supervisor only in an existing directory outside Git, once per key', async () => {
    const { h, desk, rpc } = await room();
    expect(failure(await rpc.startSupervisor({ provider: 'claude-lead', cwd: desk, idempotencyKey: key() }))?.code).toBe('provider_invalid');
    expect(failure(await rpc.startSupervisor({ provider: 'claude-supervisor', cwd: join(h.root, 'missing'), idempotencyKey: key() }))?.code).toBe('path_invalid');
    expect(failure(await rpc.startSupervisor({ provider: 'claude-supervisor', cwd: h.repo, idempotencyKey: key() }))?.code).toBe('path_in_repository');
    expect(h.paseo.calls.filter(call => call.operation === 'createAgent')).toHaveLength(0);

    const once = key();
    const first = data(await rpc.startSupervisor({ provider: 'claude-supervisor', cwd: desk, title: 'Portfolio Supervisor', idempotencyKey: once }));
    const again = data(await rpc.startSupervisor({ provider: 'claude-supervisor', cwd: desk, title: 'Portfolio Supervisor', idempotencyKey: once }));
    expect(again.agentId).toBe(first.agentId);
    const creates = h.paseo.calls.filter(call => call.operation === 'createAgent');
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args[0]).toMatchObject({ provider: 'claude-supervisor', cwd: desk, title: 'Portfolio Supervisor' });
    expect((creates[0]?.args[0] as { parentAgentId?: string }).parentAgentId).toBeUndefined();
    expect(h.paseo.agents.get(String(first.agentId))?.prompts).toEqual([]);
  });

  it('reports what a project start would find', async () => {
    const { h, rpc } = await room();
    expect(data(await rpc.projectPreflight({ path: h.repo }))).toMatchObject({ name: 'repo', git: true, hasCommit: true, protocol: false, existingLead: { agentId: 'lead-1' } });
    const fresh = await repository(h, 'cmdb', { commit: false });
    expect(data(await rpc.projectPreflight({ path: fresh }))).toMatchObject({ git: true, hasCommit: false, findings: ['the repository has no commit yet: runtime assignments need one'] });
    const plain = join(h.root, 'notes');
    await mkdir(plain);
    expect(data(await rpc.projectPreflight({ path: plain }))).toMatchObject({ git: false, findings: ['not a Git repository: runtime assignments are unavailable here'] });
    expect(failure(await rpc.projectPreflight({ path: 'relative/path' }))?.code).toBe('path_invalid');
  });

  it('starts a project Lead under the chosen Supervisor with the fixed kickoff, and records the portfolio', async () => {
    const { h, rpc, attention } = await room();
    expect(failure(await rpc.startProject({ path: h.repo, supervisorAgentId: 'sup-1', provider: 'claude-lead', idempotencyKey: key() }))?.code).toBe('lead_exists');
    const shop = await repository(h, 'shop', { protocol: true });
    expect(failure(await rpc.startProject({ path: shop, supervisorAgentId: 'lead-1', provider: 'claude-lead', idempotencyKey: key() }))?.code).toBe('supervisor_invalid');
    expect(failure(await rpc.startProject({ path: shop, supervisorAgentId: 'sup-1', provider: 'claude-peer', idempotencyKey: key() }))?.code).toBe('provider_invalid');

    const started = data(await rpc.startProject({ path: shop, supervisorAgentId: 'sup-1', provider: 'claude-lead', directive: 'Review the checkout flow and propose a plan.', idempotencyKey: key() }));
    const lead = h.paseo.agents.get(String(started.agentId));
    expect(lead?.labels[PARENT_AGENT_ID_LABEL]).toBe('sup-1');
    expect(lead?.title).toBe('shop — Lead');
    expect(lead?.cwd).toBe(shop);
    // Through the project's workspace handle: by cwd alone, Paseo would seat it beside its parent.
    const placed = h.paseo.calls.filter(call => call.operation === 'createAgentInWorkspace');
    expect(placed).toHaveLength(1);
    expect(h.paseo.calls.filter(call => call.operation === 'createAgent' && (call.args[0] as { provider: string }).provider === 'claude-lead')).toHaveLength(0);
    const kickoff = lead?.prompts[0]?.text ?? '';
    expect(kickoff).toBe(`[paseo-room] You are the Lead of shop (${shop}). Your Supervisor is Room Supervisor (sup-1). Repository protocol: present at WORKSPACE_PROTOCOL.md. Preflight: no findings.\n\nReview the checkout flow and propose a plan.`);
    const project = (data(await rpc.room()).projects as { name: string; decidedBy: string; supervisor?: { agentId: string } }[]).find(entry => entry.name === 'shop');
    expect(project).toMatchObject({ decidedBy: 'human', supervisor: { agentId: 'sup-1' } });
    // The harness Lead of repo has no parent, so shop is the Supervisor's only project.
    expect(attention.portfolioOf('sup-1')).toHaveLength(1);
  });

  it('assigns and clears a project\'s Supervisor, refusing a seat that is not one', async () => {
    const { h, rpc } = await room();
    h.paseo.addAgent({ id: 'sup-2', provider: 'codex-supervisor', cwd: h.root });
    const [project] = data(await rpc.room()).projects as { key: string; decidedBy: string }[];
    const projectKey = project?.key ?? '';
    expect(project?.decidedBy).toBe('none');
    expect(failure(await rpc.assignSupervisor({ projectKey, supervisorAgentId: 'lead-1', idempotencyKey: key() }))?.code).toBe('supervisor_invalid');
    expect(failure(await rpc.assignSupervisor({ projectKey: '/nowhere', supervisorAgentId: 'sup-2', idempotencyKey: key() }))?.code).toBe('project_unknown');
    expect(data(await rpc.assignSupervisor({ projectKey, supervisorAgentId: 'sup-2', idempotencyKey: key() }))).toEqual({ assigned: true });
    expect((data(await rpc.room()).projects as { decidedBy: string; supervisor?: { agentId: string } }[])[0]).toMatchObject({ decidedBy: 'human', supervisor: { agentId: 'sup-2' } });
    expect(data(await rpc.assignSupervisor({ projectKey, supervisorAgentId: null, idempotencyKey: key() }))).toEqual({ assigned: false });
  });

  it('answers unknown feedback ids, and every room call without an engine, with a recoverable error', async () => {
    const { h, rpc } = await room();
    expect(failure(await rpc.incidentFeedback({ id: 'att_unknownitem1', verdict: 'noise', idempotencyKey: key() }))?.code).toBe('attention_unknown');
    const bare = createRpcHandlers({ controller: h.controller, recovery: new Recovery(h.controller), handle: new PaseoHandle() });
    expect(failure(await bare.room())?.code).toBe('attention_unavailable');
  });
});
