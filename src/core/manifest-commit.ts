import { randomUUID } from 'node:crypto';
import { basename, join, dirname } from 'node:path';
import { z } from 'zod';
import { canonicalJson, sha256 } from './hash.js';
import { validateManifest, loadManifest, type InstallationManifestV1 } from './manifest.js';
import { type JournalContext, transactionDirectory, TransactionError } from './transaction.js';
import { TransactionFilesystem, type FileValue, type Metadata } from './transaction-fs.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const regular = z.strictObject({ kind: z.literal('file'), mode: z.literal(0o600), sha256: digest });
const publicationSchema = z.strictObject({ schemaVersion: z.literal(1), transactionId: z.string(), destination: z.string(),
  prepared: z.string(), capture: z.string(), before: z.union([z.strictObject({ kind: z.literal('absent') }), regular]), after: z.union([z.strictObject({ kind: z.literal('absent') }), regular]),
  parent: z.strictObject({ device: z.number().int(), inode: z.number().int(), mode: z.number().int(), uid: z.number().int().nonnegative(),
    links: z.number().int().positive(), kind: z.literal('directory') }) });
export type ManifestPublicationV1 = z.infer<typeof publicationSchema>;
/** Strict restart evidence; paths are admitted against independently chosen context,
 * never used as authority merely because a journal directory contains this file. */
export function loadManifestPublication(bytes: Uint8Array, context: JournalContext): ManifestPublicationV1 {
  try {
    transactionDirectory(context);
    const record = publicationSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    if (record.transactionId !== context.transactionId || record.destination !== join(context.roomHome, 'manifest.json') ||
        (record.parent.mode & 0o7777) !== 0o700) throw new TransactionError();
    for (const role of ['prepared', 'capture'] as const) {
      const path = record[role];
      if (dirname(path) !== context.roomHome || !/^\.paseo-room-[a-f0-9-]{36}-manifest-(prepared|capture)$/.test(basename(path)) || !path.endsWith(`-manifest-${role}`) ||
          context.forbiddenFilePaths?.includes(path)) throw new TransactionError();
    }
    return record;
  } catch { throw new TransactionError(); }
}
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const value = (bytes: Uint8Array): FileValue => ({ kind: 'file', mode: 0o600, sha256: sha256(bytes) });
/** Orchestrator-owned commit evidence, deliberately separate from fileMutations.
 * Declaration is durable before any same-parent temporary is created. Unknown
 * captures are retained; there is no overwriting rename at the manifest path. */
