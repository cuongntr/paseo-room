import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { containsPath } from './paths.js';
import { sha256 } from './hash.js';

/** Independent room-path discovery; no path component comes from sidecar bytes. */
export function bootstrapSidecarPath(roomHome: string): string {
  return join(dirname(roomHome), `.paseo-room-bootstrap-${sha256(roomHome)}.json`);
}

export type FileValue =
  | { kind: 'absent' }
  | { kind: 'file'; mode: 0o600; sha256: string }
  | { kind: 'symlink'; mode: number; target: string }
  | { kind: 'directory'; mode: 0o700 };
export interface Identity { device: number; inode: number }
export interface TransactionFilesystemContext {
  readonly roomHome: string;
  readonly uid: number;
  readonly forbiddenFilePaths?: readonly string[];
  readonly forbiddenFileIdentities?: readonly Identity[];
}
export type TransactionBoundary = 'before-journal' | 'after-journal' | 'before-mutation' | 'after-mutation'
  | 'before-fsync' | 'after-fsync' | 'before-rename' | 'after-rename'
  | 'before-action' | 'after-action' | 'before-cleanup' | 'after-cleanup' | 'before-compensation' | 'after-compensation';
/** Events contain paths/operation identifiers only, never bytes, hashes or targets. */
export type TransactionFault = (boundary: TransactionBoundary, path: string) => void | Promise<void>;
export interface Metadata extends Identity { mode: number; uid: number; links: number; kind: string }
interface Request {
  name: string; parent: Metadata; uid: number; forbidden: readonly Identity[]; reserved: boolean;
  action: 'inspect' | 'read' | 'file' | 'link' | 'directory' | 'remove' | 'rename' | 'sync' | 'sync-file' | 'entries' | 'capture' | 'publish' | 'reconcile' | 'inspect-publication';
  expected?: FileValue; content?: string; target?: string; linkMode?: number; source?: string; sourceExpected?: FileValue; nonFile?: boolean;
}
interface Reply { parent?: Metadata; value: FileValue; content?: string; entries?: string[] }
export interface TransactionChildInput { readonly cwd: string; readonly script: string; readonly input: string }
export type TransactionChildRunner = (input: TransactionChildInput) => Promise<string>;

/* The child has an OS-held cwd, not a pathname used again after validation.
 * This is the portable Node 22 equivalent of directory-relative operations. Never
 * chdir the host process. NONBLOCK + NOFOLLOW + fstat precede every byte read.
 * Like the existing guarded hasher, this cannot snapshot concurrent writes to an
 * already-open inode. Lifecycle callers must serialize their own writers. */
