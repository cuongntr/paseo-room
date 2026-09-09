import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { MANAGED_PROVIDER_IDS } from '../room/roles.js';
import { normalizeListen, endpointIdentitySha256, type LocalAdmission } from '../paseo/cli-probe.js';
import { canonicalJson, sha256 } from './hash.js';
import { TransactionFilesystem, runTransactionChild } from './transaction-fs.js';

export interface ProcessEvidence { readonly uid: number; readonly started: string }
export interface LockProcess {
  readonly uid: number;
  readonly pid: number;
  evidence(pid: number): Promise<ProcessEvidence | null>;
}
export const systemLockProcess: LockProcess = {
  uid: process.getuid?.() ?? -1, pid: process.pid,
  async evidence(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid lock PID.');
    try {
      const { stdout } = await promisify(execFile)('/bin/ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(pid)],
        { shell: false, timeout: 5000, maxBuffer: 4096, env: { LC_ALL: 'C' } });
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(stdout);
      if (!match?.[1] || !match[2]) throw new Error('Ambiguous process evidence.');
      return { uid: Number(match[1]), started: match[2] };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 1) return null;
      throw new Error('Cannot validate lock process.', { cause: error });
    }
  },
};
export class LockError extends Error {
  constructor(readonly reason: 'busy' | 'stale' | 'unsafe') {
    super(reason === 'stale' ? 'Stale lock retained; explicit recovery is required.' : 'Daemon namespace lock unavailable.');
  }
}
const ownerSchema = z.strictObject({ schemaVersion: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/),
  pid: z.number().int().positive(), uid: z.number().int().nonnegative(), started: z.string().min(1) });
