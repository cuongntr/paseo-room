import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { fakeClient, makeFixture, RUNNING_STATUS, type FakeDaemon } from './helpers.js';

async function run(argv: readonly string[], env: NodeJS.ProcessEnv, daemon: FakeDaemon): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, { stdout: text => { out += text; }, stderr: text => { err += text; } }, {
    isTTY: false,
    options: { env, factory: fakeClient(daemon) },
  });
  return { code, out, err };
}
const emptyDaemon = (): FakeDaemon => ({ providers: {}, refreshed: [], connects: 0 });

describe('paseo-room CLI', () => {
  it('is a dry run by default and writes nothing', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run(['setup'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Planned changes');
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('applies both agents and registers six providers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const result = await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers).sort()).toEqual([
      'claude-lead', 'claude-peer', 'claude-supervisor', 'codex-lead', 'codex-peer', 'codex-supervisor',
    ]);
    expect(daemon.refreshed).toHaveLength(6);
    const marker = JSON.parse(await readFile(join(fixture.roomHome, 'room.json'), 'utf8')) as { agents: string[] };
    expect(marker.agents).toEqual(['codex', 'claude']);
    // The Peer-gets-no-room-tools rule, checked where it actually lands.
    const tools = (id: string): unknown => (daemon.providers[id] as { paseoTools: { enabled: boolean } }).paseoTools.enabled;
    expect([tools('codex-supervisor'), tools('codex-lead'), tools('codex-peer')]).toEqual([true, true, false]);
    expect([tools('claude-supervisor'), tools('claude-lead'), tools('claude-peer')]).toEqual([true, true, false]);
  });

  it('is idempotent: a second run plans no changes and verify passes', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const second = await run(['setup'], fixture.env, daemon);
    expect(second.out).toContain('already up to date');
    const verified = await run(['verify', '--json'], fixture.env, daemon);
    expect(verified.code).toBe(0);
    expect((JSON.parse(verified.out) as { outcome: string }).outcome).toBe('ok');
  });

  it('verify fails when a managed file or provider drifts', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    daemon.providers['codex-peer'] = { ...(daemon.providers['codex-peer'] as object), paseoTools: { enabled: true } };
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });

  it('removes only the room home and its providers', async () => {
    const fixture = await makeFixture();
    const daemon = { ...emptyDaemon(), providers: { unrelated: { extends: 'pi' } } as Record<string, unknown> };
    await run(['setup', '--apply'], fixture.env, daemon);
    await run(['remove', '--apply'], fixture.env, daemon);
    expect(Object.keys(daemon.providers)).toEqual(['unrelated']);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
    await expect(stat(join(fixture.home, '.codex', 'config.toml'))).resolves.toBeDefined();
  });

  it('refuses to run when Paseo is too old, before touching anything', async () => {
    const fixture = await makeFixture({ paseoStatus: { ...RUNNING_STATUS, cliVersion: '0.7.0', daemonVersion: '0.7.0' } });
    const daemon = emptyDaemon();
    const result = await run(['setup', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(1);
    expect(result.out).toContain('older than the required');
    expect(daemon.connects).toBe(0);
  });

  it('rejects an unknown command and an unknown agent', async () => {
    const fixture = await makeFixture();
    expect((await run(['nope'], fixture.env, emptyDaemon())).code).toBe(2);
    expect((await run(['setup', '--agent', 'pi'], fixture.env, emptyDaemon())).code).toBe(2);
  });
});

describe('changing the seated agents', () => {
  it('drops role homes and providers the new selection no longer covers', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--apply'], fixture.env, daemon);
    const result = await run(['setup', '--agent', 'codex', '--apply'], fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers).sort()).toEqual(['codex-lead', 'codex-peer', 'codex-supervisor']);
    await expect(stat(join(fixture.roomHome, 'roles/claude/lead'))).rejects.toThrow();
    await expect(stat(join(fixture.roomHome, 'roles/codex/lead'))).resolves.toBeDefined();
  });

  it('refuses a room home that overlaps the agent home', async () => {
    const fixture = await makeFixture();
    const result = await run(['setup', '--room-home', join(fixture.home, '.codex', 'room'), '--apply'], fixture.env, emptyDaemon());
    expect(result.code).toBe(1);
    expect(result.out).toContain('overlaps the room home');
  });
});

describe('remove safety', () => {
  it('refuses to delete a room home that contains the user home', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    // A room marker at $HOME itself must never authorise deleting $HOME.
    await writeFile(join(fixture.home, 'room.json'), JSON.stringify({ version: '0.0.0', agents: ['codex'], roles: ['lead'] }));
    const result = await run(['remove', '--room-home', fixture.home, '--apply'], fixture.env, daemon);
    expect(result.code).toBe(1);
    expect(result.out).toContain('Refusing to use');
    await expect(stat(join(fixture.home, '.codex'))).resolves.toBeDefined();
  });
});

describe('provider-level pins', () => {
  it('pins Codex sandbox and approval so Paseo mode presets cannot outrank the config', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    for (const id of ['codex-supervisor', 'codex-lead', 'codex-peer']) {
      expect(daemon.providers[id]).toMatchObject({ params: { sandbox_mode: 'danger-full-access', approval_policy: 'never' } });
    }
  });

  it('denies Claude the Task tool so Paseo stays the only control plane', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'claude', '--apply'], fixture.env, daemon);
    for (const id of ['claude-supervisor', 'claude-lead', 'claude-peer']) {
      expect(daemon.providers[id]).toMatchObject({ disallowedTools: ['Task'] });
    }
  });

  it('verify fails when a pin is removed from the live config', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const live = { ...(daemon.providers['codex-lead'] as Record<string, unknown>) };
    delete live.params;
    daemon.providers['codex-lead'] = live;
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Paseo providers are missing or differ');
  });
});