async function anchoredOperation(request: Request, io: typeof import('node:fs/promises'),
  constants: typeof import('node:fs').constants, createHash: typeof import('node:crypto').createHash): Promise<Reply> {
  const metadata = (s: import('node:fs').Stats): Metadata => ({ device: s.dev, inode: s.ino, mode: s.mode,
    uid: s.uid, links: s.nlink, kind: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other' });
  const same = (a: Metadata, b: Metadata): boolean => a.device === b.device && a.inode === b.inode &&
    a.mode === b.mode && a.uid === b.uid && a.kind === b.kind && a.links === b.links;
  const nameSafe = (name: string): boolean => !!name && name !== '.' && name !== '..' && !/[\\/\p{Cc}]/u.test(name);
  if (!nameSafe(request.name) || (request.source !== undefined && !nameSafe(request.source))) throw new Error();
  const parent = metadata(await io.stat('.'));
  if (parent.kind !== 'directory' || !same(parent, request.parent)) throw new Error();
  // Test runners may replace this no-op to crash/race INSIDE an anchored action.
  const checkpoint = (point: string): Promise<void> => Promise.resolve(point).then(() => {});
  const syncParent = async (): Promise<void> => {
    const handle = await io.open('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const held = metadata(await handle.stat());
      if (held.device !== parent.device || held.inode !== parent.inode || held.uid !== parent.uid || held.mode !== parent.mode) throw new Error();
      await checkpoint('before-parent-sync');
      await handle.sync();
      await checkpoint('after-parent-sync');
    } finally { await handle.close(); }
  };
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const inspect = async (name: string, bytes = false, linked = false): Promise<Reply> => {
    let stat: import('node:fs').Stats;
    try { stat = await io.lstat(name); } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { value: { kind: 'absent' } };
      throw error;
    }
    const before = metadata(stat);
    if (before.uid !== request.uid) throw new Error();
    if (stat.isSymbolicLink()) {
      if (stat.nlink !== 1 || (stat.mode & 0o7000) !== 0) throw new Error();
      const target = await io.readlink(name);
      if (!same(before, metadata(await io.lstat(name)))) throw new Error();
      return { value: { kind: 'symlink', mode: stat.mode & 0o777, target } };
    }
    if (stat.isDirectory()) {
      if ((stat.mode & 0o7777) !== 0o700) throw new Error();
      return { value: { kind: 'directory', mode: 0o700 } };
    }
    if (!stat.isFile() || stat.nlink !== (linked ? 2 : 1) || (stat.mode & 0o7777) !== 0o600 || request.reserved || request.nonFile ||
        request.forbidden.some(id => id.device === stat.dev && id.inode === stat.ino)) throw new Error();
    const handle = await io.open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = metadata(await handle.stat());
      if (!same(before, opened) || request.forbidden.some(id => id.device === opened.device && id.inode === opened.inode)) throw new Error();
      const content = await handle.readFile();
      if (!same(opened, metadata(await handle.stat())) || !same(opened, metadata(await io.lstat(name)))) throw new Error();
      const value: FileValue = { kind: 'file', mode: 0o600, sha256: digest(content) };
      if (request.action === 'sync-file' || request.action === 'publish' || request.action === 'reconcile') {
        const expected = request.action === 'sync-file' ? request.expected : request.sourceExpected;
        if (!expected || expected.kind !== 'file' || !equal(value, expected)) throw new Error();
        await handle.sync();
      }
      return { value, ...(bytes ? { content: content.toString('base64') } : {}) };
    } finally { await handle.close(); }
  };
  const equal = (a: FileValue, b: FileValue): boolean => a.kind === b.kind &&
    (a.kind === 'absent' || (b.kind !== 'absent' && a.mode === b.mode &&
      (a.kind !== 'file' || (b.kind === 'file' && a.sha256 === b.sha256)) &&
      (a.kind !== 'symlink' || (b.kind === 'symlink' && a.target === b.target))));
  if (request.action === 'sync') {
    if (request.expected && !equal((await inspect(request.name)).value, request.expected)) throw new Error();
    await syncParent(); return { value: { kind: 'absent' }, parent: metadata(await io.stat('.')) };
  }
  if (request.action === 'capture') {
    if (!request.source || !request.sourceExpected || (await inspect(request.name)).value.kind !== 'absent') throw new Error();
    // Destination is NOT unlinked following a precheck. A raced value is captured,
    // synced and then validated; mismatch remains intact as recovery evidence.
    await io.rename(request.source, request.name);
    await checkpoint('after-capture');
    await syncParent();
    if (request.sourceExpected.kind !== 'file' && (await io.lstat(request.name)).isFile()) throw new Error();
    const captured = await inspect(request.name);
    if (!equal(captured.value, request.sourceExpected) || captured.value.kind === 'directory' && (await io.readdir(request.name)).length !== 0) throw new Error();
    return captured;
  }
  if (request.action === 'inspect-publication') {
    if (!request.source || request.sourceExpected?.kind !== 'file') throw new Error();
    const source = await io.lstat(request.source);
    const destination = await io.lstat(request.name);
    if (source.dev !== destination.dev || source.ino !== destination.ino || source.nlink !== 2) throw new Error();
    const result = await inspect(request.name, true, true);
    if (!equal(result.value, request.sourceExpected)) throw new Error();
    return result;
  }
  if (request.action === 'publish' || request.action === 'reconcile') {
    if (!request.source || request.sourceExpected?.kind !== 'file' || request.reserved) throw new Error();
    if (request.action === 'publish') {
      if (!equal((await inspect(request.source)).value, request.sourceExpected)) throw new Error();
      await io.link(request.source, request.name); // EEXIST preserves a concurrent winner.
      await checkpoint('after-publication');
    }
    const source = await io.lstat(request.source);
    const destination = await io.lstat(request.name);
    if (source.dev !== destination.dev || source.ino !== destination.ino || source.nlink !== 2) throw new Error();
    if (!equal((await inspect(request.name, false, true)).value, request.sourceExpected)) throw new Error();
    await syncParent();
    await io.unlink(request.source); // private, declared name, exact inode pair
    await checkpoint('after-prepared-unlink');
    const result = await inspect(request.name); // final nlink=1, synced file
    if (!equal(result.value, request.sourceExpected)) throw new Error();
    await syncParent();
    return { ...result, parent: metadata(await io.stat('.')) };
  }
  if (request.action === 'entries') return { value: { kind: 'directory', mode: 0o700 }, entries: await io.readdir('.') };
  if (request.action !== 'inspect' && !request.expected) throw new Error();
  const current = await inspect(request.name, request.action === 'read');
  if (request.expected && !equal(current.value, request.expected)) throw new Error();
  if (request.action === 'inspect' || request.action === 'read') return current;
  if (request.action === 'sync-file') { await syncParent(); return { ...current, parent: metadata(await io.stat('.')) }; }
  if (request.action === 'file') {
    if (request.reserved || current.value.kind !== 'absent' || request.content === undefined) throw new Error();
    const handle = await io.open(request.name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== request.uid || stat.nlink !== 1) throw new Error();
      await handle.chmod(0o600);
      await handle.writeFile(Buffer.from(request.content, 'base64'));
      await checkpoint('after-file-write');
      await handle.sync();
    } finally { await handle.close(); }
  } else if (request.action === 'link') {
    if (current.value.kind !== 'absent' || request.target === undefined) throw new Error();
    if (process.platform !== 'darwin' && (request.linkMode ?? 0o777) !== 0o777) throw new Error();
    // The isolated child can choose symlink mode at creation on Darwin without
    // chmod of a destination name that a concurrent writer may have replaced.
    process.umask(0o777 & ~(request.linkMode ?? 0o777));
    await io.symlink(request.target, request.name);
  } else if (request.action === 'directory') {
    if (current.value.kind !== 'absent') throw new Error();
    await io.mkdir(request.name, { mode: 0o700 });
    // Do not chmod an existing/raced path. An unusual umask fails validation.
  } else if (request.action === 'remove') {
    if (current.value.kind === 'absent') throw new Error();
    if (current.value.kind === 'directory') await io.rmdir(request.name);
    else await io.unlink(request.name);
    await checkpoint('after-remove');
  } else {
    if (!request.source || !request.sourceExpected || request.sourceExpected.kind === 'directory' || current.value.kind === 'directory' ||
        (request.reserved && request.sourceExpected.kind === 'file')) throw new Error();
    if (!equal((await inspect(request.source)).value, request.sourceExpected)) throw new Error();
    await io.rename(request.source, request.name);
  }
  await checkpoint('after-action');
  await syncParent();
  const result = await inspect(request.name);
  if (request.action === 'link' && !equal(result.value, { kind: 'symlink', mode: request.linkMode ?? 0o777, target: request.target ?? '' }) ||
      request.action === 'directory' && result.value.kind !== 'directory') throw new Error();
  return { ...result, parent: metadata(await io.stat('.')) };
}

