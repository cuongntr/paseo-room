import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { remove, setup, verify } from '../src/commands.js';
import { CLAUDE_CARRIER_PLUGIN_ID, renderClaudeCarrierContract } from '../src/plugin.js';
import { contractDigest, renderInstructions } from '../src/room/instructions.js';
import { transformAgentCreate } from '../src/plugin-assets/index.server.js';
import { composeSystemPrompt, contractMarker } from '../src/plugin-assets/server/carrier.js';
import { emptyDaemon, fakeClient, makeFixture } from './helpers.js';

describe('Claude contract carrier composition', () => {
  it('appends without replacing and rewrites one marked block idempotently', () => {
    const first = composeSystemPrompt('caller prompt', 'role contract', 'g1');
    expect(first).toBe(`caller prompt\n\n${contractMarker('g1')}\nrole contract`);
    expect(composeSystemPrompt(first, 'role contract', 'g1')).toBe(first);
    expect(composeSystemPrompt(first, 'new contract', 'g2')).toBe(
      `caller prompt\n\n${contractMarker('g2')}\nnew contract`,
    );
  });

  it('generates exact per-role documents from the canonical renderer', async () => {
    const source = renderClaudeCarrierContract(['lead', 'peer']);
    expect(source).toContain(`export const GENERATION = ${JSON.stringify(contractDigest())}`);
    expect(source).toContain(JSON.stringify('claude-lead'));
    expect(source).toContain(JSON.stringify(renderInstructions('lead')));
    expect(source).toContain(JSON.stringify('claude-peer'));
    expect(source).toContain(JSON.stringify(renderInstructions('peer')));
    expect(source).not.toContain('claude-supervisor');

    for (const path of ['index.server.ts', 'server/carrier.ts', 'server/contract.ts']) {
      const asset = await readFile(join(import.meta.dirname, '../src/plugin-assets', path), 'utf8');
      const imports = [...asset.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(match => match[1]);
      expect(imports.every(specifier => specifier?.startsWith('.') === true)).toBe(true);
    }
  });
});

describe('Claude contract carrier hook', () => {
  const contracts = { 'claude-lead': 'lead contract' };

  it('targets only exact non-internal room providers', () => {
    expect(transformAgentCreate({ config: { provider: 'claude' } }, contracts, 'g1')).toBeUndefined();
    expect(transformAgentCreate({ config: { provider: 'claude-lead', internal: true } }, contracts, 'g1')).toBeUndefined();
    const carried = `caller\n\n${contractMarker('g1')}\nlead contract`;
    expect(transformAgentCreate({ config: { provider: 'claude-lead', systemPrompt: 'caller' } }, contracts, 'g1'))
      .toEqual({ config: { provider: 'claude-lead', systemPrompt: carried } });
    expect(transformAgentCreate({ config: { provider: 'claude-lead', systemPrompt: carried } }, contracts, 'g1')).toBeUndefined();
    expect(transformAgentCreate({ config: { provider: 'claude-lead', systemPrompt: contractMarker('g1') } }, contracts, 'g1'))
      .toEqual({ config: { provider: 'claude-lead', systemPrompt: `${contractMarker('g1')}\nlead contract` } });
  });
});

describe('Claude contract carrier lifecycle', () => {
  it('installs, verifies, reports drift, and removes the room-owned plugin', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const options = { env: fixture.env, factory: fakeClient(daemon), agents: ['claude'] as const, apply: true };

    const applied = await setup(options);
    expect(applied.outcome).toBe('ok');
    expect(daemon.plugins).toEqual([expect.objectContaining({
      id: CLAUDE_CARRIER_PLUGIN_ID,
      path: join(fixture.roomHome, 'plugin'),
      enabled: true,
      status: 'running',
    })]);
    const manifest = await readFile(join(fixture.roomHome, 'plugin/paseo-plugin.json'), 'utf8');
    const parsedManifest: unknown = JSON.parse(manifest);
    expect(parsedManifest).toEqual({
      id: CLAUDE_CARRIER_PLUGIN_ID,
      requirements: { paseo: '>=0.8.0 <0.9.0' },
    });
    await expect(readFile(join(fixture.roomHome, 'plugin/server/contract.ts'), 'utf8'))
      .resolves.toContain(JSON.stringify(renderInstructions('lead')));
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('ok');

    const plugin = daemon.plugins?.[0];
    if (!plugin) throw new Error('plugin was not installed');
    daemon.plugins = [];
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('failed');
    daemon.plugins = [plugin];
    plugin.path = '/foreign/plugin';
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('failed');
    plugin.path = join(fixture.roomHome, 'plugin');
    plugin.enabled = false;
    plugin.status = 'disabled';
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('failed');

    plugin.enabled = true;
    plugin.status = 'failed';
    plugin.error = 'synthetic load failure';
    const failedRuntime = await verify({ env: fixture.env, factory: fakeClient(daemon) });
    expect(failedRuntime.outcome).toBe('failed');
    expect(failedRuntime.checks.some(check => check.message.includes('synthetic load failure'))).toBe(true);
    plugin.status = 'running';
    delete plugin.error;
    const contractPath = join(fixture.roomHome, 'plugin/server/contract.ts');
    await writeFile(contractPath, '// drift\n');
    const fileDrift = await verify({ env: fixture.env, factory: fakeClient(daemon) });
    expect(fileDrift.outcome).toBe('failed');
    expect(fileDrift.checks.some(check => check.id === 'room.files' && check.status === 'fail')).toBe(true);
    expect((await setup(options)).outcome).toBe('ok');
    expect(daemon.pluginReloads).toBe(1);
    await expect(readFile(contractPath, 'utf8')).resolves.toContain(JSON.stringify(renderInstructions('lead')));

    daemon.failNextPluginRemove = true;
    await expect(setup({ ...options, agents: ['codex'] })).rejects.toThrow('synthetic plugin remove failure');
    const retainedMarker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as { agents: string[] };
    expect(retainedMarker.agents).toEqual(['claude']);
    expect((await setup({ ...options, agents: ['codex'] })).outcome).toBe('ok');
    expect(daemon.plugins).toEqual([]);
    expect((await remove({ env: fixture.env, factory: fakeClient(daemon), apply: true })).outcome).toBe('ok');
  });

  it('does not require the preview plugin RPCs for a Codex-only room', async () => {
    const fixture = await makeFixture({ paseoStatus: {
      listen: '127.0.0.1:6767', localDaemon: 'running',
      cliVersion: '0.8.0-beta.2', daemonVersion: '0.8.0-beta.2',
    } });
    const daemon = emptyDaemon();
    const result = await setup({ env: fixture.env, factory: fakeClient(daemon), agents: ['codex'], apply: true });
    expect(result.outcome).toBe('ok');
    expect(daemon.pluginLists).toBe(0);
  });

  it('keeps the Claude plugin dry run mutation-free', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await setup({ env: fixture.env, factory: fakeClient(daemon), agents: ['claude'] });
    expect(result.outcome).toBe('changes-planned');
    expect(daemon.plugins).toEqual([]);
    await expect(readFile(join(fixture.roomHome, 'room.json'), 'utf8')).rejects.toThrow();
  });

  it('refuses disabled plugins and a foreign registration before writing', async () => {
    const disabledFixture = await makeFixture();
    const disabled = emptyDaemon();
    disabled.pluginsEnabled = false;
    const blocked = await setup({
      env: disabledFixture.env, factory: fakeClient(disabled), agents: ['claude'], apply: true,
    });
    expect(blocked.outcome).toBe('failed');
    expect(blocked.checks.some(check => check.id === 'claude.plugin.enabled' && check.status === 'fail')).toBe(true);
    await expect(readFile(join(disabledFixture.roomHome, 'room.json'), 'utf8')).rejects.toThrow();

    const foreignFixture = await makeFixture();
    const foreign = emptyDaemon();
    foreign.plugins = [{ id: CLAUDE_CARRIER_PLUGIN_ID, path: '/foreign/plugin', enabled: true, status: 'running' }];
    const conflict = await setup({
      env: foreignFixture.env, factory: fakeClient(foreign), agents: ['claude'], apply: true,
    });
    expect(conflict.outcome).toBe('failed');
    expect(conflict.checks.some(check => check.id === 'claude.plugin.path')).toBe(true);
  });
});