export class ManifestCommit {
  private constructor(readonly context: JournalContext, readonly fs: TransactionFilesystem,
    readonly before: FileValue, readonly after: FileValue, private readonly bytes: Buffer | null,
    readonly prepared: string, readonly capture: string, readonly declaration: string,
    private readonly parent: Metadata, private readonly declarationValue: FileValue) {}
  get path(): string { return join(this.context.roomHome, 'manifest.json'); }
  static async prepare(context: JournalContext, fs: TransactionFilesystem,
    previous: InstallationManifestV1 | null, next: InstallationManifestV1 | null): Promise<ManifestCommit> {
    if (fs.context.roomHome !== context.roomHome) throw new TransactionError();
    const manifest = next === null ? null : validateManifest(next, context);
    if (manifest && manifest.lastTransactionId !== context.transactionId) throw new TransactionError();
    const path = join(context.roomHome, 'manifest.json');
    const parent = await fs.parent(path);
    const before = await fs.inspect(path, parent);
    if (previous === null ? before.kind !== 'absent' : before.kind !== 'file' ||
        !equal(loadManifest(await fs.read(path, before), context), validateManifest(previous, context))) throw new TransactionError();
    const bytes = Buffer.from(canonicalJson(manifest) + '\n');
    const after: FileValue = manifest === null ? { kind: 'absent' } : value(bytes);
    const prepared = join(context.roomHome, `.paseo-room-${randomUUID()}-manifest-prepared`);
    const capture = join(context.roomHome, `.paseo-room-${randomUUID()}-manifest-capture`);
    const declaration = join(transactionDirectory(context), 'manifest-publication.json');
    const evidence = Buffer.from(canonicalJson({ schemaVersion: 1, transactionId: context.transactionId,
      destination: path, prepared, capture, before, after, parent }) + '\n');
    loadManifestPublication(evidence, context);
    await fs.file(declaration, evidence);
    return new ManifestCommit(context, fs, before, after, bytes, prepared, capture, declaration, parent, value(evidence));
  }
  /** Reopen declarations without performing reconciliation or durability writes. */
  static async open(context: JournalContext, fs: TransactionFilesystem): Promise<ManifestCommit | null> {
    const declaration = join(transactionDirectory(context), 'manifest-publication.json');
    const disk = await fs.inspect(declaration);
    if (disk.kind === 'absent') return null;
    const record = loadManifestPublication(await fs.read(declaration, disk), context);
    const commit = new ManifestCommit(context, fs, record.before, record.after, null,
      record.prepared, record.capture, declaration, record.parent, disk);
    await commit.anchor();
    return commit;
  }
  private async anchor(): Promise<Metadata> {
    const current = await this.fs.parent(this.path);
    if (!equal({ ...current, links: this.parent.links }, this.parent)) throw new TransactionError();
    return current;
  }
  async publish(): Promise<void> {
    if (this.after.kind !== 'absent' && this.bytes === null) throw new TransactionError();
    if (this.after.kind !== 'absent' && this.bytes !== null) await this.fs.file(this.prepared, this.bytes, await this.anchor());
    if (this.before.kind !== 'absent' && !(this.after.kind === 'absent' && (await this.fs.inspect(this.path, await this.anchor())).kind === 'absent')) {
      await this.fs.perform(this.capture, { action: 'capture', source: 'manifest.json', sourceExpected: this.before }, await this.anchor());
    }
    if (this.after.kind !== 'absent') await this.fs.perform(this.path, { action: 'publish', source: basename(this.prepared), sourceExpected: this.after }, await this.anchor());
    else await this.fs.perform(this.path, { action: 'sync', expected: this.after }, await this.anchor());
  }
  /** Reestablish durability after an ambiguous publication before deciding whether
   * rollback is legal. Never retry publication. A linked pair is only reconciled. */
  async committed(): Promise<boolean> {
    const parent = await this.anchor();
    let current: FileValue;
    try { current = await this.fs.inspect(this.path, parent); }
    catch {
      // Recovery may itself have crashed while restoring the old capture. Read
      // the exact linked pair before choosing which publication to reconcile.
      let source = this.prepared;
      let expected = this.after;
      try { await this.fs.perform(this.path, { action: 'inspect-publication', source: basename(source), sourceExpected: expected }, parent); }
      catch {
        source = this.capture; expected = this.before;
        await this.fs.perform(this.path, { action: 'inspect-publication', source: basename(source), sourceExpected: expected }, parent);
      }
      await this.fs.perform(this.path, { action: 'reconcile', source: basename(source), sourceExpected: expected }, parent);
      current = await this.fs.inspect(this.path, await this.anchor());
    }
    if (equal(current, this.after)) {
      await this.fs.perform(this.path, { action: this.after.kind === 'file' ? 'sync-file' : 'sync', expected: this.after }, await this.anchor());
      return true;
    }
    if (!equal(current, this.before) && current.kind !== 'absent') throw new TransactionError();
    return false;
  }
  /** Restore only an exact recorded capture into an absent destination. */
  async restore(): Promise<void> {
    if (this.after.kind !== 'absent' && await this.committed()) throw new TransactionError();
    const current = await this.fs.inspect(this.path, await this.anchor());
    if (current.kind === 'absent' && this.before.kind !== 'absent') {
      await this.fs.perform(this.path, { action: 'publish', source: basename(this.capture), sourceExpected: this.before }, await this.anchor());
    }
    if (!equal(await this.fs.inspect(this.path, await this.anchor()), this.before)) throw new TransactionError();
    await this.fs.perform(this.path, this.before.kind === 'file' ? { action: 'sync-file', expected: this.before }
      : { action: 'sync', expected: this.before }, await this.anchor());
  }
  /** After restoring the old manifest, retire exact temporary values before
   * file compensation (directory link counts include these names on macOS).
   * The declaration itself remains durable until the transaction is terminal. */
  async retireTemporaries(): Promise<void> {
    for (const [path, expected] of [[this.prepared, this.after], [this.capture, this.before]] as const) {
      const current = await this.fs.inspect(path, await this.anchor());
      if (current.kind === 'absent') {
        // A prior unlink may have crashed before the room-root fsync. Reestablish
        // that barrier before deleting the only declaration of this private name.
        await this.fs.perform(path, { action: 'sync', expected: current }, await this.anchor());
        continue;
      }
      if (!equal(current, expected)) throw new TransactionError();
      await this.fs.perform(path, { action: 'remove', expected }, await this.anchor());
    }
  }
  /** Only after a durable terminal journal; retain unknown temporary values. */
  async cleanup(): Promise<void> {
    await this.retireTemporaries();
    await this.fs.perform(this.declaration, { action: 'remove', expected: this.declarationValue });
  }
}