export const runTransactionChild: TransactionChildRunner = input => new Promise((resolveReply, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', input.script], {
    cwd: input.cwd, env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const chunks: Buffer[] = [];
  let length = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 10000);
  child.stdout.on('data', (chunk: Buffer) => {
    length += chunk.length;
    if (length > 32 * 1024 * 1024) child.kill('SIGKILL');
    else chunks.push(chunk);
  });
  child.stderr.resume(); // Child diagnostics are deliberately never propagated.
  child.stdin.on('error', () => { /* exit/error event is authoritative */ });
  child.on('error', () => { clearTimeout(timer); reject(new Error('Unsafe transaction filesystem operation.')); });
  child.on('close', code => {
    clearTimeout(timer);
    if (code !== 0) reject(new Error('Unsafe transaction filesystem operation.'));
    else resolveReply(Buffer.concat(chunks).toString('utf8'));
  });
  child.stdin.end(input.input);
});
const metadata = (s: Stats): Metadata => ({ device: s.dev, inode: s.ino, mode: s.mode, uid: s.uid, links: s.nlink,
  kind: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other' });

/** Injectable read-only admission and child boundary; all mutations are anchored. */
export class TransactionFilesystem {
  constructor(readonly context: TransactionFilesystemContext, readonly fault: TransactionFault = () => {},
    readonly run: TransactionChildRunner = runTransactionChild,
    readonly admission: Pick<typeof fs, 'lstat' | 'realpath'> = fs) {}

  async parent(path: string): Promise<Metadata> {
    if (!isAbsolute(path) || resolve(path) !== path || /[\\\p{Cc}]/u.test(path) || (!containsPath(this.context.roomHome, path) && path !== bootstrapSidecarPath(this.context.roomHome))) throw new Error('Unsafe transaction path.');
    const parents: string[] = [];
    for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
      parents.push(cursor);
      if (dirname(cursor) === cursor) break;
    }
    let immediate: Metadata | undefined;
    for (const directory of parents.reverse()) {
      const stat = metadata(await this.admission.lstat(directory));
      const managed = containsPath(this.context.roomHome, directory);
      if (stat.kind !== 'directory' || (stat.uid !== this.context.uid && (managed || stat.uid !== 0)) ||
          (managed ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000)) ||
          await this.admission.realpath(directory) !== directory) throw new Error('Unsafe transaction parent.');
      immediate = stat;
    }
    if (!immediate) throw new Error('Unsafe transaction parent.');
    return immediate;
  }

  async perform(path: string, operation: Omit<Request, 'name' | 'parent' | 'uid' | 'forbidden' | 'reserved'>, expectedParent?: Metadata): Promise<Reply> {
    try {
      const admitted = await this.parent(path);
      if (expectedParent && Object.keys(admitted).some(key => admitted[key as keyof Metadata] !== expectedParent[key as keyof Metadata])) throw new Error();
      const request: Request = { ...operation, name: basename(path), parent: expectedParent ?? admitted, uid: this.context.uid,
        forbidden: this.context.forbiddenFileIdentities ?? [], reserved: this.context.forbiddenFilePaths?.includes(path) ?? false };
      const script = `import * as fs from 'node:fs/promises'; import { constants } from 'node:fs'; import { createHash } from 'node:crypto'; let text = ''; for await (const chunk of process.stdin) text += chunk; try { const result = await (${anchoredOperation.toString()})(JSON.parse(text), fs, constants, createHash); process.stdout.write(JSON.stringify(result)); } catch { process.exitCode = 1; }`;
      await this.fault('before-action', `${operation.action}:${path}`);
      const reply = JSON.parse(await this.run({ cwd: dirname(path), script, input: JSON.stringify(request) })) as Reply;
      await this.fault('after-action', `${operation.action}:${path}`);
      return reply;
    } catch { throw new Error('Unsafe transaction filesystem operation.'); }
  }
  async inspect(path: string, parent?: Metadata, nonFile = false): Promise<FileValue> { return (await this.perform(path, { action: 'inspect', nonFile }, parent)).value; }
  async entries(path: string): Promise<string[]> {
    const reply = await this.perform(join(path, '.entry-probe'), { action: 'entries' });
    if (!reply.entries) throw new Error('Unsafe transaction directory.');
    return reply.entries;
  }
  async read(path: string, expected: FileValue): Promise<Buffer> {
    const reply = await this.perform(path, { action: 'read', expected });
    if (reply.value.kind !== 'file' || reply.content === undefined) throw new Error('Unsafe transaction file.');
    return Buffer.from(reply.content, 'base64');
  }
  async syncParent(path: string): Promise<void> {
    await this.fault('before-fsync', dirname(path));
    await this.perform(path, { action: 'sync' });
    await this.fault('after-fsync', dirname(path));
  }
  async file(path: string, content: Uint8Array, parent?: Metadata): Promise<Metadata> {
    await this.fault('before-fsync', path);
    const reply = await this.perform(path, { action: 'file', expected: { kind: 'absent' }, content: Buffer.from(content).toString('base64') }, parent);
    await this.fault('after-fsync', path);
    if (!reply.parent) throw new Error('Unsafe transaction parent.');
    return reply.parent;
  }
  async directory(path: string): Promise<void> {
    await this.perform(path, { action: 'directory', expected: { kind: 'absent' } });
  }
  async rename(path: string, source: string, expected: FileValue, sourceExpected: FileValue, parent?: Metadata): Promise<void> {
    // Overwriting rename is confined to transaction-private journal state.
    // Managed destinations must use capture + no-clobber publication instead.
    if (dirname(path) !== dirname(source) || basename(path) !== 'journal.json' || basename(source) !== 'journal.next' ||
        !containsPath(join(this.context.roomHome, 'transactions'), dirname(path))) throw new Error('Unsafe transaction rename.');
    await this.fault('before-rename', path);
    await this.perform(path, { action: 'rename', source: basename(source), expected, sourceExpected }, parent);
    await this.fault('after-rename', path);
  }
}

