import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { PaseoHandle, PaseoUnavailableError, sdkPaseoPort, type PaseoApi } from '../src/runtime-plugin/server/paseo-port.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function pluginDir(manifest = renderRuntimeManifestFile(['codex', 'claude'], ROLES)): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'paseo-room-recognition-'));
  roots.push(dir);
  await mkdir(join(dir, 'generated'));
  await writeFile(join(dir, 'generated', 'room-manifest.json'), manifest);
  return dir;
}

describe('exact room-provider recognition', () => {
  it('recognizes only exact manifest provider ids and never internal agents', async () => {
    const recognition = new Recognition(await pluginDir());
    expect((await recognition.load()).status).toBe('ready');
    expect(recognition.recognize('codex-lead')).toMatchObject({ providerId: 'codex-lead', role: 'lead', agent: 'codex' });
    expect(recognition.recognize('claude-peer')?.peerReporting).toBeDefined();
    for (const lookalike of ['codex', 'codex-lead-2', 'Codex-Lead', 'pi-lead', 'codex-le', 'constructor', '__proto__', 'toString']) {
      expect(recognition.recognize(lookalike), lookalike).toBeUndefined();
    }
    expect(recognition.recognize('codex-lead', true)).toBeUndefined();
    expect([...recognition.peerProviders()].sort()).toEqual(['claude-peer', 'codex-peer']);
  });

  it('pauses on a missing or invalid manifest and on drift under a running plugin', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'paseo-room-recognition-'));
    roots.push(empty);
    const missing = new Recognition(empty);
    expect((await missing.load()).status).toBe('paused');
    expect(missing.recognize('codex-lead')).toBeUndefined();

    const broad = JSON.parse(renderRuntimeManifestFile(['codex'], ROLES)) as { providers: Record<string, { capabilities: string[] }> };
    broad.providers['codex-peer']?.capabilities.push('assignment_accept');
    expect((await new Recognition(await pluginDir(JSON.stringify(broad))).load()).status).toBe('paused');

    const dir = await pluginDir();
    const recognition = new Recognition(dir);
    await recognition.load();
    expect((await recognition.checkDrift()).status).toBe('ready');
    await writeFile(join(dir, 'generated', 'room-manifest.json'), renderRuntimeManifestFile(['codex'], ROLES));
    const drifted = await recognition.checkDrift();
    expect(drifted).toMatchObject({ status: 'paused', reason: expect.stringContaining('reload') as unknown });
    expect(recognition.recognize('codex-lead')).toBeUndefined();
  });
});

