import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { remove, setup, verify, type RunOptions } from '../src/commands.js';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { ProjectStore } from '../src/runtime-plugin/server/store/project.js';
import { emptyDaemon, fakeClient, makeFixture, RUNNING_STATUS, type FakeDaemon, type Fixture } from './helpers.js';

async function room(daemon: FakeDaemon = emptyDaemon(), status?: unknown): Promise<{ fixture: Fixture; daemon: FakeDaemon; options: (extra?: RunOptions) => RunOptions }> {
  const fixture = await makeFixture(status === undefined ? {} : { paseoStatus: status });
  return { fixture, daemon, options: extra => ({ env: fixture.env, factory: fakeClient(daemon), ...extra }) };
}

const pluginDir = (fixture: Fixture): string => join(fixture.roomHome, 'runtime-plugin');
const checkIds = (result: { checks: readonly { id: string; status: string }[] }, status: string): string[] =>
  result.checks.filter(check => check.status === status).map(check => check.id);

describe('setup --runtime', () => {
  it('changes nothing about a room that does not opt in', async () => {
    const { fixture, daemon, options } = await room();
    const result = await setup(options({ apply: true }));
    expect(result.outcome).toBe('ok');
    await expect(stat(pluginDir(fixture))).rejects.toThrow();
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as Record<string, unknown>;
    expect(marker).not.toHaveProperty('runtime');
    expect(daemon.plugins).toEqual([]);
    expect(result.operations.some(operation => operation.target.includes('runtime'))).toBe(false);
  });

  it('plans honestly in a dry run and writes nothing', async () => {
    const { fixture, daemon, options } = await room();
    const result = await setup(options({ runtime: true }));
    expect(result.outcome).toBe('changes-planned');
    expect(checkIds(result, 'pass')).toEqual(expect.arrayContaining(['runtime.paseo-range', 'runtime.plugin.enabled']));
    expect(result.operations).toEqual(expect.arrayContaining([
      { action: 'create', kind: 'plugin', target: 'paseo-room-runtime' },
      expect.objectContaining({ action: 'create', target: join(pluginDir(fixture), 'generated', 'room-manifest.json') }),
      expect.objectContaining({ action: 'create', target: join(pluginDir(fixture), 'index.server.ts') }),
    ]));
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    expect(daemon.plugins).toEqual([]);
  });

  it('installs from the room-owned path, records the marker, and reloads only when files change', async () => {
    const { fixture, daemon, options } = await room();
    const first = await setup(options({ runtime: true, apply: true }));
    expect(first.outcome).toBe('ok');
    expect(daemon.plugins).toEqual([expect.objectContaining({ id: 'paseo-room-runtime', path: pluginDir(fixture), status: 'running' })]);
    expect(await readFile(join(pluginDir(fixture), 'generated', 'room-manifest.json'), 'utf8')).toBe(renderRuntimeManifestFile(['codex'], ROLES));
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as { runtime?: unknown };
    expect(marker.runtime).toEqual({ enabled: true, generation: expect.stringMatching(/^sha256:/) as unknown, schema: 1 });
    expect(checkIds(first, 'pass')).toContain('runtime.plugin.runtime');

    const reloads = daemon.pluginReloads ?? 0;
    expect((await setup(options({ runtime: true, apply: true }))).changed).toBe(false);
    expect(daemon.pluginReloads).toBe(reloads);

    await writeFile(join(pluginDir(fixture), 'index.server.ts'), '// drifted\n');
    expect((await setup(options({ runtime: true, apply: true }))).outcome).toBe('ok');
    expect(daemon.pluginReloads).toBe(reloads + 1);
    expect((await verify(options())).outcome).toBe('ok');
  });

  it('coexists with the Claude carrier as a separate plugin', async () => {
    const { daemon, options } = await room();
    expect((await setup(options({ agents: ['claude'], runtime: true, apply: true }))).outcome).toBe('ok');
    expect((daemon.plugins ?? []).map(plugin => plugin.id).sort()).toEqual(['paseo-room-claude-carrier', 'paseo-room-runtime']);
    const result = await verify(options());
    expect(result.outcome).toBe('ok');
    expect(checkIds(result, 'pass')).toEqual(expect.arrayContaining(['claude.plugin.runtime', 'runtime.plugin.runtime']));
  });

  it('refuses when plugins are disabled or the daemon is outside the preview range', async () => {
    const disabled = await room({ ...emptyDaemon(), pluginsEnabled: false });
    const refused = await setup(disabled.options({ runtime: true, apply: true }));
    expect(refused.outcome).toBe('failed');
    expect(checkIds(refused, 'fail')).toContain('runtime.plugin.enabled');
    await expect(stat(pluginDir(disabled.fixture))).rejects.toThrow();

    const newer = await room(emptyDaemon(), { ...RUNNING_STATUS, cliVersion: '0.10.0', daemonVersion: '0.10.0' });
    const outside = await setup(newer.options({ runtime: true }));
    expect(checkIds(outside, 'fail')).toEqual(['runtime.paseo-range']);
    // Without --runtime the same daemon still sets up the baseline room.
    expect((await setup(newer.options())).outcome).toBe('changes-planned');
  });
});

