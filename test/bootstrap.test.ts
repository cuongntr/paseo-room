import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { RootBootstrap } from '../src/core/bootstrap.js';
import { TransactionFilesystem, bootstrapSidecarPath, runTransactionChild } from '../src/core/transaction-fs.js';
import { FilesystemTransaction, absentTransactionProviders } from '../src/core/transaction.js';

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>): Promise<void> {
  const f = await setup();
  try { await test(f); } finally { await fs.rm(f.parent, { recursive: true, force: true }); }
}
async function setup() {
  const parent = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'paseo-bootstrap-')));
  const roomHome = join(parent, 'room');
  const context = { roomHome, transactionId: 'boot-1' };
  const disk = new TransactionFilesystem({ roomHome, uid: process.getuid?.() ?? -1 });
  const bootstrap = new RootBootstrap(disk, 'a'.repeat(64));
  const transaction = { operation: 'install' as const, previousManifest: null, bootstrapEndpointIdentitySha256: 'a'.repeat(64), changes: [],
    providerBefore: absentTransactionProviders(), providerAfter: absentTransactionProviders(), validateArtifacts: () => {} };
  return { parent, roomHome, context, disk, bootstrap, transaction };
}

describe('durable first-install bootstrap', { timeout: 120000 }, () => {
  it('declares before root creation, transfers only to matching durable journal, and retires with parent fsync', async () => fixture(async f => {
    const events: string[] = [];
    const disk = new TransactionFilesystem(f.disk.context, (boundary, path) => { events.push(`${boundary}:${path}`); });
    const bootstrap = new RootBootstrap(disk, 'a'.repeat(64));
    await bootstrap.begin(f.context);
    expect((await fs.stat(bootstrap.path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.roomHome)).mode & 0o777).toBe(0o700);
    expect(events.indexOf(`after-fsync:${bootstrap.path}`)).toBeLessThan(events.indexOf(`before-action:directory:${f.roomHome}`));
    expect((await bootstrap.inspect(f.context)).state).toBe('reversible');
    await expect(bootstrap.retire(f.context)).rejects.toThrow();
    await FilesystemTransaction.begin(f.context, f.transaction, disk);
    expect((await bootstrap.inspect(f.context)).state).toBe('transferred');
    await expect(bootstrap.retire({ ...f.context, transactionId: 'other' })).rejects.toThrow();
    await bootstrap.retire(f.context);
    expect((await bootstrap.inspect(f.context)).state).toBe('absent');
    expect(events).toContain(`after-action:remove:${bootstrap.path}`);
    expect(await fs.readdir(f.roomHome)).toEqual(['transactions']);
  }));
  it.each(['file:after-file-write', 'file:before-parent-sync', 'file:after-parent-sync',
    'directory:after-action', 'directory:before-parent-sync', 'directory:after-parent-sync'])('recovers crash at %s without adopting other state', async boundary => fixture(async f => {
    const [action, point] = boundary.split(':');
    let crashed = false;
    const disk = new TransactionFilesystem(f.disk.context, () => {}, request => {
      const operation = JSON.parse(request.input) as { action: string };
      if (crashed || operation.action !== action) return runTransactionChild(request);
      crashed = true;
      return runTransactionChild({ ...request, script: request.script.replace(/const checkpoint = [^;]+;/,
        `const checkpoint = async (point) => { if (point === ${JSON.stringify(point)}) process.exit(86); };`) });
    });
    await expect(new RootBootstrap(disk, 'a'.repeat(64)).begin(f.context)).rejects.toThrow();
    expect(crashed).toBe(true);
    const before = await fs.readFile(f.bootstrap.path);
    expect(await f.bootstrap.recover(f.context)).toBe('reversible');
    expect(await fs.readFile(f.bootstrap.path)).toEqual(before);
    expect(await f.bootstrap.recover(f.context, true)).toBe('absent');
    expect(await fs.readdir(f.parent)).toEqual([]);
  }));
  it('serializes the room path even across different daemon endpoints', async () => fixture(async f => {
    await f.bootstrap.begin(f.context);
    await expect(new RootBootstrap(f.disk, 'b'.repeat(64)).begin({ ...f.context, transactionId: 'other' })).rejects.toThrow();
    expect((await new RootBootstrap(f.disk, 'b'.repeat(64)).inspect(f.context)).state).toBe('recovery-required');
    expect(bootstrapSidecarPath(f.roomHome)).toBe(f.bootstrap.path);
  }));
  it.each(['empty', 'populated', 'symlink'])('never adopts pre-existing %s roots', async kind => fixture(async f => {
    if (kind === 'symlink') await fs.symlink(f.parent, f.roomHome);
    else { await fs.mkdir(f.roomHome, { mode: 0o700 }); if (kind === 'populated') await fs.writeFile(join(f.roomHome, 'unknown'), 'preserve'); }
    await expect(f.bootstrap.begin(f.context)).rejects.toThrow();
    expect((await f.disk.inspect(f.bootstrap.path)).kind).toBe('absent');
    expect(await fs.lstat(f.roomHome)).toBeDefined();
  }));
  it.each(['unknown-child', 'root-symlink', 'sidecar-symlink', 'sidecar-hardlink', 'sidecar-mode', 'unsafe-parent', 'partial-journal', 'unknown-after-transfer'])('preserves divergent %s evidence', async kind => fixture(async f => {
    await f.bootstrap.begin(f.context);
    if (kind === 'unknown-child') await fs.writeFile(join(f.roomHome, 'unknown'), 'preserve');
    if (kind === 'root-symlink') { await fs.rmdir(f.roomHome); await fs.symlink(f.parent, f.roomHome); }
    if (kind === 'sidecar-symlink') { await fs.rename(f.bootstrap.path, join(f.parent, 'saved')); await fs.symlink(join(f.parent, 'saved'), f.bootstrap.path); }
    if (kind === 'sidecar-hardlink') await fs.link(f.bootstrap.path, join(f.parent, 'alias'));
    if (kind === 'sidecar-mode') await fs.chmod(f.bootstrap.path, 0o644);
    if (kind === 'unsafe-parent') await fs.chmod(f.parent, 0o777);
    if (kind === 'partial-journal') await fs.mkdir(join(f.roomHome, 'transactions'), { mode: 0o700 });
    if (kind === 'unknown-after-transfer') { await FilesystemTransaction.begin(f.context, f.transaction, f.disk); await fs.writeFile(join(f.roomHome, 'unknown'), 'preserve'); }
    expect(await f.bootstrap.recover(f.context, true)).toBe('recovery-required');
    expect(await fs.lstat(f.bootstrap.path)).toBeDefined(); expect(await fs.lstat(f.roomHome)).toBeDefined();
  }));
  it('retains external authority while discharging a rolled-back first-install root', async () => fixture(async f => {
    await f.bootstrap.begin(f.context);
    const tx = await FilesystemTransaction.begin(f.context, f.transaction, f.disk);
    await f.bootstrap.retire(f.context);
    expect(await tx.compensate()).toBe('rolled-back');
    await f.bootstrap.armDischarge(f.context);
    const publication = join(tx.directory, 'manifest-publication.json');
    await fs.writeFile(publication, '{}', { mode: 0o600 });
    expect((await f.bootstrap.inspect(f.context)).state).toBe('transferred');
    await fs.unlink(publication);
    await tx.cleanup();
    expect((await f.bootstrap.inspect(f.context)).state).toBe('reversible');
    await f.bootstrap.discharge(f.context);
    await expect(fs.lstat(f.roomHome)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(f.bootstrap.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }));
});
