import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { transformAgentCreate as carrierTransform } from '../src/plugin-assets/index.server.js';
import { renderClaudeCarrierContract } from '../src/plugin.js';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import contribute from '../src/runtime-plugin/index.server.js';
import { CorrelationRegistry } from '../src/runtime-plugin/server/correlations.js';
import {
  BRIDGE_SERVER_NAME, CORRELATION_ENV, handleSessionOpen, transformAgentCreate, type AgentCreateRequest, type HookDependencies,
} from '../src/runtime-plugin/server/hooks.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';
import { renderInstructions } from '../src/room/instructions.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function hooks(manifest = renderRuntimeManifestFile(['codex', 'claude'], ROLES), clock = { now: 1_000 }): Promise<HookDependencies> {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-room-hooks-'));
  roots.push(dir);
  await mkdir(join(dir, 'generated'));
  await writeFile(join(dir, 'generated', 'room-manifest.json'), manifest);
  const recognition = new Recognition(dir);
  await recognition.load();
  return {
    recognition, correlations: new CorrelationRegistry(join(dir, 'runtime', 'correlations'), () => clock.now),
    nodePath: '/usr/bin/node', bridgeScript: join(dir, 'server', 'bridge', 'bridge.mjs'), runtimeRoot: join(dir, 'runtime'),
  };
}

function create(provider: string, extra: Partial<AgentCreateRequest['config']> = {}, env?: Record<string, string>): AgentCreateRequest {
  return { config: { provider, cwd: '/repo', ...extra }, ...(env === undefined ? {} : { env }) };
}

function bridgeOf(request: AgentCreateRequest | undefined): Record<string, unknown> | undefined {
  return request?.config.mcpServers?.[BRIDGE_SERVER_NAME] as Record<string, unknown> | undefined;
}

describe('runtime creation hook', () => {
  it('gives Supervisor and Lead the action bridge and preserves every prior field', async () => {
    const deps = await hooks();
    const request = create('codex-lead', { systemPrompt: 'prior', title: 'Lead', mcpServers: { other: { type: 'stdio', command: 'x' } } }, { KEEP: '1' });
    const result = transformAgentCreate(request, deps);
    expect(result?.config.systemPrompt).toBe('prior');
    expect(result?.config.title).toBe('Lead');
    expect(result?.config.mcpServers?.other).toEqual({ type: 'stdio', command: 'x' });
    expect(bridgeOf(result)).toMatchObject({ type: 'stdio', command: '/usr/bin/node', args: [deps.bridgeScript], env: { PASEO_ROOM_ROLE: 'lead' } });
    expect(result?.env?.KEEP).toBe('1');
    expect(result?.env?.[CORRELATION_ENV]).toMatch(/^cor_[0-9a-f]{32}$/);
    expect(bridgeOf(transformAgentCreate(create('claude-supervisor'), deps))).toMatchObject({ env: { PASEO_ROOM_ROLE: 'supervisor' } });
  });

  it('gives a Peer the reporting bridge only for this runtime\'s own dispatch, once', async () => {
    const deps = await hooks();
    // A Peer Lead created natively is left exactly as it was.
    expect(transformAgentCreate(create('codex-peer', { title: 'Peer' }), deps)).toBeUndefined();

    deps.correlations.expectPeerCreate({ assignmentId: 'asg_abcdefgh', providerId: 'codex-peer', title: 'Peer asg_abcdefgh', workKind: 'engineer' });
    expect(transformAgentCreate(create('codex-peer', { title: 'Peer other' }), deps)).toBeUndefined();
    const peer = transformAgentCreate(create('codex-peer', { title: 'Peer asg_abcdefgh' }), deps);
    expect(bridgeOf(peer)).toMatchObject({ env: { PASEO_ROOM_ROLE: 'peer', PASEO_ROOM_WORK_KIND: 'engineer' } });
    expect(Object.keys(peer?.config.mcpServers ?? {})).toEqual([BRIDGE_SERVER_NAME]);
    // One use: the same create cannot be decorated twice.
    expect(transformAgentCreate(create('codex-peer', { title: 'Peer asg_abcdefgh' }), deps)).toBeUndefined();
  });

  it('never decorates a Peer without the reporting declaration, a foreign provider or an internal agent', async () => {
    const manifest = JSON.parse(renderRuntimeManifestFile(['codex'], ROLES)) as { providers: Record<string, Record<string, unknown>> };
    manifest.providers['codex-peer'] = { agent: 'codex', role: 'peer', capabilities: [] };
    const deps = await hooks(JSON.stringify(manifest));
    deps.correlations.expectPeerCreate({ assignmentId: 'asg_abcdefgh', providerId: 'codex-peer', title: 'T', workKind: 'engineer' });
    expect(transformAgentCreate(create('codex-peer', { title: 'T' }), deps)).toBeUndefined();

    const full = await hooks();
    expect(transformAgentCreate(create('codex'), full)).toBeUndefined();
    expect(transformAgentCreate(create('my-codex-lead'), full)).toBeUndefined();
    expect(transformAgentCreate(create('codex-lead', { internal: true }), full)).toBeUndefined();
    const composed = create('codex-lead', { mcpServers: { [BRIDGE_SERVER_NAME]: { type: 'stdio', command: 'foreign' } } });
    expect(transformAgentCreate(composed, full)).toBeUndefined();
  });

  it('composes with the Claude carrier in either order', async () => {
    const deps = await hooks();
    const contract = renderInstructions('lead');
    const contracts = { 'claude-lead': contract };
    const carrier = (request: AgentCreateRequest): AgentCreateRequest =>
      (carrierTransform(request, contracts, 'gen-1') as unknown as AgentCreateRequest | undefined) ?? request;
    const runtime = (request: AgentCreateRequest): AgentCreateRequest => transformAgentCreate(request, deps) ?? request;
    expect(renderClaudeCarrierContract(['lead'])).toContain('claude-lead');

    for (const [name, order] of [['carrier first', [carrier, runtime]], ['runtime first', [runtime, carrier]]] as const) {
      const result = order.reduce((request, step) => step(request), create('claude-lead', { systemPrompt: 'operator prompt' }));
      expect(result.config.systemPrompt, name).toContain('operator prompt');
      expect(result.config.systemPrompt, name).toContain(contract);
      expect(bridgeOf(result), name).toBeDefined();
      expect(result.env?.[CORRELATION_ENV], name).toBeDefined();
    }
  });
});