describe('verify with runtime selected', () => {
  async function installed(): Promise<Awaited<ReturnType<typeof room>>> {
    const context = await room();
    expect((await setup(context.options({ runtime: true, apply: true }))).outcome).toBe('ok');
    return context;
  }
  const runtimePlugin = (daemon: FakeDaemon) => {
    const plugin = daemon.plugins?.find(entry => entry.id === 'paseo-room-runtime');
    if (plugin === undefined) throw new Error('runtime plugin not installed');
    return plugin;
  };

  it('fails for a missing, disabled, failed or foreign registration', async () => {
    const cases: [string, (daemon: FakeDaemon, fixture: Fixture) => void, string][] = [
      ['missing', daemon => { daemon.plugins = (daemon.plugins ?? []).filter(entry => entry.id !== 'paseo-room-runtime'); }, 'runtime.plugin.runtime'],
      ['disabled', daemon => { Object.assign(runtimePlugin(daemon), { enabled: false, status: 'disabled' }); }, 'runtime.plugin.runtime'],
      ['failed', daemon => { Object.assign(runtimePlugin(daemon), { status: 'failed', error: 'SyntaxError' }); }, 'runtime.plugin.runtime'],
      ['foreign', daemon => { runtimePlugin(daemon).path = '/tmp/elsewhere'; }, 'runtime.plugin.path'],
    ];
    for (const [name, mutate, id] of cases) {
      const { fixture, daemon, options } = await installed();
      mutate(daemon, fixture);
      const result = await verify(options());
      expect(result.outcome, name).toBe('failed');
      expect(checkIds(result, 'fail'), name).toContain(id);
    }
  });

  it('fails for plugin file drift, manifest drift and generation drift', async () => {
    const files = await installed();
    await writeFile(join(pluginDir(files.fixture), 'shared', 'policy.ts'), '// drifted\n');
    expect(checkIds(await verify(files.options()), 'fail')).toContain('room.files');

    const manifest = await installed();
    const path = join(pluginDir(manifest.fixture), 'generated', 'room-manifest.json');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"ask",', '"ask", "assignment_accept",'));
    expect(checkIds(await verify(manifest.options()), 'fail')).toContain('room.files');

    const generation = await installed();
    const markerPath = join(generation.fixture.roomHome, 'room.json');
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { runtime: { generation: string } };
    marker.runtime.generation = 'sha256:0000000000000000';
    await writeFile(markerPath, JSON.stringify(marker));
    expect(checkIds(await verify(generation.options()), 'fail')).toContain('runtime.generation');
  });
});

