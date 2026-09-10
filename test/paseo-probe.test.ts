import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { probePaseo, normalizeListen, endpointIdentitySha256, type ProbeDependencies } from '../src/paseo/cli-probe.js';
import { connectPaseo, type ConnectionClient } from '../src/paseo/gateway.js';
import { filesystem } from './fakes/contracts.js';
import { renderHuman, renderJson } from '../src/cli/render.js';

const status = { home: '/home/paseo', listen: 'localhost:6767', localDaemon: 'running', connectedDaemon: 'reachable',
  pid: 123, owner: '501@fixture', hostname: 'fixture', cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' };
const pidEvidence = { pid: 123, uid: 501, hostname: 'fixture', listen: 'localhost:6767' };
const input = { executable: '/bin/paseo', localHome: '/home/paseo', home: '/home', timeoutMs: 50 };
const desktopExecutable = '/Applications/Paseo.app/Contents/Resources/bin/paseo';
function setup(patch: Record<string, unknown> = {}) {
  const run = vi.fn<ProbeDependencies['runner']['run']>().mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ ...status, ...patch }), stderr: '' });
  const deps: ProbeDependencies = { uid: 501, hostname: 'fixture', runner: { run }, processUid: vi.fn().mockResolvedValue(501),
    filesystem: { ...filesystem, readFile: (path) => Promise.resolve(Buffer.from(path === '/bin/paseo' ? '#!/usr/bin/env node\n' : path.endsWith('paseo.pid') ? JSON.stringify(pidEvidence) : 'id_fixture\n')),
      lstat: (path) => Promise.resolve({ kind: ['/bin/paseo', '/home/paseo/server-id', '/home/paseo/cli-client-id', '/home/paseo/paseo.pid', '/home/paseo/config.json'].includes(path) ? 'file' : 'directory',
        mode: path === '/bin/paseo' ? 0o755 : path.endsWith('server-id') || path.endsWith('cli-client-id') || path.endsWith('paseo.pid') || path.endsWith('config.json') ? 0o600 : 0o700,
        device: 1, inode: 1, links: 1, uid: 501 }) } };
  return { deps, run };
}
function desktopSetup(executable = desktopExecutable) {
  const { deps, run } = setup();
  const original = deps.filesystem;
  const appParent = executable.slice(0, executable.indexOf('.app') + 4);
  return { run, deps: { ...deps, platform: 'darwin' as const, filesystem: { ...original,
    readFile: (path: string) => path === executable ? Promise.resolve(Buffer.from('#!/bin/sh\n')) : original.readFile(path),
    lstat: async (path: string) => {
      if (path === executable) return { kind: 'file' as const, mode: 0o755, device: 1, inode: 2, links: 1, uid: 0 };
      if (path === '/Applications') return { kind: 'directory' as const, mode: 0o775, device: 1, inode: 3, links: 1, uid: 0 };
      if (path.startsWith(`${appParent}/`) || path === appParent) return { kind: 'directory' as const, mode: 0o755, device: 1, inode: 4, links: 1, uid: 0 };
      return original.lstat(path);
    },
  } } };
}
describe('local admission', () => {
  it('normalizes aliases and deterministically binds home/listen, not serverId', async () => {
    const { deps, run } = setup({ serverId: 'untrusted' });
    const result = await probePaseo({ ...input, paseoUrl: 'ws://127.0.0.1:6767/' }, deps);
    expect(result.listen).toBe('ws://127.0.0.1:6767');
    expect(result.endpointIdentitySha256).toBe(endpointIdentitySha256('/home/paseo', 'ws://127.0.0.1:6767'));
    expect(result).not.toHaveProperty('serverId');
    expect(run.mock.calls[0]?.[0]).toEqual({ executable: process.execPath, args: ['/bin/paseo', 'daemon', 'status', '--json'], shell: false, timeoutMs: 50,
      env: { HOME: '/home', PASEO_HOME: '/home/paseo', PATH: '/dev/null' } });
    expect(endpointIdentitySha256('/a', 'bc')).not.toBe(endpointIdentitySha256('/ab', 'c'));
  });
  it.each([
    [{ localDaemon: 'stopped' }, 'stopped'], [{ localDaemon: 'stale_pid' }, 'stopped'],
    [{ localDaemon: 'unresponsive' }, 'unreachable'], [{ connectedDaemon: 'unreachable' }, 'unreachable'],
    [{ connectedDaemon: 'not_probed' }, 'unreachable'], [{ connectedDaemon: 'auth_required' }, 'auth_required'],
    [{ connectedDaemon: 'auth_failed' }, 'auth_failed'], [{ cliVersion: '0.7.2', daemonVersion: '0.7.2' }, 'old'],
    [{ daemonVersion: '0.8.0' }, 'version_mismatch'], [{ cliVersion: 'nonsense' }, 'version'],
    [{ daemonVersion: null }, 'version'], [{ home: '/other' }, 'home'], [{ owner: '502@fixture' }, 'owner'],
    [{ hostname: 'other' }, 'owner'], [{ pid: null }, 'owner'], [{ pid: -1 }, 'status'], [{ pid: '123' }, 'status'],
    [{ pid: 124 }, 'owner'], [{ listen: 'localhost:6768' }, 'listen'], [{ listen: 'remote.example:6767' }, 'remote'], [{ localDaemon: 'unknown' }, 'status'],
  ])('classifies %j', async (patch, id) => {
    const { deps, run } = setup(patch);
    await expect(probePaseo(input, deps)).rejects.toMatchObject({ check: { id: `paseo.${id}` } });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('checks live UID and URL mismatch', async () => {
    const { deps } = setup();
    await expect(probePaseo({ ...input, paseoUrl: 'ws://localhost:99' }, deps)).rejects.toMatchObject({ check: { id: 'paseo.listen' } });
    await expect(probePaseo(input, { ...deps, processUid: () => Promise.resolve(null) })).rejects.toMatchObject({ check: { id: 'paseo.owner' } });
  });
  it.each(['ws://127.1:6767', 'ws://2130706433:6767', 'ws://localhost:0', 'ws://localhost:65536', 'ws://user:secret@localhost', 'ws://localhost/path', 'ws://localhost?x=1', 'ws://localhost#x', 'ws://0.0.0.0:6767'])('rejects unsafe URL %s', (url) => {
    expect(() => normalizeListen(url)).toThrow();
  });
  it('normalizes IPv6, default ports, semver prefix', async () => {
    expect(normalizeListen('wss://[::1]/')).toBe('wss://[::1]:443');
    expect(normalizeListen('ws://localhost:6767/ws/')).toBe('ws://127.0.0.1:6767');
    expect(normalizeListen('ws://localhost')).toBe('ws://127.0.0.1:80');
    const { deps } = setup({ cliVersion: 'v0.8.0-beta.1' });
    expect((await probePaseo(input, deps)).cliVersion).toBe('0.8.0-beta.1');
  });
  it.each(['EAGAIN', 'EINTR', 'ETIMEDOUT'])('retries transient %s once', async (code) => {
    const { deps, run } = setup();
    run.mockRejectedValueOnce(Object.assign(new Error('secret'), { code }));
    await probePaseo(input, deps);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockRejectedValue(Object.assign(new Error('secret'), { code }));
    await expect(probePaseo(input, deps)).rejects.toThrow('could not complete');
    expect(run).toHaveBeenCalledTimes(4);
  });
  it('does not retry permanent errors, invalid JSON or nonzero exit', async () => {
    for (const kind of ['throw', 'json', 'exit']) {
      const { deps, run } = setup();
      if (kind === 'throw') run.mockRejectedValue(new Error('private-value'));
      else run.mockResolvedValue({ stdout: 'private-value', stderr: 'private-value', exitCode: kind === 'exit' ? 1 : 0 });
      await expect(probePaseo(input, deps)).rejects.not.toThrow('private-value');
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
  it('rejects absent executable, unsafe/missing homes, linked files, empty identity before spawning', async () => {
    for (const kind of ['missing', 'symlink', 'foreign', 'alias', 'hardlink', 'empty']) {
      const { deps, run } = setup();
      const original = deps.filesystem;
      const changed = { ...original,
        realpath: (path: string) => Promise.resolve(kind === 'alias' ? '/other' : path),
        readFile: () => Promise.resolve(Buffer.from(kind === 'empty' ? '' : 'srv_fixture')),
        lstat: async (path: string) => {
          const meta = await original.lstat(path);
          if (kind === 'missing') return null;
          if (!meta) return meta;
          return { ...meta, ...(kind === 'symlink' && path === '/home' ? { kind: 'symlink' as const } : {}),
            uid: kind === 'foreign' ? 502 : 501, links: kind === 'hardlink' ? 2 : 1 };
        } };
      await expect(probePaseo(input, { ...deps, filesystem: changed })).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  });
  it.each(['missing', 'empty', 'symlink', 'hardlink', 'unsafe', 'foreign'])('rejects %s cli-client-id before reading aliases or spawning', async (kind) => {
    const { deps, run } = setup();
    const original = deps.filesystem;
    const readFile = vi.fn((path: string) => original.readFile(path));
    if (kind === 'empty') readFile.mockImplementation((path) => path.endsWith('cli-client-id') ? Promise.resolve(Buffer.from(' \n')) : original.readFile(path));
    const fs = { ...original, readFile, lstat: async (path: string) => {
      const meta = await original.lstat(path);
      if (!path.endsWith('cli-client-id') || !meta) return meta;
      if (kind === 'missing') return null;
      return { ...meta, kind: kind === 'symlink' ? 'symlink' as const : meta.kind,
        links: kind === 'hardlink' ? 2 : 1, mode: kind === 'unsafe' ? 0o644 : meta.mode,
        uid: kind === 'foreign' ? 502 : meta.uid };
    } };
    await expect(probePaseo(input, { ...deps, filesystem: fs })).rejects.toMatchObject({ check: { id: 'paseo.home' } });
    expect(run).not.toHaveBeenCalled();
    if (kind !== 'empty') expect(readFile).not.toHaveBeenCalledWith('/home/paseo/cli-client-id');
  });
  it.each(['missing', 'symlink', 'hardlink', 'unsafe', 'foreign'])('rejects %s config before spawn', async (kind) => {
    const { deps, run } = setup();
    const original = deps.filesystem;
    const readFile = vi.fn((path: string) => original.readFile(path));
    await expect(probePaseo(input, { ...deps, filesystem: { ...original, readFile,
      lstat: async (path) => {
        const meta = await original.lstat(path);
        if (!path.endsWith('config.json') || !meta) return meta;
        if (kind === 'missing') return null;
        return { ...meta, kind: kind === 'symlink' ? 'symlink' as const : meta.kind,
          links: kind === 'hardlink' ? 2 : 1, mode: kind === 'unsafe' ? 0o644 : meta.mode,
          uid: kind === 'foreign' ? 502 : meta.uid };
      },
    } })).rejects.toMatchObject({ check: { id: 'paseo.home' } });
    expect(run).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalledWith('/home/paseo/config.json');
  });
  it('admits the exact macOS Desktop launcher and invokes status directly with the existing environment', async () => {
    const { deps, run } = desktopSetup();
    await probePaseo({ ...input, executable: desktopExecutable }, deps, 'private-value');
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual({ executable: desktopExecutable,
      args: ['daemon', 'status', '--json'], env: { HOME: '/home', PASEO_HOME: '/home/paseo', PATH: '/usr/bin:/bin', PASEO_PASSWORD: 'private-value' },
      shell: false, timeoutMs: 50 });
  });
  it.each([
    ['wrong platform', desktopExecutable, 'linux'],
    ['wrong path', '/Applications/Other.app/Contents/Resources/bin/paseo', 'darwin'],
  ] as const)('does not admit the Desktop parent exception on %s', async (_case, executable, platform) => {
    const { deps, run } = desktopSetup(executable);
    await expect(probePaseo({ ...input, executable }, { ...deps, platform })).rejects.toMatchObject({ check: { id: 'paseo.launcher' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects an unsafe other bundle parent before status', async () => {
    const { deps, run } = desktopSetup();
    const original = deps.filesystem;
    await expect(probePaseo({ ...input, executable: desktopExecutable }, { ...deps, filesystem: { ...original,
      lstat: async (path) => {
        const metadata = await original.lstat(path);
        return path === '/Applications/Paseo.app' && metadata ? { ...metadata, mode: 0o777 } : metadata;
      },
    } })).rejects.toMatchObject({ check: { id: 'paseo.launcher' } });
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['foreign', 'alias', 'realpath-error'] as const)('requires /Applications to be a root-owned real directory (%s)', async (kind) => {
    const { deps, run } = desktopSetup();
    const original = deps.filesystem;
    await expect(probePaseo({ ...input, executable: desktopExecutable }, { ...deps, filesystem: { ...original,
      lstat: async (path) => {
        const metadata = await original.lstat(path);
        return path === '/Applications' && metadata && kind === 'foreign' ? { ...metadata, uid: 502 } : metadata;
      },
      realpath: (path) => path === '/Applications'
        ? kind === 'realpath-error' ? Promise.reject(new Error('private-value')) : Promise.resolve(kind === 'alias' ? '/System/Applications' : path)
        : original.realpath(path),
    } })).rejects.toMatchObject({ check: { id: 'paseo.launcher' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('leaves ordinary launcher admission and invocation unchanged on darwin', async () => {
    const { deps, run } = setup();
    await probePaseo(input, { ...deps, platform: 'darwin' });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual({ executable: process.execPath, args: ['/bin/paseo', 'daemon', 'status', '--json'],
      env: { HOME: '/home', PASEO_HOME: '/home/paseo', PATH: '/dev/null' }, shell: false, timeoutMs: 50 });
  });
  it('executes a native launcher directly and rejects shebang-free text', async () => {
    const { deps, run } = setup();
    const withLauncher = (bytes: Uint8Array) => ({ ...deps, filesystem: { ...deps.filesystem,
      readFile: (path: string) => path === input.executable ? Promise.resolve(bytes) : deps.filesystem.readFile(path),
    } });
    await probePaseo(input, withLauncher(Buffer.from('7f454c4602010100', 'hex')));
    expect(run.mock.calls[0]?.[0]).toMatchObject({ executable: input.executable, args: ['daemon', 'status', '--json'], env: { PATH: '/dev/null' } });
    run.mockClear();
    await expect(probePaseo(input, withLauncher(Buffer.from('echo unsafe')))).rejects.toMatchObject({ check: { id: 'paseo.launcher' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('supports only the pinned npm env -S warning flag via absolute Node', async () => {
    const { deps, run } = setup();
    await probePaseo(input, { ...deps, filesystem: { ...deps.filesystem,
      readFile: (path) => path === input.executable ? Promise.resolve(Buffer.from('#!/usr/bin/env -S node --disable-warning=DEP0040\n')) : deps.filesystem.readFile(path),
    } });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ executable: process.execPath,
      args: ['--disable-warning=DEP0040', input.executable, 'daemon', 'status', '--json'], env: { PATH: '/dev/null' } });
  });
  it.each(['#!/usr/bin/env node --inspect', '#!/bin/sh', '#!/usr/bin/env -S node', '#!/usr/bin/env node\r'])('rejects unsupported launcher %s', async (launcher) => {
    const { deps, run } = setup();
    await expect(probePaseo(input, { ...deps, filesystem: { ...deps.filesystem,
      readFile: () => Promise.resolve(Buffer.from(launcher + '\n')),
    } })).rejects.toMatchObject({ check: { id: 'paseo.launcher' } });
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    'invalid JSON', JSON.stringify({}), ...[
      { pid: 0 }, { pid: 1.5 }, { pid: '123' }, { uid: 502 }, { uid: '501' }, { hostname: 'remote' },
      { listen: null }, { listen: '' }, { listen: 'remote.example:6767' }, { listen: 'ssh://host' },
      { listen: 'wss://relay.example/ws' }, { listen: '/tmp/paseo.sock' }, { listen: undefined },
    ].map((patch) => JSON.stringify({ ...pidEvidence, ...patch })),
  ])('rejects malformed or unsafe persisted PID evidence before spawning (%#)', async (bytes) => {
    const { deps, run } = setup();
    const original = deps.filesystem;
    await expect(probePaseo(input, { ...deps, filesystem: { ...original,
      readFile: (path) => path.endsWith('paseo.pid') ? Promise.resolve(Buffer.from(bytes)) : original.readFile(path),
    } })).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects dead/foreign process or requested endpoint mismatch before status', async () => {
    const { deps, run } = setup();
    for (const uid of [null, 502]) {
      await expect(probePaseo(input, { ...deps, processUid: () => Promise.resolve(uid) })).rejects.toMatchObject({ check: { id: 'paseo.owner' } });
    }
    await expect(probePaseo({ ...input, paseoUrl: 'localhost:99' }, deps)).rejects.toMatchObject({ check: { id: 'paseo.listen' } });
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects invalid timeouts and relative paths', async () => {
    const { deps } = setup();
    for (const timeoutMs of [0, -1, 30001, 1.5]) await expect(probePaseo({ ...input, timeoutMs }, deps)).rejects.toThrow();
    await expect(probePaseo({ ...input, executable: 'paseo' }, deps)).rejects.toThrow();
    await expect(probePaseo({ ...input, localHome: '/home/../home/paseo' }, deps)).rejects.toThrow();
  });
});

describe('public SDK lifecycle', () => {
  function client(): ConnectionClient { return { connect: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), getConnectionState: () => ({ status: 'connected' }) }; }
  it('passes password only in-memory to selected status env and SDK, disables logging/reconnect, closes', async () => {
    const { deps, run } = setup(); const sdk = client(); const factory = vi.fn(() => sdk);
    const result = await connectPaseo(input, deps, 'private-value', factory);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ password: 'private-value', reconnect: { enabled: false } }));
    expect(run.mock.calls[0]?.[0].env).toEqual({ HOME: '/home', PASEO_HOME: '/home/paseo', PATH: '/dev/null', PASEO_PASSWORD: 'private-value' });
    expect(JSON.stringify(run.mock.calls[0]?.[0].args)).not.toContain('private-value');
    expect(JSON.stringify(result)).not.toContain('private-value');
    expect(sdk.close).toHaveBeenCalledOnce();
  });
  it.each([[undefined, 'auth_required'], ['private-value', 'auth_failed']] as const)('classifies status authentication without creating SDK (%s)', async (password, id) => {
    const { deps, run } = setup({ connectedDaemon: id, note: 'private-value', serverId: 'private-value' });
    const factory = vi.fn(() => client());
    try { await connectPaseo(input, deps, password, factory); expect.fail('must reject'); }
    catch (error) {
      expect(error).toMatchObject({ check: { id: `paseo.${id}` } });
      expect(JSON.stringify(error)).not.toContain('private-value');
      for (const render of [renderJson, renderHuman]) {
        expect(render({ schemaVersion: 1, command: 'verify', outcome: 'failed', changed: false,
          checks: [{ id, status: 'fail', message: String(error) }], operations: [] })).not.toContain('private-value');
      }
    }
    expect(factory).not.toHaveBeenCalled();
    expect(run.mock.calls[0]?.[0].env.PASEO_PASSWORD).toBe(password);
    expect(JSON.stringify(run.mock.calls[0]?.[0].args)).not.toContain('private-value');
  });
  it.each(['spawn', 'json', 'exit', 'filesystem', 'factory', 'close'])('sanitizes credential-bearing %s errors', async (boundary) => {
    const { deps, run } = setup();
    const sdk = client();
    const failure = () => { throw new Error('private-value'); };
    if (boundary === 'spawn') run.mockRejectedValue(new Error('private-value'));
    if (boundary === 'json' || boundary === 'exit') run.mockResolvedValue({ stdout: 'private-value', stderr: 'private-value', exitCode: boundary === 'exit' ? 1 : 0 });
    if (boundary === 'close') sdk.close = vi.fn().mockRejectedValue(new Error('private-value'));
    const selected = boundary === 'filesystem' ? { ...deps, filesystem: { ...deps.filesystem, readFile: failure } } : deps;
    try { await connectPaseo(input, selected, 'private-value', boundary === 'factory' ? failure : () => sdk); expect.fail('must reject'); }
    catch (error) {
      expect(error).toMatchObject({ check: { status: 'fail' } });
      expect(String(error)).not.toContain('private-value');
      expect(JSON.stringify(error)).not.toContain('private-value');
      for (const render of [renderJson, renderHuman]) {
        expect(render({ schemaVersion: 1, command: 'verify', outcome: 'failed', changed: false,
          checks: [{ id: 'test', status: 'fail', message: String(error) }], operations: [] })).not.toContain('private-value');
      }
    }
  });
  it.each([['Password required', 'auth_required'], ['Incorrect password', 'auth_failed'], ['private-value', 'unreachable']])('sanitizes %s and closes', async (message, id) => {
    const { deps } = setup(); const sdk = client(); sdk.connect = vi.fn().mockRejectedValue(new Error(message));
    try { await connectPaseo(input, deps, 'private-value', () => sdk); expect.fail('must reject'); }
    catch (error) {
      expect(error).toMatchObject({ check: { id: `paseo.${id}` } });
      expect(JSON.stringify(error)).not.toContain('private-value');
      expect(renderJson({ schemaVersion: 1, command: 'verify', outcome: 'failed', changed: false, checks: [{ id, status: 'fail', message: String(error) }], operations: [] })).not.toContain('private-value');
    }
    expect(sdk.close).toHaveBeenCalledOnce();
  });
  it('bounds hung connect and cleanup and checks connected state', async () => {
    const { deps } = setup(); const sdk = client();
    sdk.connect = () => new Promise(() => {});
    await expect(connectPaseo({ ...input, timeoutMs: 5 }, deps, undefined, () => sdk)).rejects.toMatchObject({ check: { id: 'paseo.unreachable' } });
    expect(sdk.close).toHaveBeenCalledOnce();
    const disconnected = { ...client(), getConnectionState: () => ({ status: 'disconnected' as const }) };
    await expect(connectPaseo(input, deps, undefined, () => disconnected)).rejects.toThrow();
    const hanging = { ...client(), close: () => new Promise<void>(() => {}) };
    await expect(connectPaseo({ ...input, timeoutMs: 5 }, deps, undefined, () => hanging)).rejects.toMatchObject({ check: { id: 'paseo.cleanup' } });
  });
});

it('preserves sanitized real process timeout classification and no inherited secrets', async () => {
  const { processRunner } = await import('../src/core/process.js');
  await expect(processRunner.run({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'],
    env: {}, shell: false, timeoutMs: 10 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  const result = await processRunner.run({ executable: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({password: process.env.PASEO_PASSWORD ?? null, value: process.argv[1]}))', '$(echo unsafe)'],
    env: {}, shell: false, timeoutMs: 1000 });
  expect(JSON.parse(result.stdout)).toEqual({ password: null, value: '$(echo unsafe)' });
});

it('contains provider fallback on auth failure and preserves config bytes/modes without repair', async () => {
  const { mkdtemp, realpath, mkdir, writeFile, readFile, lstat, chmod, rm } = await import('node:fs/promises');
  const { tmpdir, hostname } = await import('node:os');
  const { localProbeDependencies } = await import('../src/paseo/runtime.js');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-status-containment-')));
  try {
    const localHome = join(root, 'paseo');
    await mkdir(localHome, { mode: 0o700 });
    const sentinel = join(root, 'provider-ran');
    for (const name of ['claude', 'codex', 'opencode']) {
      // Marker alone is sufficient evidence; never persist credential content.
      await writeFile(join(root, name), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');`, { mode: 0o700 });
    }
    const executable = join(root, 'status');
    const response = { ...status, home: localHome, pid: process.pid, owner: `${String(process.getuid?.())}@${hostname()}`, hostname: hostname(), connectedDaemon: 'auth_failed' };
    await writeFile(executable, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
for (const name of ['claude', 'codex', 'opencode']) {
  const result = spawnSync(name, [], { shell: false });
  if (!result.error || !['ENOENT', 'ENOTDIR'].includes(result.error.code)) process.exit(9);
}
process.stdout.write(${JSON.stringify(JSON.stringify(response))});
`, { mode: 0o700 });
    for (const name of ['server-id', 'cli-client-id', 'config.json', 'paseo.pid']) {
      await writeFile(join(localHome, name), name === 'paseo.pid' ? JSON.stringify({ ...pidEvidence, pid: process.pid, uid: process.getuid?.(), hostname: hostname() }) : name === 'config.json' ? '{}' : 'fixture', { mode: 0o600 });
    }
    const snapshot = async () => Promise.all(['server-id', 'cli-client-id', 'config.json', 'paseo.pid'].map(async (name) => ({ name, bytes: await readFile(join(localHome, name)), mode: (await lstat(join(localHome, name))).mode })));
    const deps = localProbeDependencies();
    const run = vi.fn((request: Parameters<ProbeDependencies['runner']['run']>[0]) => deps.runner.run(request));
    const selected = { executable, localHome, home: root, timeoutMs: 2000 };
    const before = await snapshot();
    // Prove the provider is executable when PATH resolves the controlled directory.
    await deps.runner.run({ executable: process.execPath, args: ['-e', "require('node:child_process').spawnSync('codex', [], {shell:false})"], env: { PATH: root }, shell: false, timeoutMs: 2000 });
    expect(await readFile(sentinel, 'utf8')).toBe('executed');
    await rm(sentinel);
    await expect(probePaseo(selected, { ...deps, runner: { run } }, 'synthetic-private-value')).rejects.toMatchObject({ check: { id: 'paseo.auth_failed' } });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ executable: process.execPath, args: [executable, 'daemon', 'status', '--json'], env: { PATH: '/dev/null' } });
    await expect(lstat(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await snapshot()).toEqual(before);
    console.info('controlled provider sentinel: positive control executed; auth-failure status executed none; identity/PID/config bytes and modes unchanged');
    const config = join(localHome, 'config.json');
    await chmod(config, 0o644);
    const unsafe = await snapshot();
    run.mockClear();
    await expect(probePaseo(selected, { ...deps, runner: { run } })).rejects.toMatchObject({ check: { id: 'paseo.home' } });
    expect(await snapshot()).toEqual(unsafe);
    await rm(config);
    await expect(probePaseo(selected, { ...deps, runner: { run } })).rejects.toMatchObject({ check: { id: 'paseo.home' } });
    await expect(lstat(config)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(run).not.toHaveBeenCalled();
  } finally { await rm(root, { recursive: true, force: true }); }
});