export function daemonLockPath(admission: LocalAdmission, uid: number): string {
  if (!Number.isSafeInteger(uid) || uid < 0 || resolve(admission.localHome) !== admission.localHome ||
      admission.localHome === '/' || /[\\\p{Cc}]/u.test(admission.localHome) ||
      endpointIdentitySha256(admission.localHome, normalizeListen(admission.listen)) !== admission.endpointIdentitySha256) throw new LockError('unsafe');
  const key = sha256(canonicalJson([admission.localHome, normalizeListen(admission.listen), MANAGED_PROVIDER_IDS]));
  return `/tmp/paseo-room-${String(uid)}/daemon-${key}.lock`;
}
async function acquireRecoveryGuard(path: string, disk: TransactionFilesystem): Promise<{ release(): Promise<void> }> {
  const expected = { kind: 'file' as const, mode: 0o600 as const, sha256: sha256('') };
  try { await disk.file(path, Buffer.alloc(0)); } catch {
    if (canonicalJson(await disk.inspect(path)) !== canonicalJson(expected)) throw new LockError('unsafe');
  }
  const executable = process.platform === 'darwin' ? '/usr/bin/lockf'
    : await fs.access('/usr/bin/flock').then(() => '/usr/bin/flock').catch(() => '/bin/flock');
  await fs.access(executable).catch(() => { throw new LockError('unsafe'); });
  const script = "if ('PASEO_PASSWORD' in process.env || 'NODE_OPTIONS' in process.env) process.exit(70); process.stdout.write('ready\\n'); process.stdin.resume();";
  const args = process.platform === 'darwin' ? ['-k', '-n', '-t', '0', path, process.execPath, '--input-type=module', '--eval', script]
    : ['-n', '-F', path, process.execPath, '--input-type=module', '--eval', script];
  const child = spawn(executable, args, { env: {}, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  const completion = new Promise<number | null>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion);
    child.once('close', (code, signal) => { resolveCompletion(signal ? null : code); });
  });
  let readyTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolveReady, rejectReady) => {
        child.stdout.once('data', (value: Buffer) => {
          if (value.toString() === 'ready\n') resolveReady(); else rejectReady(new LockError('unsafe'));
        });
      }),
      completion.then(() => { throw new LockError('busy'); }),
      new Promise<never>((_resolve, rejectTimeout) => {
        readyTimer = setTimeout(() => { child.kill('SIGKILL'); rejectTimeout(new LockError('unsafe')); }, 5000);
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally { if (readyTimer) clearTimeout(readyTimer); }
  let released = false;
  return { async release() {
    if (released) throw new LockError('unsafe');
    released = true;
    child.stdin.end();
    let releaseTimer: NodeJS.Timeout | undefined;
    try {
      const code = await Promise.race([completion, new Promise<never>((_resolve, rejectTimeout) => {
        releaseTimer = setTimeout(() => { child.kill('SIGKILL'); rejectTimeout(new LockError('unsafe')); }, 5000);
      })]);
      if (code !== 0) throw new LockError('unsafe');
    } finally { if (releaseTimer) clearTimeout(releaseTimer); }
  } };
}

/** Normal mutation never deletes stale evidence. Explicit recovery may reclaim only
 * a validated exact stale record after a second process-identity check. */
async function acquire(admission: LocalAdmission, owner: LockProcess, reclaimStale: boolean): Promise<{ release(): Promise<void> }> {
  const logical = daemonLockPath(admission, owner.uid);
  if (await fs.realpath(admission.localHome) !== admission.localHome) throw new LockError('unsafe');
  const temp = await fs.realpath('/tmp');
  if (temp !== (process.platform === 'darwin' ? '/private/tmp' : '/tmp')) throw new LockError('unsafe');
  const stat = await fs.lstat(temp);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o1777) !== 0o1777) throw new LockError('unsafe');
  const name = `paseo-room-${String(owner.uid)}`;
  // Bootstrap under a held cwd; never chmod/adopt a pre-existing directory.
  await runTransactionChild({ cwd: temp, input: '', script: `
    import * as fs from 'node:fs/promises'; import { constants } from 'node:fs';
    const s = await fs.stat('.');
    if (s.dev !== ${String(stat.dev)} || s.ino !== ${String(stat.ino)} || s.uid !== 0 || s.mode !== ${String(stat.mode)}) process.exit(1);
    try { await fs.mkdir(${JSON.stringify(name)}, {mode: 0o700}); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    const d = await fs.lstat(${JSON.stringify(name)});
    if (!d.isDirectory() || d.uid !== ${String(owner.uid)} || (d.mode & 0o7777) !== 0o700) process.exit(1);
    const h = await fs.open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await h.sync(); } finally { await h.close(); }
    process.stdout.write('{}');` });
  const root = join(temp, name);
  const disk = new TransactionFilesystem({ roomHome: root, uid: owner.uid });
  const path = join(root, logical.slice(logical.lastIndexOf('/') + 1));
  const evidence = await owner.evidence(owner.pid);
  if (!evidence || evidence.uid !== owner.uid) throw new LockError('unsafe');
  const key = logical.slice(logical.lastIndexOf('daemon-') + 7, -5);
  const bytes = Buffer.from(canonicalJson(ownerSchema.parse({ schemaVersion: 1, key, pid: owner.pid, ...evidence })) + '\n');
  const expected = { kind: 'file' as const, mode: 0o600 as const, sha256: sha256(bytes) };
  try {
    await disk.file(path, bytes);
  } catch {
    if (!reclaimStale) {
      try {
        const current = await disk.inspect(path);
        const record = ownerSchema.parse(JSON.parse((await disk.read(path, current)).toString('utf8')) as unknown);
        if (record.uid !== owner.uid || record.key !== key) throw new LockError('unsafe');
        const live = await owner.evidence(record.pid);
        throw new LockError(live && live.uid === record.uid && live.started === record.started ? 'busy' : 'stale');
      } catch (error) { if (error instanceof LockError) throw error; throw new LockError('unsafe'); }
    }
    const guard = await acquireRecoveryGuard(`${path}.recovery.guard`, disk);
    try {
      try { await disk.file(path, bytes); }
      catch {
        const current = await disk.inspect(path);
        const record = ownerSchema.parse(JSON.parse((await disk.read(path, current)).toString('utf8')) as unknown);
        if (record.uid !== owner.uid || record.key !== key) throw new LockError('unsafe');
        const live = await owner.evidence(record.pid);
        if (live && live.uid === record.uid && live.started === record.started) throw new LockError('busy');
        const rechecked = await owner.evidence(record.pid);
        if (rechecked && rechecked.uid === record.uid && rechecked.started === record.started) throw new LockError('busy');
        await disk.perform(path, { action: 'remove', expected: current });
        await disk.file(path, bytes);
      }
    } catch (error) {
      if (error instanceof LockError) throw error;
      try {
        const current = await disk.inspect(path);
        if (canonicalJson(current) === canonicalJson(expected)) throw new LockError('busy');
      } catch (nested) { if (nested instanceof LockError) throw nested; }
      throw new LockError('unsafe');
    } finally { await guard.release(); }
  }
  let released = false;
  return { async release() {
    if (released) throw new LockError('unsafe');
    await disk.perform(path, { action: 'remove', expected });
    released = true;
  } };
}

export function acquireDaemonLock(admission: LocalAdmission, owner: LockProcess = systemLockProcess): Promise<{ release(): Promise<void> }> {
  return acquire(admission, owner, false);
}

export function acquireRecoveryDaemonLock(admission: LocalAdmission, owner: LockProcess = systemLockProcess): Promise<{ release(): Promise<void> }> {
  return acquire(admission, owner, true);
}
