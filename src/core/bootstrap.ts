import { z } from 'zod';
import { join } from 'node:path';
import { canonicalJson } from './hash.js';
import { bootstrapSidecarPath, type Metadata, type TransactionFilesystem } from './transaction-fs.js';
import { FilesystemTransaction, type JournalContext } from './transaction.js';

const bindingSchema = z.strictObject({
  schemaVersion: z.literal(1), phase: z.enum(['create', 'discharge']), roomHome: z.string(),
  endpointIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  transactionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/), before: z.literal('absent'), mode: z.literal(0o700),
  parent: z.strictObject({ device: z.number().int(), inode: z.number().int(), uid: z.number().int(), mode: z.number().int() }),
});
type Binding = z.infer<typeof bindingSchema>;
export type BootstrapState = 'absent' | 'reversible' | 'transferred' | 'recovery-required';
const parentIdentity = ({ device, inode, uid, mode }: Metadata): Binding['parent'] => ({ device, inode, uid, mode });

/** Owner-only deterministic sidecar is both durable intent and room-path mutex.
 * Same-UID interference with this private name is outside the accepted contract.
 * A journal, not the sidecar, governs all nonempty transaction state. */
export class RootBootstrap {
  readonly path: string;
  constructor(readonly filesystem: TransactionFilesystem, readonly endpointIdentitySha256: string) {
    this.path = bootstrapSidecarPath(filesystem.context.roomHome);
  }
  private async binding(): Promise<Binding> {
    const fs = this.filesystem;
    const value = await fs.inspect(this.path);
    if (value.kind !== 'file') throw new Error('Unsafe bootstrap evidence.');
    const binding = bindingSchema.parse(JSON.parse((await fs.read(this.path, value)).toString('utf8')));
    if (binding.roomHome !== fs.context.roomHome || binding.endpointIdentitySha256 !== this.endpointIdentitySha256 ||
        canonicalJson(binding.parent) !== canonicalJson(parentIdentity(await fs.parent(this.path)))) throw new Error('Bootstrap binding differs.');
    return binding;
  }
  async begin(context: JournalContext): Promise<void> {
    const fs = this.filesystem;
    if (context.roomHome !== fs.context.roomHome) throw new Error('Bootstrap binding differs.');
    const parent = await fs.parent(this.path);
    // A pre-existing root never becomes ours, including an empty private root.
    if ((await fs.inspect(context.roomHome)).kind !== 'absent') throw new Error('Managed root collision.');
    const binding = bindingSchema.parse({ schemaVersion: 1, phase: 'create', roomHome: context.roomHome,
      endpointIdentitySha256: this.endpointIdentitySha256, transactionId: context.transactionId,
      before: 'absent', mode: 0o700, parent: parentIdentity(parent) });
    await fs.file(this.path, Buffer.from(canonicalJson(binding)), parent);
    // file() fsyncs both the 0600 file and anchored parent before returning.
    await fs.perform(context.roomHome, { action: 'directory', expected: { kind: 'absent' } }, await fs.parent(this.path));
  }
  async inspect(context: Omit<JournalContext, 'transactionId'>): Promise<{ state: BootstrapState; transactionId?: string }> {
    const fs = this.filesystem;
    try {
      if ((await fs.inspect(this.path)).kind === 'absent') return { state: 'absent' };
      const binding = await this.binding();
      const root = await fs.inspect(fs.context.roomHome);
      if (root.kind === 'absent') return { state: 'reversible', transactionId: binding.transactionId };
      if (root.kind !== 'directory') return { state: 'recovery-required' };
      const children = await fs.entries(fs.context.roomHome);
      if (!children.length) return { state: 'reversible', transactionId: binding.transactionId };
      if (children.length !== 1 || children[0] !== 'transactions') return { state: 'recovery-required' };
      const transactions = join(fs.context.roomHome, 'transactions');
      const directories = await fs.entries(transactions);
      if (!directories.length && binding.phase === 'discharge') return { state: 'reversible', transactionId: binding.transactionId };
      if (directories.length !== 1 || directories[0] !== binding.transactionId) return { state: 'recovery-required' };
      const transaction = join(transactions, binding.transactionId);
      if (binding.phase === 'discharge' && !(await fs.entries(transaction)).length) return { state: 'reversible', transactionId: binding.transactionId };
      const tx = await FilesystemTransaction.open({ ...context, transactionId: binding.transactionId }, fs);
      if (tx.snapshot.operation !== 'install' || tx.snapshot.previousManifest !== null ||
          tx.snapshot.bootstrapEndpointIdentitySha256 !== binding.endpointIdentitySha256 ||
          (await fs.entries(tx.directory)).some(name => !['journal.json', 'journal.next', 'staging', 'before',
            ...(binding.phase === 'discharge' ? ['manifest-publication.json'] : [])].includes(name))) return { state: 'recovery-required' };
      if (!await tx.successorSafe()) return { state: 'recovery-required' };
      for (const name of ['staging', 'before'] as const) {
        const path = join(tx.directory, name);
        if ((await fs.inspect(path)).kind === 'absent') continue;
        const allowed = new Map(tx.snapshot.fileMutations.flatMap(record => name === 'staging'
          ? record.stagedFile === null ? [] : [[record.stagedFile, record.after] as const]
          : record.before.kind === 'file' ? [[record.before.backup, { kind: 'file' as const, mode: record.before.mode, sha256: record.before.sha256 }] as const] : []));
        for (const entry of await fs.entries(path)) {
          const expected = allowed.get(entry);
          if (!expected || canonicalJson(await fs.inspect(join(path, entry))) !== canonicalJson(expected)) return { state: 'recovery-required' };
        }
      }
      return { state: 'transferred', transactionId: binding.transactionId };
    } catch { return { state: 'recovery-required' }; }
  }
  async retire(context: JournalContext): Promise<void> {
    const binding = await this.binding();
    if (binding.transactionId !== context.transactionId || (await this.inspect(context)).state !== 'transferred') throw new Error('Bootstrap transfer is not durable.');
    const tx = await FilesystemTransaction.open(context, this.filesystem);
    await this.filesystem.perform(tx.journalPath, { action: 'sync-file', expected: await this.filesystem.inspect(tx.journalPath) });
    if (binding.phase === 'create') await this.removeSidecar();
  }
  /** Re-establish external authority before deleting the in-root rollback journal. */
  async armDischarge(context: JournalContext): Promise<void> {
    const fs = this.filesystem;
    if ((await fs.inspect(this.path)).kind !== 'absent') {
      const binding = await this.binding();
      if (binding.phase === 'discharge' && binding.transactionId === context.transactionId &&
          (await this.inspect(context)).state === 'transferred') return;
      throw new Error('Bootstrap sidecar collision.');
    }
    const tx = await FilesystemTransaction.open(context, fs);
    if (tx.snapshot.operation !== 'install' || tx.snapshot.previousManifest !== null ||
        tx.snapshot.bootstrapEndpointIdentitySha256 !== this.endpointIdentitySha256 || tx.snapshot.state !== 'rolled-back') {
      throw new Error('Root discharge is not authorized.');
    }
    const parent = await fs.parent(this.path);
    const binding = bindingSchema.parse({ schemaVersion: 1, phase: 'discharge', roomHome: context.roomHome,
      endpointIdentitySha256: this.endpointIdentitySha256, transactionId: context.transactionId,
      before: 'absent', mode: 0o700, parent: parentIdentity(parent) });
    await fs.file(this.path, Buffer.from(canonicalJson(binding)), parent);
  }
  async discharge(context: Omit<JournalContext, 'transactionId'>): Promise<void> {
    const binding = await this.binding();
    if (binding.phase !== 'discharge' || (await this.inspect(context)).state !== 'reversible') throw new Error('Root discharge is not safe.');
    if ((await this.recover(context, true)) !== 'absent') throw new Error('Root discharge failed.');
  }
  private async removeSidecar(): Promise<void> {
    const fs = this.filesystem;
    await this.binding();
    await fs.perform(this.path, { action: 'remove', expected: await fs.inspect(this.path) });
  }
  async recover(context: Omit<JournalContext, 'transactionId'>, apply = false): Promise<BootstrapState> {
    const observation = await this.inspect(context);
    if (!apply || observation.state !== 'reversible') return observation.state;
    try {
      const fs = this.filesystem;
      const binding = await this.binding();
      const root = await fs.inspect(fs.context.roomHome);
      if (root.kind !== 'absent') {
        if (root.kind !== 'directory') return 'recovery-required';
        const children = await fs.entries(fs.context.roomHome);
        if (children.length === 1 && children[0] === 'transactions') {
          const transactions = join(fs.context.roomHome, 'transactions');
          const value = await fs.inspect(transactions);
          if (value.kind !== 'directory') return 'recovery-required';
          const entries = await fs.entries(transactions);
          if (entries.length === 1 && entries[0] === binding.transactionId && binding.phase === 'discharge') {
            const transaction = join(transactions, binding.transactionId);
            const transactionValue = await fs.inspect(transaction);
            if (transactionValue.kind !== 'directory' || (await fs.entries(transaction)).length) return 'recovery-required';
            await fs.perform(transaction, { action: 'remove', expected: transactionValue });
          } else if (entries.length) return 'recovery-required';
          await fs.perform(transactions, { action: 'remove', expected: await fs.inspect(transactions) });
        } else if (children.length) return 'recovery-required';
        await fs.perform(fs.context.roomHome, { action: 'remove', expected: await fs.inspect(fs.context.roomHome) });
      }
      await this.removeSidecar();
      return 'absent';
    } catch { return 'recovery-required'; }
  }
}