describe('session-open association', () => {
  it('associates once, durably, and marks a second agent ambiguous', async () => {
    const clock = { now: 1_000 };
    const deps = await hooks(undefined, clock);
    const created = transformAgentCreate(create('codex-lead'), deps);
    const id = created?.env?.[CORRELATION_ENV] ?? '';
    const open = (agentId: string, provider = 'codex-lead') => handleSessionOpen({
      agentId, workspaceId: 'ws1', provider, cwd: '/repo', reason: 'create', purpose: 'interactive', env: { [CORRELATION_ENV]: id },
    }, deps);
    expect(await open('lead-1')).toBe('associated');
    expect(await open('lead-1')).toBe('already-associated');
    expect(await open('lead-2')).toBe('ambiguous');
    const stored = JSON.parse(await readFile(join(deps.runtimeRoot, 'correlations', `${id}.json`), 'utf8')) as Record<string, unknown>;
    expect(stored).toMatchObject({ correlationId: id, agentId: 'lead-1', role: 'lead', providerId: 'codex-lead', workspaceId: 'ws1' });

    // A fresh registry after a restart still knows the association.
    const restarted = new CorrelationRegistry(join(deps.runtimeRoot, 'correlations'));
    expect((await restarted.lookup(id))?.agentId).toBe('lead-1');
  });

  it('refuses unknown, expired, mismatched and non-runtime sessions', async () => {
    const clock = { now: 1_000 };
    const deps = await hooks(undefined, clock);
    const base = { workspaceId: 'ws1', cwd: '/repo', reason: 'create' as const, purpose: 'interactive' as const };
    expect(await handleSessionOpen({ ...base, agentId: 'a', provider: 'codex-lead', env: {} }, deps)).toBe('not-runtime');
    expect(await handleSessionOpen({ ...base, agentId: 'a', provider: 'codex-lead', env: { [CORRELATION_ENV]: 'cor_0000' } }, deps)).toBe('unknown');

    const mismatch = transformAgentCreate(create('codex-lead'), deps)?.env?.[CORRELATION_ENV] ?? '';
    expect(await handleSessionOpen({ ...base, agentId: 'a', provider: 'claude-lead', env: { [CORRELATION_ENV]: mismatch } }, deps)).toBe('provider-mismatch');

    const stale = transformAgentCreate(create('codex-lead'), deps)?.env?.[CORRELATION_ENV] ?? '';
    clock.now += 11 * 60_000;
    expect(await handleSessionOpen({ ...base, agentId: 'a', provider: 'codex-lead', env: { [CORRELATION_ENV]: stale } }, deps)).toBe('expired');
    expect(deps.correlations.expire()).toContain(mismatch);
  });
});

describe('server entry', () => {
  it('stays inactive when built from the unconfigured source tree', () => {
    const registered: string[] = [];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const cleanup = contribute({ before: (name: string) => { registered.push(name); return () => undefined; } } as never);
      expect(typeof cleanup).toBe('function');
    } finally {
      console.error = original;
    }
    expect(registered).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});
