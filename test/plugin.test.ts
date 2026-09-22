import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DiagnosticCategory, ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { remove, setup, verify } from '../src/commands.js';
import {
  CLAUDE_CARRIER_PLUGIN_ID, renderClaudeCarrierContract, typescriptTemplateLiteral,
} from '../src/plugin.js';
import { contractDigest, renderInstructions } from '../src/room/instructions.js';
import { transformAgentCreate } from '../src/plugin-assets/index.server.js';
import { composeSystemPrompt, contractMarker } from '../src/plugin-assets/server/carrier.js';
import { emptyDaemon, fakeClient, makeFixture, RUNNING_STATUS } from './helpers.js';

describe('Claude contract carrier composition', () => {
  it('appends without replacing and rewrites one marked block idempotently', () => {
    const first = composeSystemPrompt('caller prompt', 'role contract', 'g1');
    expect(first).toBe(`caller prompt\n\n${contractMarker('g1')}\nrole contract`);
    expect(composeSystemPrompt(first, 'role contract', 'g1')).toBe(first);
    expect(composeSystemPrompt(first, 'new contract', 'g2')).toBe(
      `caller prompt\n\n${contractMarker('g2')}\nnew contract`,
    );
  });

  it('generates readable exact per-role documents from the canonical renderer', async () => {
    const source = renderClaudeCarrierContract(['lead', 'peer']);
    expect(source).toContain(`export const GENERATION = ${JSON.stringify(contractDigest())}`);
    expect(source).toContain(`${JSON.stringify('claude-lead')}: ${typescriptTemplateLiteral(renderInstructions('lead'))}`);
    expect(source).toContain(`${JSON.stringify('claude-peer')}: ${typescriptTemplateLiteral(renderInstructions('peer'))}`);
    expect(source).toContain('`# Lead role instructions\n');
    expect(source).not.toContain(JSON.stringify(renderInstructions('lead')));
    expect(source).not.toContain('claude-supervisor');

    const escaped = typescriptTemplateLiteral('path\\name `code` ${value}\nnext');
    expect(escaped).toContain('path\\\\name');
    expect(escaped).toContain('\\`code\\`');
    expect(escaped).toContain('\\${value}');
    expect(escaped).toContain('\nnext');
    expect(runInNewContext(escaped)).toBe('path\\name `code` ${value}\nnext');

    const diagnostics = transpileModule(source, {
      compilerOptions: { module: ModuleKind.NodeNext, target: ScriptTarget.ES2022 },
      reportDiagnostics: true,
    }).diagnostics ?? [];
    expect(diagnostics.filter(diagnostic => diagnostic.category === DiagnosticCategory.Error)).toEqual([]);
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
  it('states the supported Paseo range itself instead of letting apply hit the daemon refusal', async () => {
    // Paseo refuses to install a plugin whose manifest range excludes the running daemon, so a
    // Claude room on an unsupported Paseo must fail as a room check and write nothing.
    const fixture = await makeFixture({ paseoStatus: { ...RUNNING_STATUS, cliVersion: '0.10.0', daemonVersion: '0.10.0' } });
    const daemon = emptyDaemon();
    const result = await setup({ env: fixture.env, factory: fakeClient(daemon), agents: ['claude'], apply: true });
    expect(result.outcome).toBe('failed');
    expect(result.checks.filter(check => check.status === 'fail').map(check => check.id)).toEqual(['claude.paseo-range']);
    expect(daemon.plugins).toEqual([]);
    await expect(readFile(join(fixture.roomHome, 'plugin/paseo-plugin.json'), 'utf8')).rejects.toThrow();

    // A codex-only room needs no plugin, so the same daemon still sets up.
    expect((await setup({ env: fixture.env, factory: fakeClient(daemon), agents: ['codex'], apply: true })).outcome).toBe('ok');
  });

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
      requirements: { paseo: '>=0.8.0 <0.10.0' },
    });
    await expect(readFile(join(fixture.roomHome, 'plugin/server/contract.ts'), 'utf8'))
      .resolves.toContain(typescriptTemplateLiteral(renderInstructions('lead')));
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
    await expect(readFile(contractPath, 'utf8')).resolves.toContain(typescriptTemplateLiteral(renderInstructions('lead')));

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

describe('Claude memory carrier selection', () => {
  it('suppresses only the contract, removes stale text, and keeps the room verifiable', async () => {
    const fixture = await makeFixture();
    const operatorMemory = '# Operator Claude memory\n';
    await writeFile(join(fixture.home, '.claude/CLAUDE.md'), operatorMemory);
    const daemon = emptyDaemon();
    const options = { env: fixture.env, factory: fakeClient(daemon), agents: ['claude'] as const, apply: true };
    const leadMemory = join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md');

    // Default: both carriers, so the file holds operator memory plus the contract.
    expect((await setup(options)).outcome).toBe('ok');
    expect(await readFile(leadMemory, 'utf8')).toBe(`${operatorMemory}\n${renderInstructions('lead')}`);

    // Suppressed: the stale contract must be gone rather than left behind.
    const suppressed = await setup({ ...options, claudeMemoryContract: false });
    expect(suppressed.outcome).toBe('ok');
    expect(await readFile(leadMemory, 'utf8')).toBe(operatorMemory);
    expect(await readFile(leadMemory, 'utf8')).not.toContain(renderInstructions('lead'));
    expect(suppressed.checks.some(check => check.id === 'claude.memory-contract' && check.status === 'warn')).toBe(true);
    // The plugin is still the strong carrier and still carries the full contract.
    await expect(readFile(join(fixture.roomHome, 'plugin/server/contract.ts'), 'utf8'))
      .resolves.toContain(typescriptTemplateLiteral(renderInstructions('lead')));

    // The choice is recorded, so verify compares against it without being told again.
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as {
      claudeMemoryContract?: boolean;
    };
    expect(marker.claudeMemoryContract).toBe(false);
    const verified = await verify({ env: fixture.env, factory: fakeClient(daemon) });
    expect(verified.outcome).toBe('ok');
    expect(verified.checks.some(check => check.id === 'claude.memory-contract')).toBe(true);

    // Restoring the fallback rewrites the contract and clears the marker field.
    const restored = await setup(options);
    expect(restored.outcome).toBe('ok');
    expect(await readFile(leadMemory, 'utf8')).toBe(`${operatorMemory}\n${renderInstructions('lead')}`);
    const restoredMarker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as {
      claudeMemoryContract?: boolean;
    };
    expect(restoredMarker.claudeMemoryContract).toBeUndefined();
    expect(restored.checks.some(check => check.id === 'claude.memory-contract')).toBe(false);
  });

  it('writes no memory file at all when the operator has no global memory to carry', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const options = {
      env: fixture.env, factory: fakeClient(daemon), agents: ['claude'] as const,
      apply: true, claudeMemoryContract: false,
    };
    expect((await setup(options)).outcome).toBe('ok');
    await expect(readFile(join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md'), 'utf8')).rejects.toThrow();
    // A room with nothing to write is still consistent with its own marker.
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('ok');
  });

  it('leaves a Codex-only room untouched by the Claude carrier choice', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const suppressed = await setup({
      env: fixture.env, factory: fakeClient(daemon), agents: ['codex'], apply: true, claudeMemoryContract: false,
    });
    expect(suppressed.outcome).toBe('ok');
    // Nothing about Codex changes, and no Claude-specific warning is shown.
    expect(suppressed.checks.some(check => check.id === 'claude.memory-contract')).toBe(false);
    // Codex carries its contract in config developer_instructions, untouched by a Claude-only flag.
    await expect(readFile(join(fixture.roomHome, 'roles/codex/lead/config.toml'), 'utf8'))
      .resolves.toContain('developer_instructions');
  });
  it('reports a reappeared suppressed file as suppressed rather than outdated', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const options = {
      env: fixture.env, factory: fakeClient(daemon), agents: ['claude'] as const,
      apply: true, claudeMemoryContract: false,
    };
    expect((await setup(options)).outcome).toBe('ok');

    // Something put the file back: the fix is deletion, so the drift must not read "outdated".
    const leadMemory = join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md');
    await writeFile(leadMemory, '# resurrected contract\n');
    const drifted = await verify({ env: fixture.env, factory: fakeClient(daemon) });
    expect(drifted.outcome).toBe('failed');
    const files = drifted.checks.find(check => check.id === 'room.files');
    expect(files?.message).toContain('present but suppressed by this room');
    expect(files?.message).not.toContain('missing or outdated');
    // And setup reconciles it by removing the file again.
    expect((await setup(options)).outcome).toBe('ok');
    await expect(readFile(leadMemory, 'utf8')).rejects.toThrow();
  });

  it('records the choice only for a room that actually seats Claude', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await setup({
      env: fixture.env, factory: fakeClient(daemon), agents: ['codex'], apply: true, claudeMemoryContract: false,
    });
    // A Codex-only room has no CLAUDE.md to suppress, so the field would be meaningless state.
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as Record<string, unknown>;
    expect(marker.claudeMemoryContract).toBeUndefined();
  });

  it('drops the recorded choice when Claude is deselected and restores the contract on reselect', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.claude/CLAUDE.md'), '# Operator Claude memory\n');
    const daemon = emptyDaemon();
    const base = { env: fixture.env, factory: fakeClient(daemon), apply: true };
    const markerFields = async (): Promise<Record<string, unknown>> =>
      JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as Record<string, unknown>;

    await setup({ ...base, agents: ['claude'], claudeMemoryContract: false });
    expect((await markerFields()).claudeMemoryContract).toBe(false);
    await setup({ ...base, agents: ['codex'] });
    expect((await markerFields()).claudeMemoryContract).toBeUndefined();

    // Reselecting without the flag is the default again, so the fallback comes back.
    expect((await setup({ ...base, agents: ['claude'] })).outcome).toBe('ok');
    await expect(readFile(join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md'), 'utf8'))
      .resolves.toContain(renderInstructions('lead'));
    expect((await verify({ env: fixture.env, factory: fakeClient(daemon) })).outcome).toBe('ok');
  });
});
