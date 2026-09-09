import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ArtifactSpec } from '../src/adapters/contract.js';
import { sha256 } from '../src/core/hash.js';
import type { InstallationManifestV1, ManifestArtifact } from '../src/core/manifest.js';
import { absentTransactionProviders, FilesystemTransaction, JOURNAL_STATES, loadJournal, serializeJournal, TransactionFilesystem,
  transitionJournal, validateJournal, withTransactionSignals, type BeginTransaction, type FileChange, type JournalContext,
  type JournalState, type TransactionBoundary, type TransactionJournalV1 } from '../src/core/transaction.js';
import { runTransactionChild, type TransactionFault, type TransactionFilesystemContext } from '../src/core/transaction-fs.js';
import { endpointIdentitySha256 } from '../src/paseo/cli-probe.js';
import { policyFixture } from './helpers/provider-policy.js';

async function symlink(target: string, path: string): Promise<void> {
  await fs.symlink(target, path);
  if (process.platform === 'darwin') {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_SYMLINK);
    try { await handle.chmod(0o777); } finally { await handle.close(); }
  }
}
const pureContext: JournalContext = { roomHome: '/fixture/room', transactionId: 'tx-1' };
function journal(): TransactionJournalV1 {
  return { schemaVersion: 1, transactionId: 'tx-1', operation: 'install', state: 'staged', previousManifest: null,
    bootstrapEndpointIdentitySha256: null, fileMutations: [], providerBefore: absentTransactionProviders(), providerAfter: policyFixture() };
}
function previousManifest(): InstallationManifestV1 {
  return { schemaVersion: 1, packageVersion: '0.1.0', installationId: 'installation', lastTransactionId: 'old',
    status: 'uninstall-incomplete', adapter: 'codex', artifacts: [], providers: {}, committedAt: '2026-09-09T09:00:00Z',
    paseo: { localHome: '/fixture/paseo', listen: 'ws://127.0.0.1:6767', endpointIdentitySha256: endpointIdentitySha256('/fixture/paseo', 'ws://127.0.0.1:6767'),
      cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1', minimumVersion: '0.8.0-beta.1' },
    source: { canonicalHome: '/fixture/canonical', canonicalConfigSha256: sha256('config'), codexLaunchArgv: ['/opt/codex'], codexVersion: '1.0.0' } };
}
function privatePaths(before: TransactionJournalV1['fileMutations'][number]['after'], after: TransactionJournalV1['fileMutations'][number]['after']): TransactionJournalV1['fileMutations'][number]['privatePaths'] {
  return (['prepared', 'capture', 'rollback-prepared', 'rollback-capture'] as const).map(role => ({ role,
    name: `.paseo-room-${randomUUID()}-${role}`, expected: ['capture', 'rollback-prepared'].includes(role) ? before : after }));
}
function fileRecord(): TransactionJournalV1['fileMutations'][number] {
  return { parent: { device: 1, inode: 1, mode: 0o40700, uid: 1, links: 2, kind: 'directory' }, pending: null, pendingLinks: [], privatePaths: privatePaths({ kind: 'file', mode: 0o600, sha256: sha256('old') }, { kind: 'file', mode: 0o600, sha256: sha256('new') }), action: 'update', destination: '/fixture/room/file', kind: 'file',
    before: { kind: 'file', mode: 0o600, sha256: sha256('old'), backup: 'file-0' },
    after: { kind: 'file', mode: 0o600, sha256: sha256('new') }, stagedFile: 'file-0', progress: 'planned' };
}
function input(changes: readonly FileChange[]): BeginTransaction {
  return { operation: 'install', previousManifest: null, changes, providerBefore: absentTransactionProviders(),
    providerAfter: absentTransactionProviders(), validateArtifacts: () => {} };
}
async function fixture<T>(test: (root: string, context: JournalContext, filesystem: TransactionFilesystem) => Promise<T>): Promise<T> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paseo-transaction-')));
  await fs.chmod(root, 0o700);
  const context = { roomHome: root, transactionId: 'tx-1' };
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('macOS/Linux required');
  try { return await test(root, context, new TransactionFilesystem({ ...context, uid })); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const authored = (path: string, content = 'new'): ArtifactSpec => ({ kind: 'file', path, mode: 0o600, content });
const owned = (path: string, content = 'old'): ManifestArtifact => ({ kind: 'file', path, mode: 0o600, sha256: sha256(content) });
const create = (path: string): FileChange => ({ before: null, after: authored(path) });
async function update(path: string): Promise<FileChange> {
  await fs.writeFile(path, 'old', { mode: 0o600 });
  return { before: owned(path), after: authored(path) };
}

describe('strict context-bound journal v1', () => {
  it.each(JOURNAL_STATES)('validates and canonicalizes state %s', state => {
    const value = { ...journal(), state, previousManifest: previousManifest() };
    expect(loadJournal(serializeJournal(value, pureContext), pureContext)).toEqual(value);
    expect(loadJournal(Buffer.from(serializeJournal(value, pureContext)), pureContext)).toEqual(value);
    expect(serializeJournal(value, pureContext)).toBe(serializeJournal({ ...value, providerBefore: { ...value.providerBefore } }, pureContext));
  });
  const legal: Record<JournalState, readonly JournalState[]> = {
    staged: ['publishing-files', 'rolling-back', 'recovery-required'], 'publishing-files': ['patching-paseo', 'rolling-back', 'recovery-required'],
    'patching-paseo': ['verifying', 'rolling-back', 'recovery-required'], verifying: ['committed', 'rolling-back', 'recovery-required'],
    'rolling-back': ['rolled-back', 'recovery-required'], 'recovery-required': ['rolling-back'], committed: [], 'rolled-back': [],
  };
  it.each(JOURNAL_STATES.flatMap(from => JOURNAL_STATES.map(to => ({ from, to }))))('enforces $from → $to', ({ from, to }) => {
    const operation = (): TransactionJournalV1 => transitionJournal({ ...journal(), state: from }, to, pureContext);
    if (legal[from].includes(to)) expect(operation().state).toBe(to);
    else expect(operation).toThrow();
  });
  it.each([
    { schemaVersion: 2 }, { schemaVersion: '1' }, { state: 'pending' }, { transactionId: '../escape' }, { transactionId: 'tx-2' },
    { operation: 'recover' }, { previousManifest: {} }, { previousManifest: { ...previousManifest(), schemaVersion: 2 } },
    { providerBefore: {} }, { providerAfter: { ...policyFixture(), 'codex-peer': { extends: 'codex' } } },
    { providerBefore: { ...absentTransactionProviders(), unknown: null } }, { unexpected: true },
  ])('rejects malformed/unknown journal %#', mutation => {
    expect(() => validateJournal({ ...journal(), ...mutation }, pureContext)).toThrow();
  });
  it.each(['{', 'null', '[]', '\ufffd', Buffer.from([0xff])])('rejects invalid JSON/UTF8 %#', text => {
    expect(() => loadJournal(text, pureContext)).toThrow();
  });
  it.each([
    { destination: '/elsewhere' }, { destination: '/fixture/room/../escape' }, { destination: '/fixture/room' },
    { destination: '/fixture/room/transactions/x' }, { destination: '/fixture/room/manifest.json' },
    { stagedFile: '../escape' }, { stagedFile: '/escape' }, { stagedFile: null }, { kind: 'symlink' },
    { action: 'create' }, { action: 'remove' }, { progress: 'completed' }, { extra: 'x' },
    { before: { ...fileRecord().before, backup: '../escape' } }, { after: { kind: 'file', mode: 0o644, sha256: sha256('new') } },
  ])('rejects malformed file record %#', mutation => {
    expect(() => validateJournal({ ...journal(), fileMutations: [{ ...fileRecord(), ...mutation }] }, pureContext)).toThrow();
  });
  it('rejects duplicate destinations/backups/stages and non-directory parents', () => {
    const record = fileRecord();
    for (const other of [record, { ...record, destination: '/fixture/room/other' }, { ...record, destination: record.destination + '/child' }]) {
      expect(() => validateJournal({ ...journal(), fileMutations: [record, other] }, pureContext)).toThrow();
    }
    expect(() => validateJournal({ ...journal(), fileMutations: [record] }, { ...pureContext, forbiddenFilePaths: [record.destination] })).toThrow();
  });
  it.each(JOURNAL_STATES)('rejects inconsistent progress for %s', state => {
    for (const progress of ['planned', 'intent', 'completed', 'compensating', 'compensated'] as const) {
      const permitted = state === 'staged' ? progress === 'planned' : state === 'publishing-files' ? ['planned', 'intent', 'completed'].includes(progress)
        : ['patching-paseo', 'verifying', 'committed'].includes(state) ? progress === 'completed'
          : state === 'rolled-back' ? ['planned', 'compensated'].includes(progress) : true;
      const parse = (): TransactionJournalV1 => validateJournal({ ...journal(), state, fileMutations: [{ ...fileRecord(), progress }] }, pureContext);
      if (permitted) expect(parse().state).toBe(state); else expect(parse).toThrow();
    }
  });
});

describe('durable private filesystem transaction', () => {
  it('stages every declaration and backup before publishing; exact private modes and roundtrip journal', async () => fixture(async (root, context, filesystem) => {
    const first = await update(join(root, 'one'));
    const second = create(join(root, 'two'));
    const validateArtifacts = vi.fn(() => {});
    const tx = await FilesystemTransaction.begin(context, { ...input([first, second]), validateArtifacts }, filesystem);
    expect(validateArtifacts).toHaveBeenCalledExactlyOnceWith([first.after, second.after]);
    for (const path of [root, dirname(tx.directory), tx.directory, join(tx.directory, 'staging'), join(tx.directory, 'before')]) {
      expect((await fs.lstat(path)).mode & 0o7777).toBe(0o700);
    }
    for (const path of [tx.journalPath, join(tx.directory, 'staging/file-0'), join(tx.directory, 'staging/file-1'), join(tx.directory, 'before/file-0')]) {
      expect((await fs.lstat(path)).mode & 0o7777).toBe(0o600);
    }
    expect(await fs.readFile(join(root, 'one'), 'utf8')).toBe('old');
    await expect(fs.lstat(join(root, 'two'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await FilesystemTransaction.open(context, filesystem)).snapshot).toEqual(tx.snapshot);
    await tx.publish();
    expect(tx.snapshot.fileMutations.map(record => record.progress)).toEqual(['completed', 'completed']);
    expect(await fs.readFile(join(root, 'one'), 'utf8')).toBe('new');
    expect(await tx.compensate()).toBe('rolled-back');
    expect(await tx.compensate()).toBe('rolled-back');
    expect(await fs.readFile(join(root, 'one'), 'utf8')).toBe('old');
    await expect(fs.lstat(join(root, 'two'))).rejects.toMatchObject({ code: 'ENOENT' });
    await tx.cleanup();
    await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }), 30000);

  it('publishes nested directories, file and literal auth link; preserves mutable children on compensation', async () => fixture(async (root, context, base) => {
    const path = join(root, 'role'); const target = join(root, 'absent-credential-target');
    const filesystem = new TransactionFilesystem({ ...base.context, forbiddenFilePaths: [join(path, 'auth')] });
    const tx = await FilesystemTransaction.begin({ ...context, forbiddenFilePaths: [join(path, 'auth')] }, input([
      { before: null, after: { kind: 'directory', path, mode: 0o700 } }, create(join(path, 'file')),
      { before: null, after: { kind: 'symlink', path: join(path, 'auth'), target } },
    ]), filesystem);
    await tx.publish();
    expect(await fs.readlink(join(path, 'auth'))).toBe(target);
    expect(await fs.readdir(join(tx.directory, 'before'))).toEqual([]);
    await fs.writeFile(join(path, 'mutable'), 'runtime', { mode: 0o600 });
    expect(await tx.compensate()).toBe('recovery-required');
    expect(await fs.readdir(path)).toEqual(process.platform === 'darwin' ? ['auth', 'file', 'mutable'] : ['mutable']);
    expect(tx.snapshot.fileMutations.map(record => record.progress)).toEqual(process.platform === 'darwin'
      ? ['compensating', 'completed', 'completed'] : ['compensating', 'compensated', 'compensated']);
  }), 30000);

  it.each(['file', 'symlink', 'directory'] as const)('removes and restores %s without recursion or target reads', async kind => fixture(async (root, context, filesystem) => {
    const path = join(root, 'owned');
    let before: ManifestArtifact;
    if (kind === 'file') { await fs.writeFile(path, 'old', { mode: 0o600 }); before = owned(path); }
    else if (kind === 'symlink') { await symlink('/nonexistent/credential', path); before = { kind, path, mode: 0o777, target: '/nonexistent/credential' }; }
    else { await fs.mkdir(path, { mode: 0o700 }); before = { kind, path, mode: 0o700 }; }
    const tx = await FilesystemTransaction.begin(context, { ...input([{ before, after: null }]), operation: 'uninstall' }, filesystem);
    await tx.publish(); await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await tx.compensate()).toBe('rolled-back');
    expect(await filesystem.inspect(path)).toEqual(kind === 'file' ? { kind, mode: 0o600, sha256: sha256('old') }
      : kind === 'directory' ? { kind, mode: 0o700 } : { kind, mode: 0o777, target: '/nonexistent/credential' });
  }), 30000);

  it('updates symlinks as literal metadata (including relative before-target) and recreates the old link', async () => fixture(async (root, context, filesystem) => {
    const path = join(root, 'link'); await symlink('../not-a-readable-target', path);
    // Prior links admitted by the manifest are absolute; recovery itself also supports literal relative metadata.
    const tx = await FilesystemTransaction.begin(context, input([{ before: null, after: { kind: 'symlink', path: join(root, 'new-link'), target: '/new/target' } }]), filesystem);
    const value = tx.snapshot;
    value.fileMutations = [{ pending: null, pendingLinks: [], parent: { ...await filesystem.parent(path), kind: 'directory' },
      privatePaths: privatePaths({ kind: 'symlink', mode: 0o777, target: '../not-a-readable-target' }, { kind: 'symlink', mode: 0o777, target: '/new/target' }), action: 'update', kind: 'symlink', destination: path,
      before: { kind: 'symlink', mode: 0o777, target: '../not-a-readable-target' }, after: { kind: 'symlink', mode: 0o777, target: '/new/target' },
      stagedFile: null, progress: 'completed' }]; value.state = 'publishing-files';
    await fs.unlink(path); await symlink('/new/target', path);
    await fs.writeFile(tx.journalPath, serializeJournal(value, context));
    const recovered = await FilesystemTransaction.open(context, filesystem);
    expect(await recovered.compensate()).toBe('rolled-back');
    expect(await fs.readlink(path)).toBe('../not-a-readable-target');
    expect(await fs.readdir(join(tx.directory, 'before'))).toEqual([]);
  }), 30000);

  it('validates semantic content before IO and detects altered staged bytes before destination change', async () => fixture(async (root, context, filesystem) => {
    const path = join(root, 'file'); const change = await update(path);
    await expect(FilesystemTransaction.begin(context, { ...input([change]), validateArtifacts: () => { throw new Error('invalid TOML'); } }, filesystem)).rejects.toThrow();
    expect(await fs.readdir(root)).toEqual(['file']);
    const tx = await FilesystemTransaction.begin(context, input([change]), filesystem);
    await fs.writeFile(join(tx.directory, 'staging/file-0'), 'tampered');
    await expect(tx.publish()).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe('old');
    expect(await tx.compensate()).toBe('rolled-back');
    await expect(tx.cleanup()).rejects.toThrow();
    expect(await fs.readFile(join(tx.directory, 'staging/file-0'), 'utf8')).toBe('tampered');
  }), 30000);

  it('retains corrupt/unknown journals byte-for-byte and refuses to begin over an existing transaction', async () => fixture(async (root, context, filesystem) => {
    const tx = await FilesystemTransaction.begin(context, input([create(join(root, 'new'))]), filesystem);
    for (const content of ['{broken', JSON.stringify({ ...tx.snapshot, schemaVersion: 2 })]) {
      await fs.writeFile(tx.journalPath, content);
      await expect(FilesystemTransaction.open(context, filesystem)).rejects.toThrow();
      await expect(FilesystemTransaction.begin(context, input([]), filesystem)).rejects.toThrow();
      await expect(tx.publish()).rejects.toThrow();
      expect(await fs.readFile(tx.journalPath, 'utf8')).toBe(content);
    }
  }), 30000);

  it('preserves independent concurrent divergence, restores safe files, retains evidence', async () => fixture(async (root, context, filesystem) => {
    const tx = await FilesystemTransaction.begin(context, input([await update(join(root, 'one')), await update(join(root, 'two'))]), filesystem);
    await tx.publish(); await fs.writeFile(join(root, 'two'), 'concurrent');
    expect(await tx.compensate()).toBe('recovery-required');
    expect(await fs.readFile(join(root, 'one'), 'utf8')).toBe('old');
    expect(await fs.readFile(join(root, 'two'), 'utf8')).toBe('concurrent');
    await expect(tx.cleanup()).rejects.toThrow();
    expect((await FilesystemTransaction.open(context, filesystem)).snapshot.state).toBe('recovery-required');
  }), 30000);

  it('never follows symlink parents, hard links, special files, foreign ownership, or path escapes', async () => fixture(async (root, context, filesystem) => {
    const path = join(root, 'file'); await fs.writeFile(path, 'old', { mode: 0o600 });
    await fs.link(path, join(root, 'hard'));
    await expect(FilesystemTransaction.begin(context, input([{ before: owned(path), after: null }]), filesystem)).rejects.toThrow();
    await expect(filesystem.inspect(path)).rejects.toThrow();
    await fs.mkdir(join(root, 'real'), { mode: 0o700 }); await symlink(join(root, 'real'), join(root, 'link'));
    await expect(filesystem.inspect(join(root, 'link', 'child'))).rejects.toThrow();
    await expect(filesystem.inspect(join(root, '..', 'escape'))).rejects.toThrow();
    execFileSync('/usr/bin/mkfifo', [join(root, 'fifo')]);
    await expect(filesystem.inspect(join(root, 'fifo'))).rejects.toThrow();
    const foreign = new TransactionFilesystem({ ...filesystem.context, uid: filesystem.context.uid + 1 });
    await expect(foreign.inspect(join(root, 'none'))).rejects.toThrow();
    await fs.chmod(join(root, 'real'), 0o755);
    await expect(filesystem.inspect(join(root, 'real', 'child'))).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe('old');
  }), 30000);

  it('credential sentinels are never read, hashed, backed up, or emitted; literal links are allowed', async () => fixture(async (root, context, base) => {
    const sentinel = join(root, 'credential'); const alias = join(root, 'alias'); const log = join(root, 'reads');
    await fs.writeFile(sentinel, 'disposable sentinel', { mode: 0o600 });
    const stat = await fs.lstat(sentinel);
    const reservedContext: TransactionFilesystemContext = { ...base.context, forbiddenFilePaths: [sentinel], forbiddenFileIdentities: [{ device: stat.dev, inode: stat.ino }] };
    const filesystem = new TransactionFilesystem(reservedContext, () => {}, async request => runTransactionChild({ ...request,
      script: request.script.replace('const content = await handle.readFile();', `await io.appendFile(${JSON.stringify(log)}, request.name + '\\n'); const content = await handle.readFile();`) }));
    await expect(filesystem.inspect(sentinel)).rejects.toThrow();
    await fs.rename(sentinel, alias); // Single-link inode alias, not merely a hard-link check.
    await expect(filesystem.inspect(alias)).rejects.toThrow();
    await expect(fs.lstat(log)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rename(alias, sentinel);
    await expect(FilesystemTransaction.begin({ ...context, forbiddenFilePaths: [sentinel] }, input([create(sentinel)]), filesystem)).rejects.toThrow();
    await fs.writeFile(log, '', { mode: 0o600 }); // instrumentation must not change the admitted parent's link count
    const tx = await FilesystemTransaction.begin({ ...context, forbiddenFilePaths: [sentinel] }, input([
      { before: null, after: { kind: 'symlink', path: join(root, 'auth'), target: sentinel } },
    ]), filesystem);
    await tx.publish(); await tx.compensate();
    const reads = await fs.readFile(log, 'utf8');
    expect(reads).not.toContain('credential'); expect(reads).not.toContain('alias'); expect(reads).not.toContain('auth');
    expect(await fs.readdir(join(tx.directory, 'before'))).toEqual([]);
    expect(await fs.readFile(tx.journalPath, 'utf8')).not.toContain('disposable sentinel');
  }), 30000);

  it('rejects a raced parent before the child can read or mutate another directory', async () => fixture(async (root, _context, base) => {
    const parent = join(root, 'parent'); const outside = join(root, 'outside');
    await fs.mkdir(parent, { mode: 0o700 }); await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(join(outside, 'file'), 'sentinel', { mode: 0o600 });
    const filesystem = new TransactionFilesystem(base.context, () => {}, async request => {
      await fs.rename(parent, parent + '-old'); await symlink(outside, parent);
      return runTransactionChild(request);
    });
    await expect(filesystem.file(join(parent, 'file'), Buffer.from('new'))).rejects.toThrow();
    expect(await fs.readFile(join(outside, 'file'), 'utf8')).toBe('sentinel');
  }));

  it('journals intent before mutations and completion after, with file fsync → rename → directory fsync', async () => fixture(async (root, context, base) => {
    const events: { boundary: TransactionBoundary; path: string }[] = [];
    const path = join(root, 'file');
    const filesystem = new TransactionFilesystem(base.context, async (boundary, eventPath) => {
      events.push({ boundary, path: eventPath });
      if (boundary === 'before-mutation') {
        const disk = loadJournal(await fs.readFile(join(root, 'transactions/tx-1/journal.json')), context);
        expect(disk.fileMutations[0]?.progress).toBe('intent');
        expect(await fs.readFile(path, 'utf8')).toBe('old');
      }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    events.length = 0; await tx.publish();
    const rename = events.findIndex(event => event.boundary === 'before-rename' && event.path === path);
    const tempSync = events.findIndex(event => event.boundary === 'after-fsync' && event.path.endsWith('-prepared'));
    const dirSync = events.findIndex((event, index) => index > rename && event.boundary === 'after-action' && event.path === `capture:${join(root, tx.snapshot.fileMutations[0]?.privatePaths.find(entry => entry.role === 'capture')?.name ?? '')}`);
    expect(tempSync).toBeGreaterThan(0); expect(tempSync).toBeLessThan(rename); expect(rename).toBeLessThan(dirSync);
    expect(loadJournal(await fs.readFile(tx.journalPath), context).fileMutations[0]?.progress).toBe('completed');
  }), 30000);

  it('retains unknown cleanup additions and will not clean a nonterminal transaction', async () => fixture(async (root, context, filesystem) => {
    const tx = await FilesystemTransaction.begin(context, input([create(join(root, 'file'))]), filesystem);
    await expect(tx.cleanup()).rejects.toThrow();
    await tx.compensate();
    await fs.writeFile(join(tx.directory, 'before', 'unknown'), 'custom', { mode: 0o600 });
    await expect(tx.cleanup()).rejects.toThrow();
    expect(await fs.readFile(join(tx.directory, 'before', 'unknown'), 'utf8')).toBe('custom');
    expect(loadJournal(await fs.readFile(tx.journalPath), context).state).toBe('rolled-back');
  }), 30000);
});

describe('faults and interruption', () => {
  it('all staging fault boundary types leave every destination untouched and retain only private evidence', async () => {
    const boundaries = new Set<TransactionBoundary>();
    await fixture(async (root, context, base) => {
      const filesystem = new TransactionFilesystem(base.context, point => { boundaries.add(point); });
      await FilesystemTransaction.begin(context, input([await update(join(root, 'file'))]), filesystem);
    });
    for (const boundary of boundaries) await fixture(async (root, context, base) => {
      let injected = false;
      const filesystem = new TransactionFilesystem(base.context, point => {
        if (!injected && point === boundary) { injected = true; throw new Error('fault'); }
      });
      await expect(FilesystemTransaction.begin(context, input([await update(join(root, 'file'))]), filesystem)).rejects.toThrow();
      expect(injected).toBe(true);
      expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('old');
      async function privateTree(path: string): Promise<void> {
        for (const name of await fs.readdir(path)) {
          const child = join(path, name); const stat = await fs.lstat(child);
          expect(stat.mode & 0o7777).toBe(stat.isDirectory() ? 0o700 : 0o600);
          if (stat.isDirectory()) await privateTree(child);
        }
      }
      await privateTree(root);
    });
  }, 180000);

  it('signal cancellation stops before the next publish, then compensates the active transaction', async () => fixture(async (root, context, base) => {
    const signals = new EventEmitter();
    const filesystem = new TransactionFilesystem(base.context, point => { if (point === 'before-mutation') signals.emit('SIGINT'); });
    const tx = await FilesystemTransaction.begin(context, input([await update(join(root, 'file'))]), filesystem);
    await expect(withTransactionSignals(interrupted => tx.publish(interrupted), () => tx.compensate(), signals)).rejects.toMatchObject({ signal: 'SIGINT' });
    expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('old');
    expect(tx.snapshot.state).toBe('rolled-back');
    expect(signals.eventNames()).toEqual([]);
  }), 30000);

  it('rejects overlapping calls without queuing a second filesystem mutation', async () => fixture(async (root, context, base) => {
    let release: (() => void) | undefined; let started: (() => void) | undefined;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    let armed = false;
    const filesystem = new TransactionFilesystem(base.context, async point => {
      if (armed && point === 'before-journal') { armed = false; started?.(); await blocked; }
    });
    const tx = await FilesystemTransaction.begin(context, input([create(join(root, 'file'))]), filesystem);
    armed = true; const publishing = tx.publish(); await entered;
    await expect(tx.publish()).rejects.toThrow(); await expect(tx.compensate()).rejects.toThrow();
    release?.(); await publishing;
    expect(await tx.compensate()).toBe('rolled-back');
  }), 30000);

  it('terminal transitions are hooks only and cleanup requires a matching durable terminal journal', async () => fixture(async (root, context, base) => {
    let fail = false;
    const filesystem = new TransactionFilesystem(base.context, point => { if (fail && point === 'before-journal') { fail = false; throw new Error('fault'); } });
    const tx = await FilesystemTransaction.begin(context, input([create(join(root, 'file'))]), filesystem);
    await tx.publish(); await tx.transition('patching-paseo'); await tx.transition('verifying');
    fail = true; await expect(tx.transition('committed')).rejects.toThrow();
    await expect(tx.cleanup()).rejects.toThrow();
    expect(loadJournal(await fs.readFile(tx.journalPath), context).state).toBe('verifying');
    const reopened = await FilesystemTransaction.open(context, base);
    await reopened.transition('committed'); await expect(reopened.compensate()).rejects.toThrow();
    await reopened.cleanup(); expect(await fs.readFile(join(root, 'file'), 'utf8')).toBe('new');
    await expect(fs.lstat(join(root, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }), 30000);

  it.each(['before-mutation', 'after-mutation'] as const)('fault %s for file/link/directory create and remove is classifiable', async boundary => {
    for (const kind of ['file', 'symlink', 'directory'] as const) for (const remove of [false, true]) await fixture(async (root, context, base) => {
      const path = join(root, 'owned');
      const spec: ArtifactSpec = kind === 'file' ? authored(path) : kind === 'symlink'
        ? { kind, path, target: '/unreadable/auth' } : { kind, path, mode: 0o700 };
      const before: ManifestArtifact = kind === 'file' ? owned(path, 'new') : kind === 'symlink'
        ? { kind, path, mode: 0o777, target: '/unreadable/auth' } : { kind, path, mode: 0o700 };
      if (remove) {
        if (kind === 'file') await fs.writeFile(path, 'new', { mode: 0o600 });
        else if (kind === 'symlink') await symlink('/unreadable/auth', path);
        else await fs.mkdir(path, { mode: 0o700 });
      }
      let armed = true;
      const filesystem = new TransactionFilesystem(base.context, point => { if (armed && point === boundary) { armed = false; throw new Error('fault'); } });
      const tx = await FilesystemTransaction.begin(context, input([{ before: remove ? before : null, after: remove ? null : spec }]), filesystem);
      await expect(tx.publish()).rejects.toThrow();
      expect(await tx.compensate()).toBe('rolled-back');
      if (!remove) await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
      else expect((await filesystem.inspect(path)).kind).toBe(kind);
    });
  }, 180000);

  it('crash after durable capture reopens the declared absence interval and restores before', async () => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let armed = true;
    const filesystem = new TransactionFilesystem(base.context, (point, destination) => {
      if (armed && point === 'after-rename' && destination === path) { armed = false; throw new Error('power loss'); }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    await expect(tx.publish()).rejects.toThrow();
    const reopened = await FilesystemTransaction.open(context, base);
    expect(reopened.snapshot.fileMutations[0]?.progress).toBe('intent');
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(path, 'utf8')).toBe('old');
  }), 30000);

  it('concurrent replacement just before rename is preserved', async () => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let raced = false;
    const filesystem = new TransactionFilesystem(base.context, async (point, destination) => {
      if (!raced && point === 'before-rename' && destination === path) { raced = true; await fs.writeFile(path, 'concurrent'); }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    await expect(tx.publish()).rejects.toThrow();
    expect(await tx.compensate()).toBe('recovery-required');
    const capture = tx.snapshot.fileMutations[0]?.privatePaths.find(entry => entry.role === 'capture');
    expect(capture).toBeDefined();
    expect(await fs.readFile(join(root, capture?.name ?? ''), 'utf8')).toBe('concurrent');
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
  }), 30000);

  it.each(['before-compensation', 'after-compensation', 'before-cleanup', 'after-cleanup'] as const)('exposes %s faults and preserves evidence', async point => fixture(async (root, context, base) => {
    let armed = false;
    const fault: TransactionFault = boundary => { if (armed && boundary === point) { armed = false; throw new Error('fault'); } };
    const tx = await FilesystemTransaction.begin(context, input([await update(join(root, 'file'))]), new TransactionFilesystem(base.context, fault));
    await tx.publish(); armed = true;
    if (point.includes('compensation')) expect(await tx.compensate()).toBe('recovery-required');
    else { await tx.compensate(); await expect(tx.cleanup()).rejects.toThrow(); }
    expect((await fs.lstat(tx.journalPath)).isFile()).toBe(true);
  }), 30000);

  it.each(['SIGINT', 'SIGTERM'] as const)('%s invokes conditional compensation once, restores existing listeners, exposes outcome', async signal => {
    const events = new EventEmitter(); const existing = vi.fn(); events.on(signal, existing);
    const compensate = vi.fn(() => Promise.resolve('rolled-back' as const));
    await expect(withTransactionSignals(interrupted => {
      expect(interrupted()).toBe(false); events.emit(signal); events.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
      expect(interrupted()).toBe(true); return Promise.resolve('value');
    }, compensate, events)).rejects.toMatchObject({ signal, compensationFailed: false });
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(events.listeners(signal)).toEqual([existing]);
    expect(events.listenerCount(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT')).toBe(0);
  });
  it('signal failure outcome is sanitized; no-signal success/error leaves no handlers', async () => {
    const events = new EventEmitter(); const compensate = vi.fn(() => Promise.reject(new Error('sentinel')));
    await expect(withTransactionSignals(() => { events.emit('SIGTERM'); return Promise.reject(new Error('work')); }, compensate, events))
      .rejects.toMatchObject({ signal: 'SIGTERM', compensationFailed: true });
    expect(compensate).toHaveBeenCalledTimes(1);
    expect(await withTransactionSignals(() => Promise.resolve(42), compensate, events)).toBe(42);
    await expect(withTransactionSignals(() => Promise.reject(new Error('work')), compensate, events)).rejects.toThrow('work');
    expect(events.eventNames()).toEqual([]);
  });
});

// Each case identifies a distinct logical step and boundary, not the first
// occurrence of a boundary name or every duplicate read/journal IO hook.
const actionProof = [
  ['publish', 'file', 'prepared'], ['publish', 'capture', 'capture'], ['publish', 'publish', 'destination'], ['publish', 'remove', 'capture'],
  ['compensate', 'file', 'rollback-prepared'], ['compensate', 'capture', 'rollback-capture'],
  ['compensate', 'publish', 'destination'], ['compensate', 'remove', 'rollback-capture'],
  ['cleanup', 'remove', 'stage'], ['cleanup', 'remove', 'backup'], ['cleanup', 'remove', 'staging'],
  ['cleanup', 'remove', 'before'], ['cleanup', 'remove', 'journal'], ['cleanup', 'remove', 'transaction'],
] as const;
describe('semantic step crash proof (durable reopen)', () => {
  it.concurrent.each(actionProof.flatMap(([phase, action, target]) => (['before-action', 'after-action'] as const)
    .map(boundary => ({ phase, action, target, boundary }))))('$phase / $action / $target / $boundary', async ({ phase, action, target, boundary }) => fixture(async (root, context, base) => {
    const path = join(root, 'file');
    let active = false; let crashed = false; let wanted = '';
    const filesystem = new TransactionFilesystem(base.context, (point, eventPath) => {
      if (crashed) throw new Error('process unavailable');
      if (active && point === boundary && eventPath === `${action}:${wanted}`) { crashed = true; throw new Error('crash'); }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    if (phase !== 'publish') await tx.publish();
    if (phase === 'cleanup') await tx.compensate();
    const record = tx.snapshot.fileMutations[0];
    if (!record) throw new Error('fixture');
    const names: Record<string, string> = { destination: path, stage: join(tx.directory, 'staging/file-0'), backup: join(tx.directory, 'before/file-0'),
      staging: join(tx.directory, 'staging'), before: join(tx.directory, 'before'), journal: tx.journalPath, transaction: tx.directory };
    for (const entry of record.privatePaths) names[entry.role] = join(root, entry.name);
    wanted = names[target] ?? ''; active = true;
    try { await tx[phase](); } catch { /* A stopped process cannot write further evidence. */ }
    expect(crashed).toBe(true);
    if ((await base.inspect(tx.directory)).kind === 'absent') { expect(await fs.readFile(path, 'utf8')).toBe('old'); return; }
    if ((await base.inspect(tx.journalPath)).kind === 'absent') { expect(await fs.readFile(path, 'utf8')).toBe('old'); expect(await fs.readdir(tx.directory)).toEqual([]); return; }
    const reopened = await FilesystemTransaction.open(context, base);
    if (phase === 'cleanup') {
      await reopened.cleanup();
      await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await reopened.compensate()).toBe('rolled-back');
      await reopened.cleanup();
    }
    expect(await fs.readFile(path, 'utf8')).toBe('old');
  }), 60000);

  it.concurrent.each(['SIGINT', 'SIGTERM'] as const)('%s reports a real unresolved after-value divergence', async signal => fixture(async (root, context, base) => {
    const path = join(root, 'file'); const signals = new EventEmitter();
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), base);
    await tx.publish();
    await expect(withTransactionSignals(async () => {
      await fs.writeFile(path, 'concurrent', { mode: 0o600 }); signals.emit(signal);
    }, () => tx.compensate(), signals)).rejects.toMatchObject({ signal, compensationFailed: true });
    expect(await fs.readFile(path, 'utf8')).toBe('concurrent');
    expect((await FilesystemTransaction.open(context, base)).snapshot.state).toBe('recovery-required');
    expect(signals.eventNames()).toEqual([]);
  }), 60000);

  it.concurrent.each(['publish', 'compensate'] as const)('preserves a destination winner after %s capture, before no-clobber publication', async phase => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let active = false; let raced = false;
    const filesystem = new TransactionFilesystem(base.context, async (boundary, eventPath) => {
      if (active && !raced && boundary === 'after-rename' && eventPath === path) {
        raced = true; await fs.writeFile(path, 'winner', { mode: 0o600, flag: 'wx' });
      }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    if (phase === 'compensate') await tx.publish(); active = true;
    try { await tx[phase](); } catch { /* Expected publication conflict. */ }
    expect(raced).toBe(true);
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe('recovery-required');
    expect(await fs.readFile(path, 'utf8')).toBe('winner');
    const entry = reopened.snapshot.fileMutations[0]?.privatePaths.find(value => value.role === (phase === 'publish' ? 'capture' : 'rollback-capture'));
    expect(await fs.readFile(join(root, entry?.name ?? ''), 'utf8')).toBe(phase === 'publish' ? 'old' : 'new');
  }), 60000);

  it.concurrent.each(['exact', 'divergent'] as const)('reopens an %s declared orphan prepared file', async kind => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let crashed = false;
    const filesystem = new TransactionFilesystem(base.context, (point, eventPath) => {
      if (crashed) throw new Error('stopped');
      if (point === 'after-action' && eventPath.startsWith('file:') && eventPath.endsWith('-prepared')) { crashed = true; throw new Error('crash'); }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    await expect(tx.publish()).rejects.toThrow();
    const prepared = join(root, tx.snapshot.fileMutations[0]?.privatePaths.find(entry => entry.role === 'prepared')?.name ?? '');
    if (kind === 'divergent') await fs.writeFile(prepared, 'divergent');
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe(kind === 'exact' ? 'rolled-back' : 'recovery-required');
    expect(await fs.readFile(path, 'utf8')).toBe('old');
    if (kind === 'exact') { await reopened.cleanup(); await expect(fs.lstat(prepared)).rejects.toMatchObject({ code: 'ENOENT' }); }
    else { expect(await fs.readFile(prepared, 'utf8')).toBe('divergent'); await expect(reopened.cleanup()).rejects.toThrow(); }
  }), 60000);

  it('keeps capture and fsync bound to the held parent; refuses a replacement parent on the next step', async () => fixture(async (root, context, base) => {
    const parent = join(root, 'parent'); await fs.mkdir(parent, { mode: 0o700 });
    const path = join(parent, 'file'); let raced = false;
    const filesystem = new TransactionFilesystem(base.context, () => {}, request => {
      const action = JSON.parse(request.input) as { action: string };
      if (raced || action.action !== 'capture') return runTransactionChild(request);
      raced = true;
      return runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === 'after-capture') { await io.rename(${JSON.stringify(parent)}, ${JSON.stringify(parent + '-old')}); await io.mkdir(${JSON.stringify(parent)}, { mode: 448 }); await io.writeFile(${JSON.stringify(path)}, 'winner', { mode: 384 }); } };`) });
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    await expect(tx.publish()).rejects.toThrow(); expect(raced).toBe(true);
    expect(await (await FilesystemTransaction.open(context, base)).compensate()).toBe('recovery-required');
    expect(await fs.readFile(path, 'utf8')).toBe('winner');
    const capture = tx.snapshot.fileMutations[0]?.privatePaths.find(entry => entry.role === 'capture');
    expect(await fs.readFile(join(parent + '-old', capture?.name ?? ''), 'utf8')).toBe('old');
  }), 60000);

  it.concurrent.each([
    ['file', 'after-file-write'], ['capture', 'after-capture'], ['publish', 'after-publication'], ['publish', 'after-prepared-unlink'],
  ] as const)('reopens undo %s / %s before durability or completion evidence', async (action, checkpoint) => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let active = false; let stopped = false; let fired = false;
    const filesystem = new TransactionFilesystem(base.context, () => { if (stopped) throw new Error('stopped'); }, async request => {
      const operation = JSON.parse(request.input) as { action: string; name: string };
      if (!active || operation.action !== action || action === 'file' && !operation.name.endsWith('-rollback-prepared') || fired) return runTransactionChild(request);
      fired = true;
      try { return await runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === ${JSON.stringify(checkpoint)}) process.exit(86); };`) }); }
      finally { stopped = true; }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem); await tx.publish(); active = true;
    await expect(tx.compensate()).rejects.toThrow(); expect(fired).toBe(true);
    const syncs: string[] = [];
    const recoveryFs = new TransactionFilesystem(base.context, (boundary, eventPath) => { if (boundary === 'after-action') syncs.push(eventPath); });
    const reopened = await FilesystemTransaction.open(context, recoveryFs);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(path, 'utf8')).toBe('old');
    expect((await fs.lstat(path)).nlink).toBe(1);
    expect(syncs.some(event => event === `sync-file:${path}` || event === `publish:${path}`)).toBe(true);
    await reopened.cleanup();
  }), 60000);
});

const journalProof = [
  ['publish', 'publishing-files', 'planned', 'none'], ['publish', 'publishing-files', 'intent', 'none'],
  ['publish', 'publishing-files', 'intent', 'file:prepared'], ['publish', 'publishing-files', 'intent', 'publish:destination'],
  ['publish', 'publishing-files', 'completed', 'none'], ['publish', 'publishing-files', 'completed', 'remove:capture'],
  ['compensate', 'rolling-back', 'completed', 'none'], ['compensate', 'rolling-back', 'compensating', 'none'],
  ['compensate', 'rolling-back', 'compensating', 'file:rollback-prepared'], ['compensate', 'rolling-back', 'compensating', 'publish:destination'],
  ['compensate', 'rolling-back', 'compensating', 'remove:rollback-capture'],
  ['compensate', 'rolling-back', 'compensated', 'none'], ['compensate', 'rolled-back', 'compensated', 'none'],
] as const;
describe('journal step/progress crash proof', () => {
  it.concurrent.each(journalProof.flatMap(([phase, state, progress, pending]) => (['before-journal', 'after-journal'] as const)
    .map(boundary => ({ phase, state, progress, pending, boundary }))))('$phase / $state / $progress / $pending / $boundary', async ({ phase, state, progress, pending, boundary }) => fixture(async (root, context, base) => {
    const path = join(root, 'file'); let stopped = false; let active = false;
    const filesystem = new TransactionFilesystem(base.context, point => {
      if (stopped) throw new Error('stopped');
      if (!active || point !== boundary) return;
      const snapshot = tx.snapshot; const record = snapshot.fileMutations[0];
      const step = record?.pending ? `${record.pending.action}:${record.pending.role}` : 'none';
      if (snapshot.state === state && record?.progress === progress && step === pending) { stopped = true; throw new Error('crash'); }
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    if (phase === 'compensate') await tx.publish(); active = true;
    try { await tx[phase](); } catch { /* Simulated process remains stopped. */ }
    expect(stopped).toBe(true);
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(path, 'utf8')).toBe('old');
    await reopened.cleanup();
  }), 60000);

  it.concurrent.each(['symlink', 'directory'] as const)('syncs an inferred restored %s after undo creation crashed before parent fsync', async kind => fixture(async (root, context, base) => {
    const path = join(root, 'owned');
    const before: ManifestArtifact = kind === 'symlink' ? { kind, path, mode: 0o777, target: '/literal/unreadable' } : { kind, path, mode: 0o700 };
    if (kind === 'symlink') await symlink('/literal/unreadable', path); else await fs.mkdir(path, { mode: 0o700 });
    let active = false; let stopped = false;
    const filesystem = new TransactionFilesystem(base.context, () => { if (stopped) throw new Error('stopped'); }, async request => {
      const operation = JSON.parse(request.input) as { action: string; name: string };
      if (!active || operation.name !== 'owned' || operation.action !== (kind === 'symlink' ? 'link' : 'directory')) return runTransactionChild(request);
      try { return await runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === 'after-action') process.exit(86); };`) }); }
      finally { stopped = true; }
    });
    const tx = await FilesystemTransaction.begin(context, input([{ before, after: null }]), filesystem); await tx.publish(); active = true;
    await expect(tx.compensate()).rejects.toThrow(); expect(stopped).toBe(true);
    const syncs: string[] = [];
    const recoveryFs = new TransactionFilesystem(base.context, (boundary, eventPath) => { if (boundary === 'after-action') syncs.push(eventPath); });
    const reopened = await FilesystemTransaction.open(context, recoveryFs);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(syncs).toContain(`sync:${path}`);
    expect((await base.inspect(path)).kind).toBe(kind); await reopened.cleanup();
  }), 60000);

  it.concurrent.each(['exact', 'divergent'] as const)('conditionally reconciles an %s journal successor on terminal cleanup', async kind => fixture(async (root, context, base) => {
    const path = join(root, 'file');
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), base); await tx.publish();
    await tx.transition('patching-paseo'); await tx.transition('verifying'); await tx.transition('committed');
    await fs.writeFile(join(tx.directory, 'journal.next'), kind === 'exact' ? serializeJournal(tx.snapshot, context) : 'unknown', { mode: 0o600 });
    const reopened = await FilesystemTransaction.open(context, base);
    if (kind === 'exact') { await reopened.cleanup(); await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' }); }
    else { await expect(reopened.cleanup()).rejects.toThrow(); expect(await fs.readFile(join(tx.directory, 'journal.next'), 'utf8')).toBe('unknown'); }
    expect(await fs.readFile(path, 'utf8')).toBe('new');
  }), 60000);
});


it('reopens terminal cleanup beneath multiple already-compensated directory ancestors', async () => fixture(async (root, context, filesystem) => {
  const parent = join(root, 'role'); const nested = join(parent, 'nested');
  const tx = await FilesystemTransaction.begin(context, input([
    { before: null, after: { kind: 'directory', path: parent, mode: 0o700 } },
    { before: null, after: { kind: 'directory', path: nested, mode: 0o700 } }, create(join(nested, 'file')),
  ]), filesystem);
  await tx.publish(); expect(await tx.compensate()).toBe('rolled-back');
  await (await FilesystemTransaction.open(context, filesystem)).cleanup();
  await expect(fs.lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' });
}), 60000);

describe('nested removal and cleanup durability regressions', () => {
  it('retires child captures before removing a parent and can compensate after reopen', async () => fixture(async (root, context, base) => {
    const directory = join(root, 'role');
    const child = join(directory, 'owned');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(child, 'old', { mode: 0o600 });
    const tx = await FilesystemTransaction.begin(context, input([
      { before: owned(child), after: null },
      { before: { kind: 'directory', path: directory, mode: 0o700 }, after: null },
    ]), base);
    await tx.publish();
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(child, 'utf8')).toBe('old');
    await reopened.cleanup();
  }), 30000);

  it('fully commits and cleans a nested child-before-parent removal', async () => fixture(async (root, context, base) => {
    const directory = join(root, 'role');
    const child = join(directory, 'owned');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(child, 'old', { mode: 0o600 });
    const tx = await FilesystemTransaction.begin(context, input([
      { before: owned(child), after: null },
      { before: { kind: 'directory', path: directory, mode: 0o700 }, after: null },
    ]), base);
    await tx.publish();
    await tx.transition('patching-paseo');
    await tx.transition('verifying');
    await tx.transition('committed');
    const reopened = await FilesystemTransaction.open(context, base);
    await reopened.cleanup();
    await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }), 30000);

  it('reopens an internal cleanup unlink-before-parent-fsync crash and establishes the missing barrier', async () => fixture(async (root, context, base) => {
    const path = join(root, 'file');
    let active = false;
    let crashed = false;
    const filesystem = new TransactionFilesystem(base.context, () => {}, request => {
      const operation = JSON.parse(request.input) as { action: string; name: string };
      if (!active || crashed || operation.action !== 'remove' || operation.name !== 'file-0' || !request.cwd.endsWith('/staging')) {
        return runTransactionChild(request);
      }
      crashed = true;
      return runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        "const checkpoint = async (point) => { if (point === 'after-remove') process.exit(86); };") });
    });
    const tx = await FilesystemTransaction.begin(context, input([await update(path)]), filesystem);
    await tx.publish();
    await tx.transition('patching-paseo');
    await tx.transition('verifying');
    await tx.transition('committed');
    active = true;
    await expect(tx.cleanup()).rejects.toThrow();
    expect(crashed).toBe(true);
    const barriers: string[] = [];
    const recoveryFs = new TransactionFilesystem(base.context, (boundary, eventPath) => {
      if (boundary === 'after-action' && eventPath.startsWith('sync:')) barriers.push(eventPath);
    });
    const reopened = await FilesystemTransaction.open(context, recoveryFs);
    await reopened.cleanup();
    expect(barriers).toContain(`sync:${join(tx.directory, 'staging/file-0')}`);
    await expect(fs.lstat(tx.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }), 30000);

  it('rebinds child parent identity after a crash between directory restore and rebind', async () => fixture(async (root, context, base) => {
    const directory = join(root, 'role');
    const child = join(directory, 'owned');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(child, 'old', { mode: 0o600 });
    let active = false;
    let stopped = false;
    const filesystem = new TransactionFilesystem(base.context, (boundary, eventPath) => {
      if (stopped) throw new Error('stopped');
      if (active && boundary === 'after-action' && eventPath === `directory:${directory}`) {
        stopped = true;
        throw new Error('crash');
      }
    });
    const tx = await FilesystemTransaction.begin(context, input([
      { before: owned(child), after: null },
      { before: { kind: 'directory', path: directory, mode: 0o700 }, after: null },
    ]), filesystem);
    await tx.publish();
    active = true;
    await expect(tx.compensate()).rejects.toThrow();
    expect(stopped).toBe(true);
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(child, 'utf8')).toBe('old');
    await reopened.cleanup();
  }), 30000);

  it('reconciles a journal successor written after directory child-parent rebinding', async () => fixture(async (root, context, base) => {
    const directory = join(root, 'role');
    const child = join(directory, 'owned');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(child, 'old', { mode: 0o600 });
    let active = false;
    let stopped = false;
    let oldChildParentInode = -1;
    const filesystem = new TransactionFilesystem(base.context, (boundary, eventPath) => {
      if (stopped) throw new Error('stopped');
      if (!active || boundary !== 'after-fsync' || !eventPath.endsWith('/journal.next')) return;
      const childRecord = tx.snapshot.fileMutations.find(record => record.destination === child);
      if (childRecord?.parent && childRecord.parent.inode !== oldChildParentInode) {
        stopped = true;
        throw new Error('crash');
      }
    });
    const tx = await FilesystemTransaction.begin(context, input([
      { before: owned(child), after: null },
      { before: { kind: 'directory', path: directory, mode: 0o700 }, after: null },
    ]), filesystem);
    await tx.publish();
    oldChildParentInode = tx.snapshot.fileMutations.find(record => record.destination === child)?.parent?.inode ?? -1;
    active = true;
    await expect(tx.compensate()).rejects.toThrow();
    expect(stopped).toBe(true);
    expect((await fs.lstat(join(tx.directory, 'journal.next'))).isFile()).toBe(true);
    const reopened = await FilesystemTransaction.open(context, base);
    expect(await reopened.compensate()).toBe('rolled-back');
    expect(await fs.readFile(child, 'utf8')).toBe('old');
    await reopened.cleanup();
  }), 30000);
});