describe('Paseo handle and SDK port', () => {
  it('waits boundedly for a handle and never falls back', async () => {
    const handle = new PaseoHandle();
    await expect(handle.acquire(20)).rejects.toBeInstanceOf(PaseoUnavailableError);
    const api = {} as PaseoApi;
    const waiting = handle.acquire(1_000);
    handle.supply(api);
    await expect(waiting).resolves.toBe(api);
    handle.clear();
    expect(handle.available).toBe(false);
  });

  it('creates agents without a prompt and passes parent and labels through', async () => {
    const created: unknown[] = [];
    const sent: unknown[] = [];
    const snapshot = {
      id: 'a1', provider: 'codex-peer', model: 'm', cwd: '/r', workspaceId: 'w', status: 'idle', activeTurn: null,
      lastUserMessageAt: null, labels: { 'paseo.parent-agent-id': 'lead' }, archivedAt: null, pendingPermissions: [{ id: 'p', name: 'mcp__x__ask', kind: 'tool' }],
    };
    const api = {
      agents: {
        create: (options: unknown) => { created.push(options); return Promise.resolve({ id: 'a1' }); },
        ref: () => ({
          refresh: () => Promise.resolve(null), current: () => snapshot,
          send: (text: string, options: unknown) => { sent.push([text, options]); return Promise.resolve(); },
          archive: () => Promise.resolve({ archivedAt: 'now' }),
        }),
        list: () => Promise.resolve({ entries: [{ agent: { id: 'a1' } }] }),
      },
    } as unknown as PaseoApi;
    const handle = new PaseoHandle();
    handle.supply(api);
    const port = sdkPaseoPort(handle, 50);
    await port.createAgent({ provider: 'codex-peer', model: 'gpt-5.6-sol', cwd: '/r', parentAgentId: 'lead', title: 'Peer', labels: { 'paseo-room.assignment': 'asg_1' } });
    expect(created).toEqual([{ config: { provider: 'codex-peer/gpt-5.6-sol' }, cwd: '/r', parent: 'lead', title: 'Peer', labels: { 'paseo-room.assignment': 'asg_1' } }]);
    expect(created[0]).not.toHaveProperty('prompt');
    expect(await port.getAgent('a1')).toMatchObject({ activeTurn: false, pendingPermissions: [{ id: 'p', name: 'mcp__x__ask' }] });
    await port.run('a1', 'brief', 'msg-1');
    expect(sent).toEqual([['brief', { messageId: 'msg-1' }]]);
    expect(await port.archive('a1')).toEqual({ archivedAt: 'now' });
    expect(await port.listAgents()).toHaveLength(1);
  });

  it('resolves the Peer launch from the room profile, else the provider default model, and never guesses', async () => {
    const created: unknown[] = [];
    const make = (profiles: unknown[], models: unknown[]) => {
      const handle = new PaseoHandle();
      handle.supply({
        config: { get: () => Promise.resolve({ config: { agentProfiles: profiles } }) },
        providers: { listModels: () => Promise.resolve({ models }) },
        agents: { create: (options: unknown) => { created.push(options); return Promise.resolve({ id: 'a1' }); } },
      } as unknown as PaseoApi);
      return sdkPaseoPort(handle, 50);
    };
    const defaults = [{ id: 'a' }, { id: 'b', isDefault: true }];

    // Mode and thinking option ride with the model: a Peer nobody is sitting beside must launch
    // in the mode the operator chose for that seat, not the provider's interactive default.
    const claude = [{ id: 'room-claude-peer', provider: 'claude-peer', model: 'sonnet', modeId: 'bypassPermissions', thinkingOptionId: 'high' }];
    expect(await make(claude, defaults).resolveLaunch('claude-peer'))
      .toEqual({ model: 'sonnet', modeId: 'bypassPermissions', thinkingOptionId: 'high' });

    // A profile without a model still contributes its mode, over the provider's default model.
    expect(await make([{ id: 'room-codex-peer', provider: 'codex-peer', modeId: 'full-access' }], defaults).resolveLaunch('codex-peer'))
      .toEqual({ model: 'b', modeId: 'full-access' });
    expect(await make([{ id: 'room-codex-peer', provider: 'codex-peer' }], defaults).resolveLaunch('codex-peer')).toEqual({ model: 'b' });
    expect(await make([], [{ id: 'a' }]).resolveLaunch('pi-peer')).toBeUndefined();

    // An empty string is not a choice.
    expect(await make([{ id: 'room-pi-peer', provider: 'pi-peer', model: 'm', modeId: '' }], defaults).resolveLaunch('pi-peer')).toEqual({ model: 'm' });

    const port = make(claude, defaults);
    const launch = await port.resolveLaunch('claude-peer');
    if (launch === undefined) throw new Error('fixture needs a launch');
    await port.createAgent({ ...launch, provider: 'claude-peer', cwd: '/repo', parentAgentId: 'lead', title: 't', labels: {} });
    expect(created.at(-1)).toMatchObject({
      config: { provider: 'claude-peer/sonnet', modeId: 'bypassPermissions', thinkingOptionId: 'high' },
    });
  });

  it('keeps every agent SDK call inside the Paseo port module', async () => {
    const server = join(import.meta.dirname, '..', 'src', 'runtime-plugin', 'server');
    const offenders: string[] = [];
    for (const entry of await readdir(server, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:ts|mjs)$/.test(entry.name) || entry.name === 'paseo-port.ts') continue;
      const source = await readFile(join(entry.parentPath, entry.name), 'utf8');
      if (/\.agents\.(?:create|ref|list)\(|\bworkspaces\.(?:create|archive|open)\(/.test(source)) offenders.push(entry.name);
    }
    expect(offenders).toEqual([]);
  });
});