describe('runtime deselection and removal', () => {
  it('unregisters on deselection when no runtime state exists, and keeps state it did not write', async () => {
    const { fixture, daemon, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const result = await setup(options({ apply: true }));
    expect(result.outcome).toBe('ok');
    expect(result.operations).toContainEqual({ action: 'remove', kind: 'plugin', target: 'paseo-room-runtime' });
    expect(daemon.plugins).toEqual([]);
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as Record<string, unknown>;
    expect(marker).not.toHaveProperty('runtime');
  });

  it('refuses deselection while runtime work is active, and retains quiet state when it proceeds', async () => {
    const { fixture, daemon, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const root = join(fixture.roomHome, 'runtime', 'v1');
    const store = await ProjectStore.create(root, { canonicalRoot: '/work/repo', gitCommonDir: '/work/repo/.git' });
    await store.append({ type: 'assignment.created', payloadVersion: 1, assignmentId: 'asg_active001', actor: { source: 'plugin' }, data: {
      input: { mode: 'writable', kind: 'engineer', outcome: 'x', prerequisites: [], writeScope: ['src/'], exclusions: ['none'], invariants: [], acceptanceEvidence: [], expectedHandoff: ['c'], reopenConditions: [], baseCommit: 'a'.repeat(40), gate: { command: 't', timeoutSeconds: 1, runtimeRerun: 'none', processContractVersion: 1 } },
      leadAgentId: 'lead-1', leadProviderId: 'codex-lead',
    } });
    await store.append({ type: 'assignment.dispatch-requested', payloadVersion: 1, assignmentId: 'asg_active001', actor: { source: 'plugin' }, data: { peerProviderId: 'codex-peer', workspaceId: 'ws' } });
    await store.append({ type: 'ownership.reserved', payloadVersion: 1, assignmentId: 'asg_active001', actor: { source: 'plugin' }, data: { workspaceId: 'ws', baseCommit: 'a'.repeat(40) } });

    const refused = await setup(options({ apply: true }));
    expect(refused.outcome).toBe('failed');
    const check = refused.checks.find(entry => entry.id === 'runtime.deselect');
    expect(check?.message).toContain('asg_active001');
    expect(daemon.plugins?.map(plugin => plugin.id)).toEqual(['paseo-room-runtime']);
    // Rerunning with the flag keeps working and never touches the state.
    expect((await setup(options({ runtime: true, apply: true }))).outcome).toBe('ok');

    expect(check?.message).toContain('writer ownership is reserved');
    expect(check?.message).toContain('is dispatching');
    // An inconsistent ledger is never treated as quiet either.
    await store.append({ type: 'assignment.abandoned', payloadVersion: 1, assignmentId: 'asg_active001', actor: { source: 'human' }, data: { reason: 'illegal from dispatching' } });
    expect((await setup(options({ apply: true }))).checks.find(entry => entry.id === 'runtime.deselect')?.message).toContain('cannot be proven quiet');
  });

  it('deselects once the recorded work is quiet and keeps the state for export', async () => {
    const { fixture, daemon, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const store = await ProjectStore.create(join(fixture.roomHome, 'runtime', 'v1'), { canonicalRoot: '/work/repo', gitCommonDir: '/work/repo/.git' });
    const result = await setup(options({ apply: true }));
    expect(result.outcome).toBe('ok');
    expect(result.checks.find(entry => entry.id === 'runtime.state-retained')?.status).toBe('warn');
    expect(daemon.plugins).toEqual([]);
    expect((await store.replay()).events).toHaveLength(1);
  });

  it('treats unreadable runtime metadata as unknown state, never as empty', async () => {
    const { fixture, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const project = join(fixture.roomHome, 'runtime', 'v1', 'projects', 'repo-1');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'meta.json'), '{}');
    const result = await setup(options({ apply: true }));
    expect(result.outcome).toBe('failed');
    expect(result.checks.find(entry => entry.id === 'runtime.deselect')?.message).toContain('unreadable project metadata');
    expect(await readFile(join(project, 'meta.json'), 'utf8')).toBe('{}');
  });

  it('warns about runtime history on whole-room removal and still deletes it', async () => {
    const { fixture, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    await ProjectStore.create(join(fixture.roomHome, 'runtime', 'v1'), { canonicalRoot: '/work/repo', gitCommonDir: '/work/repo/.git' });
    const preview = await remove(options());
    expect(preview.checks.find(entry => entry.id === 'room.remove.runtime-state')?.message).toContain('1 project');
    const applied = await remove(options({ apply: true }));
    expect(applied.outcome).toBe('ok');
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('deregisters the runtime plugin before deleting the room home', async () => {
    const { fixture, daemon, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const preview = await remove(options());
    expect(preview.operations).toContainEqual({ action: 'remove', kind: 'plugin', target: 'paseo-room-runtime' });
    expect((await remove(options({ apply: true }))).outcome).toBe('ok');
    expect(daemon.plugins).toEqual([]);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('refuses to remove a foreign runtime registration', async () => {
    const { fixture, daemon, options } = await room();
    await setup(options({ runtime: true, apply: true }));
    const plugin = daemon.plugins?.find(entry => entry.id === 'paseo-room-runtime');
    if (plugin) plugin.path = '/opt/other';
    expect((await remove(options({ apply: true }))).outcome).toBe('failed');
    await expect(stat(fixture.roomHome)).resolves.toBeDefined();
  });
});

describe('the --runtime flag', () => {
  it('is a setup choice that verify, remove and auth reject', async () => {
    for (const argv of [['verify', '--runtime'], ['remove', '--runtime'], ['auth', 'login', 'codex', 'lead', '--runtime']]) {
      let err = '';
      const code = await runCli(argv, { stdout: () => undefined, stderr: text => { err += text; } }, { isTTY: false });
      expect(code, argv.join(' ')).toBe(2);
      expect(err).toContain('--runtime');
    }
  });
});
