import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/command.js';
import { prepareLifecycle, type LifecycleRuntime } from '../src/cli/lifecycle.js';
import { paseoFilesystem } from '../src/paseo/runtime.js';
import { type TransactionClient } from '../src/paseo/transaction-gateway.js';
import { commandResultSchema } from '../src/core/result.js';
import { snapshotFixture } from './helpers/home.js';

it('composes real artifacts, observation, planner, bootstrap, executor and safe uninstall over an injected SDK', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paseo-cli-lifecycle-')));
  try {
    const canonical = join(root, 'canonical'); const paseo = join(root, 'paseo'); const room = join(root, 'room');
    await fs.mkdir(canonical, { mode: 0o700 }); await fs.mkdir(paseo, { mode: 0o700 });
    for (const name of ['config.toml', 'auth.json', 'AGENTS.md']) await fs.writeFile(join(canonical, name), '', { mode: 0o600 });
    for (const name of ['skills', 'plugins']) await fs.mkdir(join(canonical, name), { mode: 0o700 });
    for (const name of ['codex', 'paseo-bin']) await fs.writeFile(join(root, name), Buffer.from('7f454c46', 'hex'), { mode: 0o700 });
    const uid = process.getuid?.() ?? -1;
    const listen = 'ws://127.0.0.1:6767';
    for (const name of ['server-id', 'cli-client-id', 'config.json']) await fs.writeFile(join(paseo, name), 'fixture', { mode: 0o600 });
    await fs.writeFile(join(paseo, 'paseo.pid'), JSON.stringify({ pid: 123, uid, hostname: 'fixture', listen }), { mode: 0o600 });
    const providers: Record<string, unknown> = { unrelated: { custom: 'preserved' } };
    const entries = () => ({ entries: Object.keys(providers).map(provider => ({ provider, status: 'ready' })) });
    const sdk = {
      connect: () => Promise.resolve(), close: () => Promise.resolve(), getConnectionState: () => ({ status: 'connected' }),
      config: { get: () => Promise.resolve({ config: { providers: structuredClone(providers) } }),
        patch: vi.fn<TransactionClient['config']['patch']>(patch => {
          Object.assign(providers, patch.providers);
          for (const id of patch.removeProviders ?? []) Reflect.deleteProperty(providers, id);
          return Promise.resolve({ config: { providers: structuredClone(providers) } });
        }) },
      agents: { list: () => Promise.resolve({ entries: [], pageInfo: { hasMore: false, nextCursor: null, prevCursor: null } }) },
      providers: { snapshot: () => Promise.resolve(entries()), waitForReady: () => Promise.resolve(entries()),
        refresh: vi.fn(() => Promise.resolve({ acknowledged: true })) },
    } satisfies TransactionClient;
    const lock = vi.fn(() => Promise.resolve({ release: () => Promise.resolve() }));
    const readFile = vi.fn<typeof paseoFilesystem.readFile>(path => {
      if (path.endsWith('/auth.json')) throw new Error('Credential bytes must never be read.');
      return paseoFilesystem.readFile(path);
    });
    const filesystem = { ...paseoFilesystem, readFile };
    const runtime: LifecycleRuntime = { environment: { HOME: root, PASEO_HOME: paseo }, filesystem,
      runner: { run: request => Promise.resolve({ exitCode: 0, stderr: '', stdout: request.args.includes('--version') ? 'codex 1.0.0' : '{"models":[{"slug":"gpt-5.6-sol"}]}' }) },
      probeDependencies: { filesystem, uid, hostname: 'fixture', processUid: () => Promise.resolve(uid),
        runner: { run: () => Promise.resolve({ exitCode: 0, stderr: '', stdout: JSON.stringify({ home: paseo, listen,
          localDaemon: 'running', connectedDaemon: 'reachable', pid: 123, owner: `${String(uid)}@fixture`, hostname: 'fixture',
          cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' }) }) } }, clientFactory: () => sdk, lock };
    const invoke = async (command: string, apply = false) => {
      let stdout = ''; let stderr = '';
      const status = await runCli([command, '--json', '--non-interactive', '--room-home', room, '--codex-home', canonical,
        '--codex-bin', join(root, 'codex'), '--paseo-bin', join(root, 'paseo-bin'), ...(apply ? ['--apply'] : [])],
      { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, { prepare: intent => prepareLifecycle(intent, runtime) });
      expect(stderr).toBe('');
      return { status, result: commandResultSchema.parse(JSON.parse(stdout)) };
    };
    const before = snapshotFixture(root);
    for (const command of ['plan', 'install']) {
      const planned = await invoke(command);
      expect(planned.status, JSON.stringify(planned.result)).toBe(0); expect(planned.result.outcome).toBe('changes-planned');
      expect(snapshotFixture(root)).toEqual(before);
    }
    expect(lock).not.toHaveBeenCalled(); expect(sdk.config.patch).not.toHaveBeenCalled(); expect(sdk.providers.refresh).not.toHaveBeenCalled();
    const installed = await invoke('install', true);
    expect(installed.status, JSON.stringify(installed.result)).toBe(0); expect(installed.result.changed).toBe(true);
    const after = snapshotFixture(root);
    const patches = vi.mocked(sdk.config.patch).mock.calls.length;
    const refreshes = vi.mocked(sdk.providers.refresh).mock.calls.length;
    const locks = lock.mock.calls.length;
    for (const command of ['plan', 'install', 'verify', 'doctor', 'recover', 'uninstall']) {
      const result = await invoke(command);
      expect(result.status, JSON.stringify(result.result)).toBe(0); expect(result.result.changed).toBe(false);
      expect(snapshotFixture(root)).toEqual(after);
    }
    expect((await invoke('install', true)).result.changed).toBe(false);
    expect(vi.mocked(sdk.config.patch).mock.calls).toHaveLength(patches);
    expect(vi.mocked(sdk.providers.refresh).mock.calls).toHaveLength(refreshes); expect(lock.mock.calls).toHaveLength(locks);
    const removed = await invoke('uninstall', true);
    expect(removed.status, JSON.stringify(removed.result)).toBe(0); expect(removed.result.changed).toBe(true);
    expect(providers).toEqual({ unrelated: { custom: 'preserved' } });
    expect(snapshotFixture(canonical)).toEqual((before as { entries: [string, unknown][] }).entries.find(([name]) => name === 'canonical')?.[1]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 240000);
