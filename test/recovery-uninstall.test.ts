import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '../src/core/hash.js';
import { buildManifestProviders, loadManifest, type InstallationManifestV1 } from '../src/core/manifest.js';
import { executeTransaction, type ExecuteTransactionInput, type ExecutorDependencies } from '../src/core/transaction-executor.js';
import { ManifestCommit } from '../src/core/manifest-commit.js';
import { absentTransactionProviders, FilesystemTransaction } from '../src/core/transaction.js';
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
  await fs.mkdir(roomHome, { mode: 0o700 });
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
    transaction: { operation: 'install', previousManifest: null, bootstrapEndpointIdentitySha256: admission.endpointIdentitySha256, changes: [{ before: null, after: { kind: 'file', path, mode: 0o600, content: 'new' } }],
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

import { cleanupCommittedTransaction } from '../src/core/transaction-cleanup.js';
import { recoverTransaction } from '../src/core/recovery.js';
import { uninstallRoom, type UninstallInput } from '../src/core/uninstall.js';

const recoveryInput = (f: Awaited<ReturnType<typeof setup>>, apply = false) => ({ context: f.context, admission: f.input.admission, policy: f.policy, apply });
async function installed(f: Awaited<ReturnType<typeof setup>>): Promise<UninstallInput> {
  await fs.rmdir(f.roomHome); // First install must bootstrap an absent root, never adopt this fixture container.
  expect(await executeTransaction(f.input, f.deps)).toBe('committed');
  return { context: { ...f.context, transactionId: 'tx-2' }, admission: f.input.admission, manifest: f.input.manifest, policy: f.policy, apply: true };
}
async function snapshot(path: string): Promise<unknown> {
  const result: Record<string, unknown> = {};
  for (const name of (await fs.readdir(path)).sort()) {
    const child = join(path, name);
    const stat = await fs.lstat(child);
    result[name] = { mode: stat.mode, inode: stat.ino, links: stat.nlink, mtime: stat.mtimeMs,
      value: stat.isSymbolicLink() ? await fs.readlink(child) : stat.isDirectory() ? await snapshot(child) : (await fs.readFile(child)).toString('base64') };
  }
  return result;
}

describe('explicit recovery', { timeout: 120000 }, () => {
  it('classifies staged work without any write, lock, refresh or provider patch', async () => fixture(async f => {
    await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
    await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
    const before = await snapshot(f.roomHome);
    expect(await recoverTransaction(recoveryInput(f), f.deps)).toBe('reversible');
    expect(await snapshot(f.roomHome)).toEqual(before);
    expect(f.lock).not.toHaveBeenCalled();
    expect(f.gateway.verifyRestored).not.toHaveBeenCalled();
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe('rolled-back');
    await expect(fs.lstat(f.roomHome)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('rejects post-transfer first-install recovery through a different endpoint identity', async () => fixture(async f => {
    await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
    const other = { ...f.input.admission, listen: 'ws://127.0.0.1:7777',
      endpointIdentitySha256: endpointIdentitySha256(f.input.admission.localHome, 'ws://127.0.0.1:7777') };
    const gateway: ExecutorDependencies['gateway'] = operation => operation(f.gateway, other);
    const deps: ExecutorDependencies = { ...f.deps, gateway };
    expect(await recoverTransaction({ ...recoveryInput(f, true), admission: other }, deps)).toBe('recovery-required');
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(await fs.readdir(join(f.roomHome, 'transactions/tx-1'))).toContain('journal.json');
  }));
  it.each(['before-publication', 'after-publication', 'before-commit', 'after-commit', 'before-declaration-cleanup', 'after-declaration-cleanup', 'before-journal-cleanup', 'after-journal-cleanup'] as const)('recovers install at %s', async boundary => fixture(async f => {
      const tx = await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
      const publication = await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
      await tx.publish();
      Object.assign(f.providers, f.policy);
      await tx.transition('patching-paseo'); await tx.transition('verifying');
      if (boundary !== 'before-publication') await publication.publish();
      if (!['before-publication', 'after-publication', 'before-commit'].includes(boundary)) await tx.transition('committed');
      if (['after-declaration-cleanup', 'before-journal-cleanup', 'after-journal-cleanup'].includes(boundary)) await publication.cleanup();
      if (boundary === 'after-journal-cleanup') {
        // A killed journal-last cleanup may leave just its empty directory.
        await cleanupCommittedTransaction(tx);
        await fs.mkdir(tx.directory, { mode: 0o700 });
      }
      const before = await snapshot(f.roomHome);
      expect(await recoverTransaction(recoveryInput(f), f.deps)).toBe(boundary === 'before-publication' ? 'reversible' : 'committed-cleanup');
      expect(await snapshot(f.roomHome)).toEqual(before);
      expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe(boundary === 'before-publication' ? 'rolled-back' : 'recovered');
      if (boundary !== 'before-publication') {
        expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
        expect(await fs.readFile(f.path, 'utf8')).toBe('new');
      } else await expect(fs.lstat(f.roomHome)).rejects.toMatchObject({ code: 'ENOENT' });
      if (boundary !== 'before-publication') expect(await fs.readdir(join(f.roomHome, 'transactions'))).toEqual([]);
    }));
  it.each(['provider', 'file', 'manifest', 'journal', 'sidecar', 'foreign-child', 'rpc', 'admission', 'session'] as const)('preserves all evidence for %s divergence', async kind => fixture(async f => {
      const tx = await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
      await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
      await tx.publish(); Object.assign(f.providers, f.policy);
      if (kind === 'provider') f.providers['codex-peer'] = { customized: true };
      if (kind === 'file') await fs.writeFile(f.path, 'custom');
      if (kind === 'manifest') await fs.writeFile(join(f.roomHome, 'manifest.json'), 'malformed', { mode: 0o600 });
      if (kind === 'journal') await fs.writeFile(tx.journalPath, '{}');
      if (kind === 'sidecar') await fs.writeFile(join(tx.directory, 'manifest-publication.json'), '{}');
      if (kind === 'foreign-child' || kind === 'rpc') await fs.writeFile(join(tx.directory, kind === 'rpc' ? 'provider-mutation.pending' : 'foreign'), 'preserve', { mode: 0o600 });
      if (kind === 'session') f.gateway.sessionsSafe.mockResolvedValue(false);
      const deps: ExecutorDependencies = kind === 'admission' ? { ...f.deps, gateway: operation => operation(f.gateway, { ...f.input.admission, listen: 'ws://127.0.0.1:7777' }) } : f.deps;
      const before = await snapshot(f.roomHome);
      const providers = structuredClone(f.providers);
      expect(await recoverTransaction(recoveryInput(f), deps)).toBe('recovery-required');
      expect(await recoverTransaction(recoveryInput(f, true), deps)).toBe('recovery-required');
      expect(await snapshot(f.roomHome)).toEqual(before);
      expect(f.providers).toEqual(providers);
      expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    }));
  it('does not remove files before restored registry verification', async () => fixture(async f => {
    const tx = await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
    await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
    await tx.publish(); Object.assign(f.providers, f.policy);
    f.gateway.verifyRestored.mockResolvedValue(false);
    expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe('recovery-required');
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
    f.gateway.verifyRestored.mockResolvedValue(true);
    expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe('rolled-back');
  }));
});

describe('safe uninstall', { timeout: 120000 }, () => {
  it('dry-run is byte-for-byte read-only; apply removes only owned state', async () => fixture(async f => {
    const input = await installed(f);
    await fs.writeFile(join(f.roomHome, 'unrelated'), 'keep', { mode: 0o600 });
    f.lock.mockClear(); f.gateway.verifyRestored.mockClear();
    const before = await snapshot(f.roomHome);
    expect((await uninstallRoom({ ...input, apply: false }, f.deps)).outcome).toBe('planned');
    expect(await snapshot(f.roomHome)).toEqual(before);
    expect(f.lock).not.toHaveBeenCalled(); expect(f.gateway.verifyRestored).not.toHaveBeenCalled();
    expect((await uninstallRoom(input, f.deps)).outcome).toBe('committed');
    expect(f.providers).toEqual({ unrelated: { custom: 'preserve' } });
    expect(await fs.readFile(join(f.roomHome, 'unrelated'), 'utf8')).toBe('keep');
    await expect(fs.lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(join(f.roomHome, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it.each(['file', 'provider', 'missing', 'link', 'mode', 'hardlink'] as const)('preserves/discharges %s and writes exact residual ownership', async kind => fixture(async f => {
    const input = await installed(f);
    if (kind === 'file') await fs.writeFile(f.path, 'custom');
    if (kind === 'provider') f.providers['codex-peer'] = { customized: true };
    if (kind === 'missing') await fs.unlink(f.path);
    if (kind === 'link') { await fs.unlink(f.path); await fs.symlink(join(f.root, 'nonexistent'), f.path); }
    if (kind === 'mode') await fs.chmod(f.path, 0o644);
    if (kind === 'hardlink') await fs.link(f.path, join(f.roomHome, 'alias'));
    const result = await uninstallRoom(input, f.deps);
    expect(result.outcome).toBe(kind === 'missing' ? 'committed' : 'conflict');
    if (kind === 'missing') return;
    const residual = loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), input.context);
    expect(residual.status).toBe('uninstall-incomplete');
    expect(residual.artifacts).toEqual(input.manifest.artifacts);
    expect(Object.keys(residual.providers)).toEqual(kind === 'provider' ? ['codex-peer'] : []);
    expect(await fs.readdir(join(f.roomHome, 'transactions'))).toEqual([]);
    // User explicitly reconciles customization. A later uninstall discharges it.
    if (kind === 'provider') Reflect.deleteProperty(f.providers, 'codex-peer');
    if (kind === 'hardlink') await fs.unlink(join(f.roomHome, 'alias'));
    if (kind === 'mode') await fs.chmod(f.path, 0o600);
    if (kind === 'link') { await fs.unlink(f.path); await fs.writeFile(f.path, 'new', { mode: 0o600 }); }
    if (kind === 'file') await fs.writeFile(f.path, 'new');
    expect((await uninstallRoom({ ...input, manifest: residual, context: { ...input.context, transactionId: 'tx-3' } }, f.deps)).outcome).toBe('committed');
  }));
  it.each(['active', 'refresh', 'rpc', 'journal'] as const)('retains files on %s refusal', async kind => fixture(async f => {
    const input = await installed(f);
    if (kind === 'active') f.gateway.sessionsSafe.mockResolvedValue(false);
    if (kind === 'refresh') f.gateway.verifyRestored.mockResolvedValue(false);
    if (kind === 'rpc') f.gateway.restoreProviders.mockRejectedValue(new Error('lost response'));
    if (kind === 'journal') await fs.mkdir(join(f.roomHome, 'transactions/unfinished'), { mode: 0o700 });
    expect((await uninstallRoom(input, f.deps)).outcome).toBe(kind === 'active' ? 'conflict' : 'recovery-required');
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));
  it.each(['before-commit', 'after-commit', 'before-deletion', 'after-deletion', 'before-cleanup', 'after-cleanup'] as const)('recovers full uninstall crash %s', async boundary => fixture(async f => {
      const input = await installed(f);
      let fired = false;
      f.fault(async (point, path) => {
        if (fired) return;
        let hit = false;
        if (['before-commit', 'after-commit'].includes(boundary) && point === (boundary === 'before-commit' ? 'before-journal' : 'after-journal') && path.endsWith('tx-2/journal.json')) {
          const text = await fs.readFile(path, 'utf8').catch(() => '{}');
          const journal = JSON.parse(text) as { state?: string };
          hit = journal.state === (boundary === 'before-commit' ? 'verifying' : 'committed');
        }
        if (boundary === 'before-deletion') hit = point === 'before-action' && path.startsWith('capture:') && path.endsWith('-manifest-capture');
        if (boundary === 'after-deletion') hit = point === 'after-action' && path.startsWith('capture:') && path.endsWith('-manifest-capture');
        if (boundary === 'before-cleanup') hit = point === 'before-action' && path === `remove:${join(f.roomHome, 'transactions/tx-2/journal.json')}`;
        if (boundary === 'after-cleanup') hit = point === 'after-action' && path === `remove:${join(f.roomHome, 'transactions/tx-2/journal.json')}`;
        if (hit) { fired = true; throw new Error('power loss'); }
      });
      expect((await uninstallRoom(input, f.deps)).outcome).toBe('recovery-required');
      expect(fired).toBe(true); f.fault(() => {});
      const recovery = { ...recoveryInput(f, true), context: input.context };
      expect(await recoverTransaction(recovery, f.deps)).toBe(boundary === 'before-commit' ? 'rolled-back' : 'recovered');
      if (boundary === 'before-commit') {
        expect(await fs.readFile(f.path, 'utf8')).toBe('new'); expect(f.providers).toEqual({ unrelated: { custom: 'preserve' }, ...f.policy });
      } else await expect(fs.lstat(join(f.roomHome, 'manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await fs.readdir(join(f.roomHome, 'transactions'))).toEqual([]);
    }));
  it.each(['before', 'after'] as const)('recovers partial uninstall %s residual publication', async boundary => fixture(async f => {
    const input = await installed(f);
    await fs.writeFile(f.path, 'custom');
    let fired = false;
    f.fault((point, path) => {
      if (!fired && point === `${boundary}-action` && path === `publish:${join(f.roomHome, 'manifest.json')}`) { fired = true; throw new Error('crash'); }
    });
    expect((await uninstallRoom(input, f.deps)).outcome).toBe('recovery-required');
    f.fault(() => {});
    expect(await recoverTransaction({ ...recoveryInput(f, true), context: input.context }, f.deps)).toBe(boundary === 'before' ? 'rolled-back' : 'recovered');
    expect(await fs.readFile(f.path, 'utf8')).toBe('custom');
    expect(loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), input.context).status).toBe(boundary === 'before' ? 'committed' : 'uninstall-incomplete');
  }));
});


describe('restart boundary matrix', { timeout: 120000 }, () => {
  it.each([
    ['file', 'after-file-write', false], ['capture', 'after-capture', false],
    ['publish', 'after-publication', true], ['publish', 'after-prepared-unlink', true],
    ['publish', 'after-parent-sync', true],
  ] as const)('reopens update sidecar after %s/%s', async (action, checkpoint, committed) => fixture(async f => {
    const previous = { ...f.input.manifest, lastTransactionId: 'old', artifacts: [{ ...f.input.manifest.artifacts[0], kind: 'file' as const, path: f.path, mode: 0o600 as const, sha256: sha256('old') }] };
    await fs.writeFile(f.path, 'old', { mode: 0o600 });
    await fs.writeFile(join(f.roomHome, 'manifest.json'), JSON.stringify(previous), { mode: 0o600 });
    Object.assign(f.providers, f.policy);
    const tx = await FilesystemTransaction.begin(f.context, { ...f.input.transaction, operation: 'update', previousManifest: previous,
      bootstrapEndpointIdentitySha256: null, providerBefore: f.policy, changes: [{ before: previous.artifacts[0] ?? null, after: { kind: 'file', path: f.path, mode: 0o600, content: 'new' } }] }, f.deps.filesystem);
    let armed = false;
    let fired = false;
    const disk = new TransactionFilesystem(f.deps.filesystem.context, () => {}, request => {
      const operation = JSON.parse(request.input) as { action: string; name: string };
      if (!armed || fired || operation.action !== action || action === 'file' && !operation.name.endsWith('-manifest-prepared')) return runTransactionChild(request);
      fired = true;
      return runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === ${JSON.stringify(checkpoint)}) process.exit(86); };`) });
    });
    const publication = await ManifestCommit.prepare(f.context, disk, previous, f.input.manifest);
    await tx.publish(); await tx.transition('patching-paseo'); await tx.transition('verifying');
    armed = true; await expect(publication.publish()).rejects.toThrow(); expect(fired).toBe(true);
    const before = await snapshot(f.roomHome);
    expect(await recoverTransaction(recoveryInput(f), f.deps)).toBe(committed ? 'committed-cleanup' : 'reversible');
    expect(await snapshot(f.roomHome)).toEqual(before);
    expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe(committed ? 'recovered' : 'rolled-back');
    expect(await fs.readFile(f.path, 'utf8')).toBe(committed ? 'new' : 'old');
    expect((await fs.stat(publication.path)).nlink).toBe(1);
    expect(loadManifest(await fs.readFile(publication.path), f.context).lastTransactionId).toBe(committed ? 'tx-1' : 'old');
  }));
  it.each(['file-0', 'before', 'staging'] as const)('resumes committed bundle cleanup after deleting %s', async leaf => fixture(async f => {
    const input = await installed(f);
    let fired = false;
    f.fault((point, path) => {
      if (!fired && point === 'after-action' && path === `remove:${join(f.roomHome, 'transactions/tx-2', leaf === 'file-0' ? 'before/file-0' : leaf)}`) {
        fired = true; throw new Error('crash');
      }
    });
    expect((await uninstallRoom(input, f.deps)).outcome).toBe('recovery-required'); expect(fired).toBe(true);
    f.fault(() => {});
    const before = await snapshot(f.roomHome);
    const request = { ...recoveryInput(f), context: input.context };
    expect(await recoverTransaction(request, f.deps)).toBe('committed-cleanup');
    expect(await snapshot(f.roomHome)).toEqual(before);
    expect(await recoverTransaction({ ...request, apply: true }, f.deps)).toBe('recovered');
  }));
  it('preserves mutable children and only unresolved file/directory ownership', async () => fixture(async f => {
    const input = await installed(f);
    const directory = join(f.roomHome, 'nested');
    await fs.mkdir(directory, { mode: 0o700 });
    const owned = join(directory, 'owned'); const runtime = join(directory, 'runtime');
    await fs.writeFile(owned, 'owned', { mode: 0o600 }); await fs.writeFile(runtime, 'runtime', { mode: 0o600 });
    await fs.writeFile(f.path, 'custom');
    const manifest: InstallationManifestV1 = { ...input.manifest, artifacts: [...input.manifest.artifacts,
      { kind: 'directory', mode: 0o700, path: f.roomHome }, { kind: 'directory', mode: 0o700, path: directory },
      { kind: 'file', mode: 0o600, path: owned, sha256: sha256('owned') }] };
    await fs.writeFile(join(f.roomHome, 'manifest.json'), JSON.stringify(manifest));
    expect((await uninstallRoom({ ...input, manifest }, f.deps)).outcome).toBe('conflict');
    await expect(fs.lstat(owned)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(runtime, 'utf8')).toBe('runtime');
    const residual = loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), input.context);
    expect(residual.artifacts.map(artifact => artifact.path)).toEqual([f.roomHome, directory, f.path].sort());
    await fs.unlink(runtime); await fs.writeFile(f.path, 'new');
    expect((await uninstallRoom({ ...input, context: { ...input.context, transactionId: 'tx-3' }, manifest: residual }, f.deps)).outcome).toBe('committed');
    await expect(fs.lstat(f.roomHome)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
  it('discharges descendants of missing directories without following replaced parents', async () => fixture(async f => {
    const input = await installed(f);
    const parent = join(f.roomHome, 'missing');
    const manifest: InstallationManifestV1 = { ...input.manifest, artifacts: [...input.manifest.artifacts,
      { kind: 'directory', mode: 0o700, path: parent }, { kind: 'file', mode: 0o600, path: join(parent, 'file'), sha256: sha256('owned') }] };
    await fs.writeFile(join(f.roomHome, 'manifest.json'), JSON.stringify(manifest));
    expect((await uninstallRoom({ ...input, manifest }, f.deps)).outcome).toBe('committed');
  }));
  it('blocks both dry and apply on changed committed before-images before any cleanup', async () => fixture(async f => {
    const input = await installed(f);
    let fired = false;
    f.fault((point, path) => {
      if (!fired && point === 'before-action' && path.startsWith('capture:') && path.endsWith('-manifest-capture')) { fired = true; throw new Error('crash'); }
    });
    expect((await uninstallRoom(input, f.deps)).outcome).toBe('recovery-required'); f.fault(() => {});
    await fs.writeFile(join(f.roomHome, 'transactions/tx-2/before/file-0'), 'customized evidence');
    const before = await snapshot(f.roomHome);
    for (const apply of [false, true]) expect(await recoverTransaction({ ...recoveryInput(f, apply), context: input.context }, f.deps)).toBe('recovery-required');
    expect(await snapshot(f.roomHome)).toEqual(before);
  }));

  it('finishes terminal rollback cleanup after a before-image was already retired', async () => fixture(async f => {
    const uninstall = await installed(f);
    const context = { ...uninstall.context, transactionId: 'tx-rollback-cleanup' };
    const tx = await FilesystemTransaction.begin(context, { operation: 'update', previousManifest: uninstall.manifest,
      changes: [{ before: uninstall.manifest.artifacts[0] ?? null, after: { kind: 'file', path: f.path, mode: 0o600, content: 'updated' } }],
      providerBefore: f.policy, providerAfter: f.policy, validateArtifacts: () => {} }, f.deps.filesystem);
    await tx.publish();
    expect(await tx.compensate()).toBe('rolled-back');
    let crashed = false;
    f.fault((point, path) => {
      if (!crashed && point === 'after-cleanup' && path.endsWith('/before/file-0')) { crashed = true; throw new Error('crash'); }
    });
    await expect(tx.cleanup()).rejects.toThrow();
    expect(crashed).toBe(true);
    f.fault(() => {});
    const request = { context, admission: f.input.admission, policy: f.policy };
    expect(await recoverTransaction(request, f.deps)).toBe('reversible');
    expect(await recoverTransaction({ ...request, apply: true }, f.deps)).toBe('rolled-back');
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));

  it('reopens an exact rollback capture with an absent destination', async () => fixture(async f => {
    const uninstall = await installed(f);
    const context = { ...uninstall.context, transactionId: 'tx-rollback-capture' };
    const tx = await FilesystemTransaction.begin(context, { operation: 'update', previousManifest: uninstall.manifest,
      changes: [{ before: uninstall.manifest.artifacts[0] ?? null, after: { kind: 'file', path: f.path, mode: 0o600, content: 'updated' } }],
      providerBefore: f.policy, providerAfter: f.policy, validateArtifacts: () => {} }, f.deps.filesystem);
    await tx.publish();
    let crashed = false;
    f.fault((point, path) => {
      if (!crashed && point === 'after-action' && path.startsWith('capture:') && path.endsWith('-rollback-capture')) { crashed = true; throw new Error('crash'); }
    });
    expect(await tx.compensate()).toBe('recovery-required');
    expect(crashed).toBe(true);
    await expect(fs.lstat(f.path)).rejects.toMatchObject({ code: 'ENOENT' });
    f.fault(() => {});
    const request = { context, admission: f.input.admission, policy: f.policy };
    expect(await recoverTransaction(request, f.deps)).toBe('reversible');
    expect(await recoverTransaction({ ...request, apply: true }, f.deps)).toBe('rolled-back');
    expect(await fs.readFile(f.path, 'utf8')).toBe('new');
  }));

  it.each(['provider', 'session'] as const)('rechecks %s immediately before recovery mutation', async kind => fixture(async f => {
    await FilesystemTransaction.begin(f.context, f.input.transaction, f.deps.filesystem);
    await ManifestCommit.prepare(f.context, f.deps.filesystem, null, f.input.manifest);
    if (kind === 'provider') f.gateway.readConfig.mockResolvedValueOnce({ providers: structuredClone(f.providers) })
      .mockImplementation(() => { f.providers['codex-peer'] = { external: true }; return Promise.resolve({ providers: structuredClone(f.providers) }); });
    else f.gateway.sessionsSafe.mockResolvedValueOnce(true).mockResolvedValue(false);
    expect(await recoverTransaction(recoveryInput(f, true), f.deps)).toBe('recovery-required');
    expect(f.gateway.restoreProviders).not.toHaveBeenCalled();
    expect(await fs.readdir(join(f.roomHome, 'transactions/tx-1'))).toContain('journal.json');
  }));

  it('rejects committed full-uninstall evidence that retains provider ownership', async () => fixture(async f => {
    const uninstall = await installed(f);
    const context = { ...uninstall.context, transactionId: 'tx-malformed-uninstall' };
    const tx = await FilesystemTransaction.begin(context, { operation: 'uninstall', previousManifest: uninstall.manifest, changes: [],
      providerBefore: f.policy, providerAfter: f.policy, validateArtifacts: () => {} }, f.deps.filesystem);
    await tx.publish(); await tx.transition('patching-paseo'); await tx.transition('verifying'); await tx.transition('committed');
    const request = { context, admission: f.input.admission, policy: f.policy, apply: true };
    expect(await recoverTransaction(request, f.deps)).toBe('recovery-required');
    expect(loadManifest(await fs.readFile(join(f.roomHome, 'manifest.json')), context)).toEqual(uninstall.manifest);
  }));

  it('reestablishes room-root durability for an already-absent manifest capture', async () => fixture(async f => {
    const previous = { ...f.input.manifest, lastTransactionId: 'old' };
    await fs.writeFile(f.path, 'new', { mode: 0o600 });
    await fs.writeFile(join(f.roomHome, 'manifest.json'), JSON.stringify(previous), { mode: 0o600 });
    await FilesystemTransaction.begin(f.context, { ...f.input.transaction, operation: 'update', previousManifest: previous,
      bootstrapEndpointIdentitySha256: null, providerBefore: f.policy, changes: [] }, f.deps.filesystem);
    const publication = await ManifestCommit.prepare(f.context, f.deps.filesystem, previous, f.input.manifest);
    await publication.publish();
    await fs.unlink(publication.capture); // model crash after unlink and before parent fsync
    const actions: string[] = [];
    f.fault((point, path) => { if (point === 'before-action') actions.push(path); });
    await publication.cleanup();
    expect(actions.indexOf(`sync:${publication.capture}`)).toBeGreaterThanOrEqual(0);
    expect(actions.indexOf(`remove:${publication.declaration}`)).toBeGreaterThan(actions.indexOf(`sync:${publication.capture}`));
  }));
});
