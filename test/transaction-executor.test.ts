import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, sha256 } from '../src/core/hash.js';
import { buildManifestProviders, loadManifest, type InstallationManifestV1 } from '../src/core/manifest.js';
import { executeTransaction, type ExecuteTransactionInput, type ExecutorDependencies } from '../src/core/transaction-executor.js';
import { ManifestCommit, loadManifestPublication } from '../src/core/manifest-commit.js';
import { absentTransactionProviders, loadJournal, FilesystemTransaction } from '../src/core/transaction.js';
import { TransactionFilesystem, runTransactionChild, type TransactionFault } from '../src/core/transaction-fs.js';
import { endpointIdentitySha256 } from '../src/paseo/cli-probe.js';
import { type TransactionGateway } from '../src/paseo/transaction-gateway.js';
import { policyFixture } from './helpers/provider-policy.js';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const f = await setup();
  try { await test(f); } finally { await fs.rm(f.root, { recursive: true, force: true }); }
}
async function setup() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paseo-executor-')));
  const roomHome = join(root, 'room');
  const context = { roomHome, transactionId: 'tx-1' };
  const path = join(roomHome, 'owned.txt');
  const policy = policyFixture(['/opt/codex'], root);
  const admission = { localHome: join(root, 'paseo'), listen: 'ws://127.0.0.1:6767',
    endpointIdentitySha256: endpointIdentitySha256(join(root, 'paseo'), 'ws://127.0.0.1:6767'),
    cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' };
  const manifest: InstallationManifestV1 = { schemaVersion: 1, packageVersion: '0.1.0', installationId: 'fixture', lastTransactionId: 'tx-1',
    status: 'committed', adapter: 'codex', paseo: { ...admission, minimumVersion: '0.8.0-beta.1' },
    source: { canonicalHome: join(root, 'canonical'), canonicalConfigSha256: sha256('source'), codexLaunchArgv: ['/opt/codex'], codexVersion: '1.0.0' },
    artifacts: [{ kind: 'file', path, mode: 0o600, sha256: sha256('new') }], providers: buildManifestProviders(policy), committedAt: '2026-09-09T09:00:00Z' };
  const input: ExecuteTransactionInput = { apply: true, admission, context, manifest,
    transaction: { operation: 'install', previousManifest: null, changes: [{ before: null, after: { kind: 'file', path, mode: 0o600, content: 'new' } }],
      providerBefore: absentTransactionProviders(), providerAfter: policy, validateArtifacts: () => {} } };
  const providers: Record<string, unknown> = { unrelated: { custom: 'preserve' } };
  const gateway = {
    readConfig: vi.fn<TransactionGateway['readConfig']>(() => Promise.resolve({ providers: structuredClone(providers) })),
    patchProviders: vi.fn<TransactionGateway['patchProviders']>(values => { Object.assign(providers, values); return Promise.resolve({ providers: structuredClone(providers) }); }),
    removeProviders: vi.fn<TransactionGateway['removeProviders']>(() => Promise.reject(new Error('Whole-set removal is forbidden here.'))),
    restoreProviders: vi.fn<TransactionGateway['restoreProviders']>(values => { for (const [id, value] of Object.entries(values)) {
      if (value === null) Reflect.deleteProperty(providers, id); else providers[id] = value;
    } return Promise.resolve(); }),
    sessionsSafe: vi.fn<TransactionGateway['sessionsSafe']>(() => Promise.resolve(true)),
    verify: vi.fn<TransactionGateway['verify']>(() => Promise.resolve({ ok: true, checks: [], readyProviderIds: ['codex-supervisor', 'codex-lead', 'codex-peer'], activeManagedProviderIds: [] })),
    verifyRestored: vi.fn<TransactionGateway['verifyRestored']>(() => Promise.resolve(true)),
  };
  let fault: TransactionFault = () => {};
  const disk = new TransactionFilesystem({ roomHome, uid: process.getuid?.() ?? -1 }, (boundary, destination) => fault(boundary, destination));
  const release = vi.fn(() => Promise.resolve());
  const lock = vi.fn(() => Promise.resolve({ release }));
  const signals = new EventEmitter();
  const deps: ExecutorDependencies = { filesystem: disk, signals, lock,
    gateway: operation => operation(gateway, admission) };
  return { root, roomHome, path, context, input, policy, providers, gateway, deps, signals, release, lock,
    fault: (handler: TransactionFault) => { fault = handler; } };
}

