import { createPaseoClient } from '@getpaseo/client';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, writeFile, readFile, rm, access, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { commandResultSchema } from '../src/core/result.js';
import { fixtureEnvironment, snapshotFixture } from './helpers/home.js';
import { packedCodex } from './helpers/packed-codex.js';
import { connectFixturePaseo, waitForFixturePaseo } from './helpers/paseo-sdk.js';

it('packed CLI: disposable lifecycle, persistent launches, drift, recovery and ownership', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-packed-')));
  const home = join(root, 'home');
  const localHome = join(home, '.paseo');
  const canonical = join(home, '.codex');
  const room = join(home, 'room with spaces');
  const installation = join(root, 'artifact');
  const cache = join(root, 'npm-cache');
  const log = join(root, 'launches.jsonl');
  const barrier = join(root, 'pause-discovery');
  const codex = join(root, 'persistent codex.mjs');
  const paseo = join(root, 'daemon/node_modules/@getpaseo/cli/bin/paseo');
  const env = { ...fixtureEnvironment(root, home), PATH: `${join(root, 'bin')}:/usr/bin:/bin` };
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('Use npm run test:package');
  // Diagnostics deliberately exclude raw process output and SDK payloads.
  function run(binary: string, args: string[], cwd = root, timeout = 30_000) {
    const result = spawnSync(binary, args, { cwd, env, shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });
    expect(result.error === undefined, 'subprocess completed within its bound').toBe(true);
    expect(result.signal).toBeNull();
    expect(result.status, 'fixture subprocess exit').toBe(0);
    return result.stdout;
  }
  const entry = join(installation, 'package/dist/cli/index.js');
  const args = (command: string, extra: string[] = []) => [entry, command, '--json', '--non-interactive',
    '--room-home', room, '--codex-home', canonical, '--codex-bin', codex, '--paseo-bin', paseo, ...extra];
  function cli(command: string, expected = 0, extra: string[] = []) {
    const result = spawnSync(process.execPath, args(command, extra), { cwd: root, env, shell: false,
      encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (result.pid) fixtureCliPids.add(result.pid);
    expect(result.error === undefined, `${command}: bounded completion`).toBe(true);
    expect(result.signal).toBeNull();
    expect(result.stderr === '', `${command}: no stderr`).toBe(true);
    const parsed = commandResultSchema.parse(JSON.parse(result.stdout));
    expect(result.status, `${command}: ${parsed.outcome}; ${parsed.checks.filter(c => c.status === 'fail').map(c => c.id).join(',')}`).toBe(expected);
    expect(parsed.command).toBe(command);
    return parsed;
  }
  function packedDefaultPlan() {
    const result = spawnSync(process.execPath, [entry, 'install', '--json', '--non-interactive',
      '--room-home', room, '--codex-home', canonical, '--codex-bin', codex, '--paseo-bin', paseo],
      { cwd: root, env, shell: false, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
    if (result.pid) fixtureCliPids.add(result.pid);
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    const parsed = commandResultSchema.parse(JSON.parse(result.stdout));
    expect(result.status, `${parsed.outcome}; ${parsed.checks.filter(check => check.status === 'fail').map(check => check.id).join(',')}`).toBe(0);
    return parsed;
  }
  let started = false;
  let crashPid: number | undefined;
  let lockPath: string | undefined;
  let recoveryGuardPath: string | undefined;
  let lockKey: string | undefined;
  let sdk: ReturnType<typeof createPaseoClient> | undefined;
  const fixtureCliPids = new Set<number>();
  try {
    for (const path of [localHome, canonical, join(canonical, 'skills'), join(canonical, 'plugins'), join(home, '.local/share'), join(root, 'tmp'), join(root, 'bin'), installation]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    for (const [name, content] of [['config.toml', 'model = "fixture"\n'], ['auth.json', '{}'], ['AGENTS.md', 'Synthetic instructions\n']] as const) {
      await writeFile(join(canonical, name), content, { mode: 0o600 });
    }
    await writeFile(codex, packedCodex(log, join(root, 'rpc.jsonl'), barrier), { mode: 0o700 });
    await symlink(process.execPath, join(root, 'bin/node'));
    await symlink(codex, join(root, 'bin/codex'));
    const unrelated = { extends: 'codex', label: 'Unrelated', enabled: false };
    await writeFile(join(localHome, 'cli-client-id'), `cid_${randomUUID()}`, { mode: 0o600 });
    await writeFile(join(localHome, 'config.json'), JSON.stringify({ agents: { providers: { unrelated } } }), { mode: 0o600 });
    const pack = JSON.parse(run(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', root], repository)) as unknown;
    const archive = z.union([z.tuple([z.object({ filename: z.string() })]).transform(([v]) => v),
      z.object({ 'paseo-room': z.object({ filename: z.string() }) }).transform(v => v['paseo-room'])]).parse(pack);
    const tarball = join(root, archive.filename);
    const extract = () => run('/usr/bin/tar', ['-xf', tarball, '-C', installation]);
    extract();
    // Install artifact dependencies once, outside the deletable artifact/cache tree.
    run(process.execPath, [npm, 'install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', tarball], root, 180_000);
    run(process.execPath, [npm, 'install', '--prefix', join(root, 'daemon'), '--ignore-scripts', '--no-audit', '--no-fund', '@getpaseo/cli@0.8.0-beta.1'], root, 180_000);
    await symlink(paseo, join(root, 'bin/paseo'));
    const port = await new Promise<number>((resolve, reject) => {
      const server = createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { server.close(); reject(new Error('No fixture port')); return; }
        server.close(error => { if (error) reject(error); else resolve(address.port); });
      });
    });
    expect(port).not.toBe(6767);
    lockKey = createHash('sha256').update(JSON.stringify([localHome, `ws://127.0.0.1:${String(port)}`, ['codex-supervisor', 'codex-lead', 'codex-peer']])).digest('hex');
    lockPath = `/tmp/paseo-room-${String(process.getuid?.())}/daemon-${lockKey}.lock`;
    recoveryGuardPath = `${lockPath}.recovery.guard`;
    started = true;
    run(paseo, ['daemon', 'start', '--home', localHome, '--listen', `127.0.0.1:${String(port)}`, '--no-relay', '--no-mcp', '--no-inject-mcp', '--no-web-ui']);
    await waitForFixturePaseo(`ws://127.0.0.1:${String(port)}/ws`);
    const defaultRoom = join(home, '.local/share/paseo-room');
    expect(snapshotFixture(defaultRoom)).toBeNull();
    expect(snapshotFixture(join(home, '.local/share', `.paseo-room-bootstrap-${createHash('sha256').update(defaultRoom).digest('hex')}.json`))).toBeNull();
    const defaultPlan = packedDefaultPlan();
    const wizardRoomBefore = snapshotFixture(room);
    const wizardCanonicalBefore = snapshotFixture(canonical);
    const wizardConfigBefore = await readFile(join(localHome, 'config.json'));
    const pty = `set timeout 120\nlog_user 1\nset stty_init {rows 40 columns 240}\nspawn $env(WIZARD_NODE) $env(WIZARD_ENTRY)\nset send_slow {1 .001}\nforeach {marker answer} [list {Managed room home} $env(WIZARD_ROOM) {Canonical Codex home} $env(WIZARD_CODEX_HOME) {Codex executable} $env(WIZARD_CODEX) {Paseo executable} $env(WIZARD_PASEO) {Local Paseo WebSocket URL} {}] { expect -- $marker; after 250; send -s -- $answer; after 100; send -- "\\r" }\nexpect -- {Apply this Codex room setup?}\nafter 250\nsend -- "n"\nexpect eof\nset result [wait]\nexit [lindex $result 3]\n`;
    const wizard = spawnSync('/usr/bin/expect', ['-c', pty], { cwd: root,
      env: { ...env, COLUMNS: '240', WIZARD_NODE: process.execPath, WIZARD_ENTRY: entry, WIZARD_ROOM: room,
        WIZARD_CODEX_HOME: canonical, WIZARD_CODEX: codex, WIZARD_PASEO: paseo }, shell: false,
      encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024 });
    const transcript = `${wizard.stdout}${wizard.stderr}`.replaceAll('\r', '');
    expect(wizard.error, transcript.replaceAll(/[\p{Cc}]/gu, '')).toBeUndefined(); expect(wizard.signal).toBeNull();
    expect(wizard.status, transcript.replaceAll(/[\p{Cc}]/gu, '')).toBe(0);
    expect(transcript).toContain(`install: ${defaultPlan.outcome} (changed: no)`);
    const expectedOperations = defaultPlan.operations.map(operation => {
      const target = operation.target.kind === 'provider' ? operation.target.id : operation.target.path;
      return `${operation.action} ${operation.target.kind} ${target}: ${operation.description}`;
    });
    const operationPrefixes = ['create ', 'update ', 'remove '];
    const actualOperations = transcript.split('\n').map(line => {
      const offsets = operationPrefixes.map(prefix => line.indexOf(prefix)).filter(offset => offset >= 0);
      return offsets.length === 0 ? '' : line.slice(Math.min(...offsets));
    }).filter(line => /^(?:create|update|remove) (?:directory|file|symlink|provider) /.test(line));
    expect(actualOperations).toEqual(expectedOperations);
    expect(transcript).toContain('Setup cancelled; no changes made.');
    expect(snapshotFixture(room)).toEqual(wizardRoomBefore);
    expect(snapshotFixture(canonical)).toEqual(wizardCanonicalBefore);
    expect(await readFile(join(localHome, 'config.json'))).toEqual(wizardConfigBefore);
    const canonicalBefore = snapshotFixture(canonical);
    const configBefore = await readFile(join(localHome, 'config.json'));
    const managedBefore = snapshotFixture(room);
    const authorityNames = ['config.json', 'paseo.pid', 'server-id', 'cli-client-id'];
    const authorityBefore = await Promise.all(authorityNames.map(name => readFile(join(localHome, name))));
    const plan = cli('plan');
    expect(plan.outcome).toBe('changes-planned');
    expect(cli('install').operations).toEqual(plan.operations);
    expect(snapshotFixture(room)).toEqual(managedBefore);
    expect(snapshotFixture(canonical)).toEqual(canonicalBefore);
    expect(await Promise.all(authorityNames.map(name => readFile(join(localHome, name))))).toEqual(authorityBefore);
    expect(cli('install', 0, ['--apply'])).toMatchObject({ outcome: 'ok', changed: true });
    for (const command of ['verify', 'doctor']) expect(cli(command).outcome).toBe('ok');
    const installedBefore = snapshotFixture(room);
    expect(cli('install', 0, ['--apply'])).toMatchObject({ outcome: 'ok', changed: false, operations: [] });
    expect(snapshotFixture(room)).toEqual(installedBefore);
    sdk = await connectFixturePaseo(`ws://127.0.0.1:${String(port)}/ws`);
    const providers = (await sdk.config.get()).config.providers;
    const ids = ['codex-supervisor', 'codex-lead', 'codex-peer'];
    for (const id of ids) expect(providers[id]).toMatchObject({ command: [await realpath(process.execPath), codex], paseoTools: { enabled: id !== 'codex-peer' } });
    await rm(installation, { recursive: true });
    await rm(join(root, 'node_modules/paseo-room'), { recursive: true });
    await rm(cache, { recursive: true, force: true });
    for (const id of ids) {
      const agent = await sdk.agents.create({ config: { provider: `${id}/fixture`, thinkingOptionId: 'medium' }, cwd: root, title: 'Packed fixture' });
      try { expect(await agent.run('Synthetic turn only.', { timeoutMs: 10_000 })).toMatchObject({ status: 'idle', error: null }); }
      finally { await agent.archive(); }
    }
    const launches = z.array(z.object({ argv: z.array(z.string()), home: z.string() })).parse((await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown));
    for (const id of ids) expect(launches).toContainEqual(expect.objectContaining({ home: join(room, 'roles/codex', id.replace('codex-', '')), argv: [await realpath(process.execPath), codex, 'app-server', '--enable', 'goals'] }));
    expect(launches.every(v => v.argv.every(arg => !arg.includes(installation) && !arg.includes(cache) && !arg.includes('node_modules/paseo-room')))).toBe(true);
    await sdk.close(); sdk = undefined;
    await mkdir(installation); extract();
    await writeFile(join(canonical, 'config.toml'), 'model = "fixture"\nfixture_setting = "updated"\n', { mode: 0o600 });
    const canonicalUpdated = snapshotFixture(canonical);
    expect(cli('doctor', 1).checks).toContainEqual(expect.objectContaining({ id: 'drift.source.canonicalConfigSha256', status: 'fail' }));
    expect(cli('install', 0, ['--apply']).changed).toBe(true);
    expect(cli('verify').outcome).toBe('ok');
    expect(cli('recover')).toMatchObject({ outcome: 'ok', changed: false });
    // Full removal first proves empty managed roots are removed, before customization.
    expect(cli('uninstall', 0, ['--apply'])).toMatchObject({ outcome: 'ok', changed: true });
    expect(snapshotFixture(room)).toBeNull();
    expect(JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'))).toEqual(JSON.parse(configBefore.toString()));

    expect(cli('install', 0, ['--apply']).outcome).toBe('ok');
    const custom = join(room, 'roles/codex/peer/config.toml');
    const original = await readFile(custom);
    await writeFile(custom, '# customized fixture\n', { mode: 0o600 });
    const mutable = join(room, 'roles/codex/peer/user-note');
    await writeFile(mutable, 'unrelated mutable state', { mode: 0o600 });
    expect(cli('install', 3, ['--apply']).outcome).toBe('conflict');
    expect(cli('uninstall', 3, ['--apply'])).toMatchObject({ outcome: 'conflict', changed: true });
    expect(await readFile(custom, 'utf8')).toBe('# customized fixture\n');
    expect(await readFile(mutable, 'utf8')).toBe('unrelated mutable state');
    expect(JSON.parse(await readFile(join(room, 'manifest.json'), 'utf8'))).toMatchObject({ status: 'uninstall-incomplete' });
    expect(JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'))).toEqual({ agents: { providers: { unrelated } } });
    // Explicit fixture-owner reconciliation, never a force-delete CLI option.
    await writeFile(custom, original, { mode: 0o600 }); await rm(mutable);
    expect(cli('uninstall', 0, ['--apply']).outcome).toBe('ok');
    expect(snapshotFixture(room)).toBeNull();
    expect(snapshotFixture(canonical)).toEqual(canonicalUpdated);
    expect(JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'))).toEqual(JSON.parse(configBefore.toString()));
    cli('plan', 2, ['--unknown-option']);
    // Pause real daemon discovery after the packed installer publishes providers.
    // No source imports, loader hooks, or fabricated journals are used for the crash.
    await writeFile(barrier, 'pause');
    const child = spawn(process.execPath, args('install', ['--apply']), { cwd: root, env, shell: false, stdio: 'ignore' });
    crashPid = child.pid;
    const exited = new Promise<void>(resolve => child.once('exit', () => { resolve(); }));
    try {
      await expect.poll(async () => { try { await access(`${barrier}.reached`); return true; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    } finally {
      child.kill('SIGKILL'); await exited;
      await rm(barrier, { force: true });
    }
    expect(cli('install', 4, ['--apply']).outcome).toBe('recovery-required');
    const crashed = snapshotFixture(room);
    expect(cli('recover').outcome).toBe('changes-planned');
    expect(snapshotFixture(room)).toEqual(crashed);
    expect(cli('recover', 0, ['--apply'])).toMatchObject({ outcome: 'ok', changed: true });
    expect(snapshotFixture(room)).toBeNull();
    expect(JSON.parse(await readFile(join(localHome, 'config.json'), 'utf8'))).toEqual(JSON.parse(configBefore.toString()));
    expect(snapshotFixture(canonical)).toEqual(canonicalUpdated);
    expect(cli('recover', 0, ['--apply'])).toMatchObject({ outcome: 'ok', changed: false });
    if (lockPath) await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });

  } finally {
    const cleanupErrors: unknown[] = [];
    const cleanup = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    };
    const connected = sdk;
    if (connected) await cleanup(() => connected.close());
    if (started) {
      await cleanup(() => { run(paseo, ['daemon', 'stop', '--home', localHome]); });
      await cleanup(() => {
        expect(JSON.parse(run(paseo, ['daemon', 'status', '--json']))).toMatchObject({ home: localHome, localDaemon: 'stopped' });
      });
    }
    await cleanup(async () => {
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
    // On failure, clean only this fixture namespace's exact known dead CLI owner;
    // never remove a live, foreign, linked, malformed, or differently-keyed lock.
    await cleanup(async () => {
      if (!lockPath || crashPid === undefined) return;
      const stat = await lstat(lockPath).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error;
      });
      if (!stat) return;
      expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600).toBe(true);
      const record = z.object({ pid: z.number().int().positive(), uid: z.number().int(), key: z.string() })
        .parse(JSON.parse(await readFile(lockPath, 'utf8')));
      expect(record).toMatchObject({ uid: process.getuid?.(), key: lockKey });
      expect(record.pid === crashPid || fixtureCliPids.has(record.pid)).toBe(true);
      try { process.kill(record.pid, 0); throw new Error('Fixture lock owner is still live.'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      await rm(lockPath);
    });
    await cleanup(async () => {
      if (!recoveryGuardPath) return;
      const stat = await lstat(recoveryGuardPath).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error;
      });
      if (!stat) return;
      expect(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600).toBe(true);
      expect(await readFile(recoveryGuardPath)).toEqual(Buffer.alloc(0));
      await rm(recoveryGuardPath);
    });
    await cleanup(() => rm(root, { recursive: true, force: true }));
    expect(cleanupErrors, 'Packed fixture cleanup failures').toEqual([]);
  }
}, 600_000);
