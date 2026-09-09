import { createPaseoClient } from '@getpaseo/client';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { commandResultSchema } from '../src/core/result.js';
import { fixtureEnvironment, snapshotFixture } from './helpers/home.js';
import { packedCodex } from './helpers/packed-codex.js';
import { removeFixtureRootAfterConfirmedTermination } from './helpers/fixture-cleanup.js';

it('macOS GUI-like packed launch: absolute prefixes and true/true/false policy', async () => {
  // Explicit platform gate, never a successful skip when invoked on another OS.
  expect(process.platform, 'This focused gate requires macOS').toBe('darwin');
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Use npm run test:macos');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo room gui ')));
  const home = join(root, 'home with spaces');
  const localHome = join(home, '.paseo');
  const canonical = join(home, '.codex');
  const room = join(home, 'room with spaces');
  const codex = join(root, 'persistent fake codex.mjs');
  const paseo = join(root, 'daemon/node_modules/@getpaseo/cli/bin/paseo');
  const log = join(root, 'launches.jsonl');
  const entry = join(root, 'node_modules/paseo-room/dist/cli/index.js');
  const setupEnv = fixtureEnvironment(root, home);
  // No inherited shell initialization, credentials, npm environment, or tool PATH.
  // The installer alone needs a known Node for Codex launcher discovery.
  const guiEnv = { HOME: home, PASEO_HOME: localHome, TMPDIR: join(root, 'tmp'), PATH: '/usr/bin:/bin' };
  const cliEnv = { ...guiEnv, PATH: `${join(root, 'bin')}:/usr/bin:/bin` };
  const fixtureCliPids = new Set<number>();
  let lockPath: string | undefined;
  let lockKey: string | undefined;
  let started = false;
  let sdk: ReturnType<typeof createPaseoClient> | undefined;
  function run(id: string, binary: string, args: string[], env: NodeJS.ProcessEnv, cwd = root, timeout = 30_000) {
    const result = spawnSync(binary, args, { cwd, env, shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    // Never include daemon stdout/stderr or SDK payloads in failure diagnostics.
    expect(result.error === undefined, `${id}: bounded completion`).toBe(true);
    expect(result.signal, `${id}: signal`).toBeNull();
    expect(result.status, `${id}: exit`).toBe(0);
    return result.stdout;
  }
  function cli(command: string, extra: string[] = []) {
    const result = spawnSync(process.execPath, [entry, command, '--json', '--non-interactive',
      '--room-home', room, '--codex-home', canonical, '--codex-bin', codex, '--paseo-bin', paseo, ...extra],
    { cwd: root, env: cliEnv, shell: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (result.pid) fixtureCliPids.add(result.pid);
    expect(result.error === undefined, `${command}: bounded completion`).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.stderr === '', `${command}: no stderr`).toBe(true);
    const parsed = commandResultSchema.parse(JSON.parse(result.stdout));
    expect(result.status, `${command}: ${parsed.outcome}; ${parsed.checks.filter(c => c.status === 'fail').map(c => c.id).join(',')}`).toBe(0);
    expect(parsed.command).toBe(command);
    return parsed;
  }
  try {
    for (const path of [localHome, canonical, join(canonical, 'skills'), join(canonical, 'plugins'), join(root, 'tmp'), join(root, 'bin')]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    for (const [name, content] of [['config.toml', 'model = "fixture"\n'], ['auth.json', '{}'], ['AGENTS.md', 'Synthetic instructions\n']] as const) {
      await writeFile(join(canonical, name), content, { mode: 0o600 });
    }
    const canonicalBefore = snapshotFixture(canonical);
    await writeFile(codex, packedCodex(log, join(root, 'rpc.jsonl'), join(root, 'unused-barrier')), { mode: 0o700 });
    await symlink(process.execPath, join(root, 'bin/node'));
    await writeFile(join(localHome, 'cli-client-id'), `cid_${randomUUID()}`, { mode: 0o600 });
    const pack: unknown = JSON.parse(run('pack', process.execPath,
      [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], setupEnv, fileURLToPath(new URL('../', import.meta.url))));
    const archive = z.union([z.tuple([z.object({ filename: z.string() })]).transform(([v]) => v),
      z.object({ 'paseo-room': z.object({ filename: z.string() }) }).transform(v => v['paseo-room'])]).parse(pack);
    run('install packed artifact', process.execPath, [npm, 'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', join(root, archive.filename)], setupEnv, root, 180_000);
    run('install pinned daemon', process.execPath, [npm, 'install', '--prefix', join(root, 'daemon'), '--ignore-scripts', '--no-audit', '--no-fund', '@getpaseo/cli@0.8.0-beta.1'], setupEnv, root, 180_000);
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('No fixture port')); return; }
        server.close(error => { if (error) reject(error); else resolve(address.port); });
      });
    });
    expect(port).not.toBe(6767);
    const ids = ['codex-supervisor', 'codex-lead', 'codex-peer'];
    lockKey = createHash('sha256').update(JSON.stringify([localHome, `ws://127.0.0.1:${String(port)}`, ids])).digest('hex');
    lockPath = `/tmp/paseo-room-${String(process.getuid?.())}/daemon-${lockKey}.lock`;
    started = true;
    run('daemon start (system-only PATH)', process.execPath, [paseo, 'daemon', 'start', '--home', localHome,
      '--listen', `127.0.0.1:${String(port)}`, '--no-relay', '--no-mcp', '--no-inject-mcp', '--no-web-ui'], guiEnv);
    sdk = createPaseoClient({ url: `ws://127.0.0.1:${String(port)}/ws`, appVersion: '0.8.0-beta.1',
      connectTimeoutMs: 5000, reconnect: { enabled: false }, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    await sdk.connect();
    expect(cli('install', ['--apply'])).toMatchObject({ outcome: 'ok', changed: true });
    expect(cli('verify').outcome).toBe('ok');
    const providers = (await sdk.config.get()).config.providers;
    const node = await realpath(process.execPath);
    for (const id of ids) {
      expect(providers[id], `${id}: absolute prefix and complete policy`).toMatchObject({
        command: [node, codex], paseoTools: { enabled: id !== 'codex-peer' },
      });
      expect(providers[id]?.paseoTools).toEqual({ enabled: id !== 'codex-peer' });
      const agent = await sdk.agents.create({ config: { provider: `${id}/fixture`, thinkingOptionId: 'medium' }, cwd: root, title: 'GUI fixture' });
      try { expect(await agent.run('Synthetic turn only.', { timeoutMs: 10_000 })).toMatchObject({ status: 'idle', error: null }); }
      finally { await agent.archive(); }
    }
    const launches = z.array(z.object({ argv: z.array(z.string()), home: z.string() }))
      .parse((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown));
    for (const id of ids) expect(launches, `${id}: observed app-server launch`).toContainEqual(expect.objectContaining({
      home: join(room, 'roles/codex', id.replace('codex-', '')), argv: [node, codex, 'app-server', '--enable', 'goals'],
    }));
    expect(snapshotFixture(canonical)).toEqual(canonicalBefore);
    await sdk.close(); sdk = undefined;
    // Fake Codex creates no mutable role state; remove the room through the packed CLI.
    expect(cli('uninstall', ['--apply']).outcome).toBe('ok');
    expect(snapshotFixture(room)).toBeNull();
  } finally {
    const failures: string[] = [];
    const cleanup = async (id: string, action: () => void | Promise<void>): Promise<boolean> => {
      try { await action(); return true; } catch { failures.push(id); return false; }
    };
    const connected = sdk;
    if (connected) await cleanup('SDK close', () => connected.close());
    if (started) {
      await cleanup('fixture daemon stop', () => { run('daemon stop', process.execPath, [paseo, 'daemon', 'stop', '--home', localHome], guiEnv); });
      await cleanup('fixture daemon stopped', () => {
        expect(JSON.parse(run('daemon status', process.execPath, [paseo, 'daemon', 'status', '--json'], guiEnv)))
          .toMatchObject({ home: localHome, localDaemon: 'stopped' });
      });
    }
    await cleanup('fixture fake processes reaped', async () => {
      const lines = await readFile(log, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error;
      });
      for (const line of lines.trim().split('\n').filter(Boolean)) {
        const { pid } = z.object({ pid: z.number().int().positive() }).parse(JSON.parse(line));
        await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true; throw error;
        } }, { timeout: 10_000 }).toBe(true);
      }
    });
    await cleanup('fixture namespace lock', async () => {
      if (!lockPath) return;
      const stat = await lstat(lockPath).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error;
      });
      if (!stat) return;
      expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600).toBe(true);
      const record = z.object({ pid: z.number().int().positive(), uid: z.number().int(), key: z.string() }).parse(JSON.parse(await readFile(lockPath, 'utf8')));
      expect(record).toMatchObject({ uid: process.getuid?.(), key: lockKey });
      expect(fixtureCliPids.has(record.pid)).toBe(true);
      try { process.kill(record.pid, 0); throw new Error('Fixture lock owner still live'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      await rm(lockPath);
    });
    const terminationConfirmed = failures.length === 0;
    const removed = await removeFixtureRootAfterConfirmedTermination(terminationConfirmed,
      () => rm(root, { recursive: true, force: true }));
    if (!removed) failures.push('private fixture preserved because termination was not confirmed');
    expect(failures, 'GUI smoke cleanup failures (sanitized check IDs)').toEqual([]);
  }
});