describe('locked provider/file transaction', { timeout: 30_000 }, () => {
  it('rejects an empty pre-existing root without declaring bootstrap ownership', async () => fixture(async f => {
    await fs.mkdir(f.roomHome, { mode: 0o700 });
    expect(await executeTransaction(f.input, f.deps)).toBe('conflict');
    expect(await fs.readdir(f.root)).toEqual(['room']);
    expect(f.gateway.patchProviders).not.toHaveBeenCalled();
  }));
  it('commits one complete patch, linked transaction ID, and makes second no-op mutation-free', async () => fixture(async f => {
    expect(await executeTransaction(f.input, f.deps)).toBe('committed');
    expect(vi.mocked(f.gateway.patchProviders).mock.calls).toEqual([[f.policy]]);
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' }, ...f.policy });
    expect(loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), f.context).lastTransactionId).toBe('tx-1');
    expect(await fs.readdir(join(f.roomHome, 'transactions'))).toEqual([]);
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
    expect((await fs.stat(join(f.roomHome, 'manifest.json'))).mode & 0o777).toBe(0o600);
    const before = await fs.readdir(f.roomHome);
    expect(await executeTransaction({ noop: true }, f.deps)).toBe('noop');
    expect(f.lock).toHaveBeenCalledOnce();
    expect(f.gateway.patchProviders).toHaveBeenCalledOnce();
    expect(await fs.readdir(f.roomHome)).toEqual(before);
    expect(f.release).toHaveBeenCalledOnce();
  }));
  it.each(['active', 'ambiguous', 'ownership', 'admission', 'journal', 'unauthorized'] as const)('refuses %s before mutation', async kind => fixture(async f => {
    let input = f.input;
    let deps = f.deps;
    if (kind === 'active' || kind === 'ambiguous') vi.mocked(f.gateway.sessionsSafe).mockResolvedValue(false);
    if (kind === 'ownership') f.providers['codex-peer'] = f.policy['codex-peer'];
    if (kind === 'admission') deps = { ...deps, gateway: operation => operation(f.gateway, { ...f.input.admission, listen: 'ws://127.0.0.1:6768' }) };
    if (kind === 'journal') { await fs.mkdir(f.roomHome, { mode: 0o700 }); await fs.mkdir(join(f.roomHome, 'transactions'), { mode: 0o700 }); await fs.mkdir(join(f.roomHome, 'transactions/unfinished'), { mode: 0o700 }); }
    if (kind === 'unauthorized') input = { ...input, apply: false };
    expect(await executeTransaction(input, deps)).toBe(kind === 'journal' ? 'recovery-required' : 'conflict');
    expect(f.gateway.patchProviders).not.toHaveBeenCalled();
    if (kind === 'journal') expect(await fs.readdir(f.roomHome)).toEqual(['transactions']);
    else await expect(fs.lstat(f.roomHome)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it.each(['patch-before', 'patch-after', 'verify', 'readback', 'manifest-before', 'file', 'signal'] as const)('conditionally restores after %s without retry', async kind => fixture(async f => {
    if (kind.startsWith('patch')) vi.mocked(f.gateway.patchProviders).mockImplementation(values => {
      if (kind === 'patch-after') Object.assign(f.providers, values);
      return Promise.reject(new Error('Ambiguous synthetic error'));
    });
    if (kind === 'verify') vi.mocked(f.gateway.verify).mockResolvedValue({ ok: false, checks: [], readyProviderIds: [], activeManagedProviderIds: [] });
    if (kind === 'readback') {
      let reads = 0;
      f.gateway.readConfig.mockImplementation(() => {
        reads++;
        return reads === 3 ? Promise.reject(new Error('ambiguous readback')) : Promise.resolve({ providers: structuredClone(f.providers) });
      });
    }
    let fired = false;
    f.fault((boundary, path) => {
      if (fired) return;
      if (kind === 'manifest-before' && boundary === 'before-action' && path.includes('file:') && path.endsWith('-manifest-prepared') ||
          kind === 'file' && boundary === 'after-mutation' && path === f.path) { fired = true; throw new Error('fault'); }
      if (kind === 'signal' && boundary === 'after-mutation' && path === f.path) { fired = true; f.signals.emit('SIGTERM'); }
    });
    expect(await executeTransaction(f.input, f.deps)).toBe(kind.startsWith('patch') ? 'recovery-required' : 'rolled-back');
    expect(f.providers).toEqual(kind === 'patch-after' ? { unrelated: { custom: 'preserve' }, ...f.policy } : { unrelated: { custom: 'preserve' } });
    if (kind.startsWith('patch')) expect(await fs.readFile(f.path, 'utf8')).toBe('new');
    else await expect(fs.lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(vi.mocked(f.gateway.patchProviders).mock.calls.length).toBeLessThanOrEqual(1);
    expect(f.signals.listenerCount('SIGTERM')).toBe(0);
  }), 30000);
  it.each(['session', 'provider'])('retains files if a late %s blocks activation', async kind => fixture(async f => {
    if (kind === 'session') f.gateway.sessionsSafe.mockResolvedValueOnce(true).mockResolvedValue(false);
    else f.fault((boundary, path) => {
      if (boundary === 'after-mutation' && path === f.path) f.providers['codex-peer'] = { external: true };
    });
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(f.gateway.patchProviders).not.toHaveBeenCalled();
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));
  it('preserves divergent provider, restores only exact after entries and retains file evidence', async () => fixture(async f => {
    vi.mocked(f.gateway.verify).mockImplementation(() => {
      f.providers['codex-peer'] = { custom: 'external-writer' };
      return Promise.resolve({ ok: false, checks: [], readyProviderIds: [], activeManagedProviderIds: [] });
    });
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' }, 'codex-peer': { custom: 'external-writer' } });
    expect(vi.mocked(f.gateway.restoreProviders).mock.calls).toEqual([[{ 'codex-supervisor': null, 'codex-lead': null }]]);
    const journal = loadJournal(await fs.readFile(join(f.roomHome, 'transactions/tx-1/journal.json')), f.context);
    expect(journal.state).toBe('recovery-required');
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));
  it('retains recovery evidence when a reverse RPC has no completion result', async () => fixture(async f => {
    vi.mocked(f.gateway.verify).mockResolvedValue({ ok: false, checks: [], readyProviderIds: [], activeManagedProviderIds: [] });
    vi.mocked(f.gateway.restoreProviders).mockImplementation(values => {
      for (const id of Object.keys(values)) Reflect.deleteProperty(f.providers, id);
      return Promise.reject(new Error('lost response'));
    });
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(f.gateway.restoreProviders).toHaveBeenCalledOnce();
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
    expect(loadJournal(await fs.readFile(join(f.roomHome, 'transactions/tx-1/journal.json')), f.context).state).toBe('recovery-required');
  }));
  it('retains recovery evidence when a failed forward RPC completes later', async () => fixture(async f => {
    vi.mocked(f.gateway.patchProviders).mockImplementation(values => new Promise((_resolve, reject) => {
      reject(new Error('timeout'));
      setTimeout(() => { Object.assign(f.providers, values); }, 10);
    }));
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' }, ...f.policy });
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));
  it('retains files until restored provider registry state is verified', async () => fixture(async f => {
    vi.mocked(f.gateway.verify).mockResolvedValue({ ok: false, checks: [], readyProviderIds: [], activeManagedProviderIds: [] });
    vi.mocked(f.gateway.verifyRestored).mockResolvedValue(false);
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' } });
    expect(f.gateway.verifyRestored).toHaveBeenCalledWith(absentTransactionProviders(), f.policy);
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));
  it('never reverses providers after a matching manifest publication fault', async () => fixture(async f => {
    let fired = false;
    f.fault((boundary, path) => {
      if (!fired && boundary === 'after-action' && path === `publish:${join(f.roomHome, 'manifest.json')}`) { fired = true; throw new Error('lost completion'); }
    });
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), f.context).lastTransactionId).toBe('tx-1');
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' }, ...f.policy });
  }));
  it('preserves file divergence during compensation', async () => fixture(async f => {
    vi.mocked(f.gateway.verify).mockImplementation(async () => {
      await fs.writeFile(f.path, 'external');
      return { ok: false, checks: [], readyProviderIds: [], activeManagedProviderIds: [] };
    });
    expect(await executeTransaction(f.input, f.deps)).toBe('recovery-required');
    expect(await fs.readFile(f.path, 'utf8')).toBe('external');
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' } });
  }));
  it('updates an owned manifest with capture/no-clobber, not an overwriting rename', async () => fixture(async f => {
    expect(await executeTransaction(f.input, f.deps)).toBe('committed');
    const previous = loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), f.context);
    const input: ExecuteTransactionInput = { ...f.input, context: { ...f.context, transactionId: 'tx-2' },
      manifest: { ...previous, lastTransactionId: 'tx-2', artifacts: [{ kind: 'file', mode: 0o600, path: f.path, sha256: sha256('updated') }] },
      transaction: { ...f.input.transaction, operation: 'update', previousManifest: previous, providerBefore: f.policy,
        changes: [{ before: previous.artifacts[0] ?? null, after: { kind: 'file', path: f.path, mode: 0o600, content: 'updated' } }] } };
    const actions: string[] = [];
    f.fault((boundary, path) => { if (boundary === 'before-action') actions.push(path); });
    expect(await executeTransaction(input, f.deps)).toBe('committed');
    expect(await fs.readFile(f.path, 'utf8')).toBe('updated');
    expect(canonicalJson(actions)).toContain('-manifest-capture');
    expect(actions).not.toContain(`rename:${join(f.roomHome, 'manifest.json')}`);
  }), 20000);
});

async function existingFixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  await fixture(async f => { await fs.mkdir(f.roomHome, { mode: 0o700 }); await test(f); });
}

describe('manifest commit crash/race boundaries', () => {
  it.each([
    ['file', 'after-file-write', false], ['capture', 'after-capture', false],
    ['publish', 'after-publication', true], ['publish', 'after-prepared-unlink', true],
    ['publish', 'before-parent-sync', true], ['publish', 'after-parent-sync', true],
  ] as const)('reconciles %s / %s without overwriting or retrying', async (action, point, isCommitted) => existingFixture(async f => {
    const previous = { ...f.input.manifest, lastTransactionId: 'old' };
    const original = canonicalJson(previous) + '\n';
    await fs.writeFile(join(f.roomHome, 'manifest.json'), original, { mode: 0o600 });
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, changes: [] }, f.deps.filesystem);
    let armed = false;
    let crashed = false;
    const disk = new TransactionFilesystem(f.deps.filesystem.context, () => {}, request => {
      const operation = JSON.parse(request.input) as { action: string; name: string };
      if (!armed || crashed || operation.action !== action || action === 'file' && !operation.name.endsWith('-manifest-prepared')) return runTransactionChild(request);
      crashed = true;
      return runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === ${JSON.stringify(point)}) process.exit(86); };`) });
    });
    const publication = await ManifestCommit.prepare(f.context, disk, previous, f.input.manifest);
    armed = true;
    await expect(publication.publish()).rejects.toThrow();
    expect(crashed).toBe(true);
    expect(await publication.committed()).toBe(isCommitted);
    if (!isCommitted) await publication.restore();
    const current = loadManifest(await fs.readFile(publication.path), f.context);
    expect(current.lastTransactionId).toBe(isCommitted ? 'tx-1' : 'old');
    expect((await fs.stat(publication.path)).nlink).toBe(1);
    expect((await fs.stat(publication.path)).mode & 0o777).toBe(0o600);
    await publication.cleanup();
    expect((await fs.readdir(f.roomHome)).some(name => name.startsWith('.paseo-room-'))).toBe(false);
  }));
  it('preserves a destination winner between capture and no-clobber publication', async () => existingFixture(async f => {
    const previous = { ...f.input.manifest, lastTransactionId: 'old' };
    const path = join(f.roomHome, 'manifest.json');
    await fs.writeFile(path, canonicalJson(previous), { mode: 0o600 });
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, changes: [] }, f.deps.filesystem);
    const publication = await ManifestCommit.prepare(f.context, f.deps.filesystem, previous, f.input.manifest);
    let raced = false;
    f.fault(async (boundary, destination) => {
      if (!raced && boundary === 'before-action' && destination === `publish:${path}`) {
        raced = true;
        await fs.writeFile(path, 'external winner', { flag: 'wx', mode: 0o600 });
      }
    });
    await expect(publication.publish()).rejects.toThrow();
    await expect(publication.committed()).rejects.toThrow();
    expect(await fs.readFile(path, 'utf8')).toBe('external winner');
    expect(loadManifest(await fs.readFile(publication.capture), f.context).lastTransactionId).toBe('old');
    expect(await fs.readFile(publication.declaration, 'utf8')).toContain(publication.capture);
  }));
  it('captures a raced symlink as evidence without following it', async () => existingFixture(async f => {
    const previous = { ...f.input.manifest, lastTransactionId: 'old' };
    const path = join(f.roomHome, 'manifest.json');
    const sentinel = join(f.root, 'sentinel');
    await fs.writeFile(sentinel, 'do not read or overwrite', { mode: 0o600 });
    await fs.writeFile(path, canonicalJson(previous), { mode: 0o600 });
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, changes: [] }, f.deps.filesystem);
    const publication = await ManifestCommit.prepare(f.context, f.deps.filesystem, previous, f.input.manifest);
    let raced = false;
    f.fault(async (boundary, destination) => {
      if (!raced && boundary === 'before-action' && destination === `capture:${publication.capture}`) {
        raced = true;
        await fs.unlink(path); await fs.symlink(sentinel, path);
      }
    });
    await expect(publication.publish()).rejects.toThrow();
    await expect(publication.restore()).rejects.toThrow();
    expect(await fs.readlink(publication.capture)).toBe(sentinel);
    expect(await fs.readFile(sentinel, 'utf8')).toBe('do not read or overwrite');
  }));
  it('strictly binds sidecar recovery evidence to transaction, root and private names', async () => existingFixture(async f => {
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, changes: [] }, f.deps.filesystem);
    const publication = await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
    const evidence = loadManifestPublication(await fs.readFile(publication.declaration), f.context);
    for (const change of [{ schemaVersion: 2 }, { transactionId: 'another' }, { destination: '/elsewhere/manifest.json' },
      { prepared: join(f.roomHome, 'manifest.json') }, { capture: evidence.prepared }, { unknown: true },
      { parent: { ...evidence.parent, mode: 0o40755 } }]) {
      expect(() => loadManifestPublication(Buffer.from(JSON.stringify({ ...evidence, ...change })), f.context)).toThrow();
    }
    expect(() => loadManifestPublication(Buffer.from([0xff]), f.context)).toThrow();
  }));
  it('rejects unknown manifest bytes, wrong transaction ID and a symlink before preparation', async () => existingFixture(async f => {
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, changes: [] }, f.deps.filesystem);
    await expect(ManifestCommit.prepare(f.context, f.deps.filesystem, null, { ...f.input.manifest, lastTransactionId: 'other' })).rejects.toThrow();
    const path = join(f.roomHome, 'manifest.json');
    await fs.writeFile(path, 'unowned', { mode: 0o600 });
    await expect(ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest)).rejects.toThrow();
    await fs.unlink(path); await fs.symlink(join(f.root, 'missing'), path);
    await expect(ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest)).rejects.toThrow();
    expect(await fs.readlink(path)).toBe(join(f.root, 'missing'));
  }));
});
