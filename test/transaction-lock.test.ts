import * as fs from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { acquireDaemonLock, acquireRecoveryDaemonLock, daemonLockPath, systemLockProcess } from '../src/core/lock.js';
import { endpointIdentitySha256, type LocalAdmission } from '../src/paseo/cli-probe.js';

const uid = process.getuid?.() ?? -1;
async function fixture(test: (root: string, admission: LocalAdmission) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paseo-lock-test-')));
  const listen = 'ws://127.0.0.1:6767';
  const admission = { localHome: root, listen, endpointIdentitySha256: endpointIdentitySha256(root, listen),
    cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' };
  try { await test(root, admission); } finally {
    // Only this fixture's unique namespace, never the shared per-user directory.
    const lock = daemonLockPath(admission, uid);
    await fs.rm(lock, { force: true });
    await fs.rm(`${lock}.recovery.guard`, { force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}
it('normalizes aliases with a fixed /tmp key and refuses invalid admission', async () => fixture(async (_root, admission) => {
  expect(daemonLockPath(admission, uid)).toMatch(new RegExp(`^/tmp/paseo-room-${String(uid)}/daemon-[a-f0-9]{64}\\.lock$`));
  expect(daemonLockPath({ ...admission, listen: 'localhost:06767/ws/' }, uid)).toBe(daemonLockPath(admission, uid));
  expect(() => daemonLockPath({ ...admission, listen: 'wss://elsewhere' }, uid)).toThrow();
  expect(() => daemonLockPath({ ...admission, endpointIdentitySha256: '0'.repeat(64) }, uid)).toThrow();
  const lock = await acquireDaemonLock(admission);
  try {
    expect((await fs.stat(daemonLockPath(admission, uid))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`/tmp/paseo-room-${String(uid)}`)).mode & 0o777).toBe(0o700);
    await expect(acquireDaemonLock({ ...admission, listen: 'localhost:6767' })).rejects.toMatchObject({ reason: 'busy' });
  } finally { await lock.release(); }
  await expect(lock.release()).rejects.toMatchObject({ reason: 'unsafe' });
}));
it.each(['dead', 'reused', 'foreign', 'malformed', 'symlink', 'hardlink', 'mode'] as const)('retains %s lock evidence without stealing', async kind => fixture(async (root, admission) => {
  const lock = await acquireDaemonLock(admission);
  const path = daemonLockPath(admission, uid);
  const content = await fs.readFile(path, 'utf8');
  await lock.release();
  await fs.writeFile(path, content, { mode: 0o600 });
  if (kind === 'malformed') await fs.writeFile(path, '{}');
  if (kind === 'symlink') { await fs.unlink(path); await fs.writeFile(join(root, 'sentinel'), 'preserve'); await fs.symlink(join(root, 'sentinel'), path); }
  if (kind === 'hardlink') await fs.link(path, join(root, 'alias'));
  if (kind === 'mode') await fs.chmod(path, 0o644);
  const own = await systemLockProcess.evidence(process.pid);
  if (!own) throw new Error('Missing current process');
  let calls = 0;
  const processBoundary = { ...systemLockProcess, evidence: (pid: number) => {
    calls++;
    if (calls === 1) return systemLockProcess.evidence(pid);
    if (kind === 'dead') return Promise.resolve(null);
    if (kind === 'reused') return Promise.resolve({ ...own, started: 'another process' });
    if (kind === 'foreign') return Promise.resolve({ ...own, uid: uid + 1 });
    return systemLockProcess.evidence(pid);
  } };
  await expect(acquireDaemonLock(admission, processBoundary)).rejects.toMatchObject({ reason: ['dead', 'reused', 'foreign'].includes(kind) ? 'stale' : 'unsafe' });
  expect(await fs.lstat(path)).toBeDefined();
  if (kind === 'symlink') expect(await fs.readFile(join(root, 'sentinel'), 'utf8')).toBe('preserve');
}));
it('recovery alone conditionally reclaims exact stale evidence and retains live ownership', async () => fixture(async (_root, admission) => {
  const held = await acquireDaemonLock(admission);
  const path = daemonLockPath(admission, uid);
  const bytes = await fs.readFile(path);
  await held.release();
  await fs.writeFile(path, bytes, { mode: 0o600 });
  await expect(acquireRecoveryDaemonLock(admission)).rejects.toMatchObject({ reason: 'busy' });

  const own = await systemLockProcess.evidence(process.pid);
  if (!own) throw new Error('Missing current process');
  let revivedCalls = 0;
  const revivedOwner = { ...systemLockProcess, evidence: (pid: number) => {
    revivedCalls++;
    return revivedCalls === 1 || revivedCalls === 3 ? systemLockProcess.evidence(pid) : Promise.resolve(null);
  } };
  await expect(acquireRecoveryDaemonLock(admission, revivedOwner)).rejects.toMatchObject({ reason: 'busy' });
  expect(await fs.readFile(path)).toEqual(bytes);

  let calls = 0;
  const deadOwner = { ...systemLockProcess, evidence: (pid: number) => {
    calls++;
    return calls === 1 ? systemLockProcess.evidence(pid) : Promise.resolve(null);
  } };
  const recovered = await acquireRecoveryDaemonLock(admission, deadOwner);
  expect(calls).toBeGreaterThanOrEqual(3);
  expect(JSON.parse(await fs.readFile(path, 'utf8'))).toMatchObject({ pid: process.pid, started: own.started });
  await recovered.release();
}));
it('serializes simultaneous recovery reclaimers and preserves the validated guard inode', async () => fixture(async (_root, admission) => {
  const held = await acquireDaemonLock(admission);
  const path = daemonLockPath(admission, uid);
  const stale = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
  await held.release();
  stale.pid = 2_147_483_647;
  await fs.writeFile(path, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  const own = await systemLockProcess.evidence(process.pid);
  if (!own) throw new Error('Missing current process');
  const deadOwner = { ...systemLockProcess, evidence: (pid: number) =>
    Promise.resolve(pid === process.pid ? own : null) };
  const results = await Promise.allSettled([
    acquireRecoveryDaemonLock(admission, deadOwner),
    acquireRecoveryDaemonLock(admission, deadOwner),
  ]);
  const winners = results.filter((result): result is PromiseFulfilledResult<{ release(): Promise<void> }> => result.status === 'fulfilled');
  const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]?.reason).toMatchObject({ reason: 'busy' });
  const guard = `${path}.recovery.guard`;
  const before = await fs.stat(guard);
  expect(before.mode & 0o777).toBe(0o600);
  await winners[0]?.value.release();
  const after = await fs.stat(guard);
  expect({ dev: after.dev, ino: after.ino, mode: after.mode, nlink: after.nlink }).toEqual(
    { dev: before.dev, ino: before.ino, mode: before.mode, nlink: before.nlink });
}));
it('two real processes with different roots, endpoint spelling and environment paths admit one owner', async () => fixture(async (root, admission) => {
  const config = join(root, 'bundle.config.mjs');
  await fs.writeFile(config, `export default ${JSON.stringify({ entry: [resolve('src/core/lock.ts')], outDir: join(root, 'bundle'),
    format: ['esm'], platform: 'node', target: 'node22', noExternal: ['zod', 'semver'], silent: true })};`);
  await promisify(execFile)(process.execPath, [resolve('node_modules/tsup/dist/cli-default.js'), '--config', config],
    { shell: false, timeout: 15000, maxBuffer: 1024 * 1024 });
  const ready = join(root, 'holder-ready');
  const release = join(root, 'holder-release');
  const runner = `import { acquireDaemonLock } from ${JSON.stringify(join(root, 'bundle/lock.js'))};
    import * as fs from 'node:fs/promises';
    const admission = JSON.parse(process.argv[1]);
    try {
      const lock = await acquireDaemonLock(admission);
      process.stdout.write('acquired');
      if (process.argv[2] === 'holder') {
        await fs.writeFile(${JSON.stringify(ready)}, '', {flag:'wx', mode:0o600});
        while (true) { try { await fs.access(${JSON.stringify(release)}); break; } catch { await new Promise(r => setTimeout(r, 10)); } }
      }
      await lock.release();
    } catch { process.stdout.write('refused'); }`;
  const child = (index: number, role: string): { output: () => string; done: Promise<void> } => {
    let output = '';
    const subprocess = spawn(systemProcessPath(), ['--input-type=module', '--eval', runner,
      JSON.stringify({ ...admission, listen: index ? 'localhost:6767/ws' : admission.listen }), role],
    { env: { TMPDIR: join(root, `tmp-${String(index)}`), XDG_RUNTIME_DIR: join(root, `xdg-${String(index)}`) }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    subprocess.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    subprocess.stderr.resume();
    const done = new Promise<void>((resolveDone, reject) => {
      const timer = setTimeout(() => { subprocess.kill('SIGKILL'); }, 10000);
      subprocess.on('error', reject);
      subprocess.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Fixture child failed')); else resolveDone(); });
    });
    return { output: () => output, done };
  };
  const holder = child(0, 'holder');
  for (let count = 0; count < 500; count++) { try { await fs.access(ready); break; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); } }
  await fs.access(ready);
  const contender = child(1, 'contender');
  await contender.done;
  expect(contender.output()).toBe('refused');
  await fs.writeFile(release, '', { flag: 'wx', mode: 0o600 });
  await holder.done;
  expect(holder.output()).toBe('acquired');
}), 20000);
function systemProcessPath(): string { return process.execPath; }
