import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { ArtifactSpec } from '../adapters/contract.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';
import { validateProviderEntry, type ProviderOverrideV1 } from '../paseo/provider-policy.js';
import { canonicalJson, sha256 } from './hash.js';
import { validateManifest, manifestArtifactSchema, type InstallationManifestV1, type ManifestArtifact, type ManifestContext } from './manifest.js';
import { containsPath } from './paths.js';
import { TransactionFilesystem, type FileValue, type Metadata } from './transaction-fs.js';
export { TransactionFilesystem, type TransactionBoundary, type TransactionFault, type TransactionFilesystemContext } from './transaction-fs.js';

const safeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(100);
const absolutePath = z.string().refine(value => isAbsolute(value) && resolve(value) === value && value !== '/' && !/[\\\p{Cc}]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const absent = z.strictObject({ kind: z.literal('absent') });
const file = z.strictObject({ kind: z.literal('file'), mode: z.literal(0o600), sha256: digest });
const link = z.strictObject({ kind: z.literal('symlink'), mode: z.literal(0o777), target: z.string().min(1).refine(value => !/\p{Cc}/u.test(value)) });
const directory = z.strictObject({ kind: z.literal('directory'), mode: z.literal(0o700) });
const beforeSchema = z.discriminatedUnion('kind', [absent, file.extend({ backup: safeName }), link.extend({ mode: z.number().int().min(0).max(0o777) }), directory]);
const afterSchema = z.discriminatedUnion('kind', [absent, file, link, directory]);
const exactValueSchema = z.discriminatedUnion('kind', [absent, file, link.extend({ mode: z.number().int().min(0).max(0o777) }), directory]);
const artifactSpecSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: absolutePath, mode: z.literal(0o600), content: z.string() }),
  z.strictObject({ kind: z.literal('directory'), path: absolutePath, mode: z.literal(0o700) }),
  z.strictObject({ kind: z.literal('symlink'), path: absolutePath, target: absolutePath }),
]);
const parentSchema = z.strictObject({ device: z.number().int(), inode: z.number().int(), mode: z.number().int(),
  uid: z.number().int(), links: z.number().int().positive(), kind: z.literal('directory') });
const privateSchema = z.strictObject({ role: z.enum(['prepared', 'capture', 'rollback-prepared', 'rollback-capture']),
  name: z.string().regex(/^\.paseo-room-[a-f0-9-]{36}-(prepared|capture|rollback-prepared|rollback-capture)$/),
  expected: exactValueSchema });
const mutationSchema = z.strictObject({
  action: z.enum(['create', 'update', 'remove']), destination: absolutePath, kind: z.enum(['file', 'symlink', 'directory']),
  before: beforeSchema, after: afterSchema, stagedFile: safeName.nullable(),
  parent: parentSchema.nullable(), pending: z.strictObject({
    role: z.enum(['prepared', 'capture', 'rollback-prepared', 'rollback-capture', 'destination']),
    action: z.enum(['file', 'publish', 'link', 'directory', 'remove']), value: exactValueSchema,
  }).nullable(), pendingLinks: z.array(z.number().int().positive()).max(2), privatePaths: z.array(privateSchema).length(4),
  progress: z.enum(['planned', 'intent', 'completed', 'compensating', 'compensated']),
});
export const JOURNAL_STATES = ['staged', 'publishing-files', 'patching-paseo', 'verifying', 'rolling-back', 'recovery-required', 'committed', 'rolled-back'] as const;
const providers = z.strictObject({ 'codex-supervisor': z.unknown(), 'codex-lead': z.unknown(), 'codex-peer': z.unknown() });
const journalSchema = z.strictObject({
  schemaVersion: z.literal(1), transactionId: safeName, operation: z.enum(['install', 'update', 'uninstall']),
  state: z.enum(JOURNAL_STATES), previousManifest: z.unknown(), fileMutations: z.array(mutationSchema),
  bootstrapEndpointIdentitySha256: digest.nullable(), providerBefore: providers, providerAfter: providers,
});
export type FileMutationRecord = z.infer<typeof mutationSchema>;
export type JournalState = typeof JOURNAL_STATES[number];
export type TransactionProviderRecord = Record<ManagedProviderId, ProviderOverrideV1 | null>;
export type TransactionJournalV1 = Omit<z.infer<typeof journalSchema>, 'previousManifest' | 'providerBefore' | 'providerAfter'> & {
  previousManifest: InstallationManifestV1 | null;
  providerBefore: TransactionProviderRecord;
  providerAfter: TransactionProviderRecord;
};
export interface JournalContext extends ManifestContext {
  /** Independently selected transaction ID; never derive an IO path from an untrusted journal. */
  readonly transactionId: string;
}
export class TransactionError extends Error {
  constructor() { super('Unsafe, divergent or unsupported transaction. Preserve evidence; explicit recovery is required.'); }
}
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
function valueOf(artifact: ManifestArtifact): FileValue {
  if (artifact.kind === 'file') return { kind: 'file', mode: artifact.mode, sha256: artifact.sha256 };
  if (artifact.kind === 'symlink') return { kind: 'symlink', mode: artifact.mode, target: artifact.target };
  return { kind: 'directory', mode: artifact.mode };
}
function beforeValue(before: FileMutationRecord['before']): FileValue {
  if (before.kind !== 'file') return before;
  return { kind: 'file', mode: before.mode, sha256: before.sha256 };
}
function validateProviders(value: z.infer<typeof providers>): TransactionProviderRecord {
  const entry = (id: ManagedProviderId): ProviderOverrideV1 | null => value[id] === null ? null : validateProviderEntry(id, value[id]);
  return { 'codex-supervisor': entry('codex-supervisor'), 'codex-lead': entry('codex-lead'), 'codex-peer': entry('codex-peer') };
}
export function transactionDirectory(context: JournalContext): string {
  absolutePath.parse(context.roomHome);
  safeName.parse(context.transactionId);
  return join(context.roomHome, 'transactions', context.transactionId);
}
/** Pure, strict, context-bound validation. No IO and no lossy stripping of keys. */
export function validateJournal(value: unknown, context: JournalContext): TransactionJournalV1 {
  try {
    canonicalJson(value);
    const parsed = journalSchema.parse(value);
    const transactionRoot = transactionDirectory(context);
    if (parsed.transactionId !== context.transactionId) throw new Error();
    const seen = new Set<string>();
    const backups = new Set<string>();
    const stages = new Set<string>();
    const privatePaths = new Set<string>();
    for (const record of parsed.fileMutations) {
      if (!containsPath(context.roomHome, record.destination) || record.destination === context.roomHome ||
          containsPath(join(context.roomHome, 'transactions'), record.destination) || record.destination === join(context.roomHome, 'manifest.json') ||
          seen.has(record.destination)) throw new Error();
      seen.add(record.destination);
      const roles = new Set<string>();
      for (const entry of record.privatePaths) {
        const path = join(dirname(record.destination), entry.name);
        const expected = ['capture', 'rollback-prepared'].includes(entry.role) ? beforeValue(record.before) : record.after;
        if (roles.has(entry.role) || privatePaths.has(path) || !entry.name.endsWith(`-${entry.role}`) || !equal(entry.expected, expected) ||
            context.forbiddenFilePaths?.includes(path)) throw new Error();
        roles.add(entry.role); privatePaths.add(path);
      }
      if (record.progress !== 'planned' && record.parent === null || (record.pending === null) !== (record.pendingLinks.length === 0)) throw new Error();
      if (record.pending) {
        const parent = record.parent;
        if (!parent || record.pendingLinks.some(count => Math.abs(count - parent.links) > 1)) throw new Error();
        const intended = record.progress === 'compensating' ? beforeValue(record.before) : record.after;
        const declaration = record.privatePaths.find(entry => entry.role === record.pending?.role);
        if (record.pending.role === 'destination'
          ? !['publish', 'link', 'directory'].includes(record.pending.action) || !equal(record.pending.value, intended)
          : !declaration || (record.pending.action === 'remove' ? record.pending.value.kind !== 'absent'
            : record.pending.action !== 'file' || !['prepared', 'rollback-prepared'].includes(declaration.role) || !equal(record.pending.value, declaration.expected))) throw new Error();
      }
      if (record.action === 'create' ? record.before.kind !== 'absent' || record.after.kind === 'absent'
        : record.action === 'remove' ? record.before.kind === 'absent' || record.after.kind !== 'absent'
          : record.before.kind === 'absent' || record.after.kind === 'absent' || equal(beforeValue(record.before), record.after)) throw new Error();
      const kind = record.after.kind === 'absent' ? record.before.kind : record.after.kind;
      if (record.kind !== kind || (record.action === 'update' && (record.before.kind === 'directory' || record.after.kind === 'directory'))) throw new Error();
      if (context.forbiddenFilePaths?.includes(record.destination) && (record.before.kind === 'file' || record.after.kind === 'file')) throw new Error();
      if (record.before.kind === 'file') {
        if (backups.has(record.before.backup)) throw new Error();
        backups.add(record.before.backup);
      }
      if (record.after.kind === 'file') {
        if (record.stagedFile === null || stages.has(record.stagedFile)) throw new Error();
        stages.add(record.stagedFile);
      } else if (record.stagedFile !== null) throw new Error();
      if ((parsed.state === 'staged' && record.progress !== 'planned') ||
          (['patching-paseo', 'verifying', 'committed'].includes(parsed.state) && record.progress !== 'completed') ||
          (parsed.state === 'publishing-files' && ['compensating', 'compensated'].includes(record.progress)) ||
          (parsed.state === 'rolled-back' && !['planned', 'compensated'].includes(record.progress))) throw new Error();
    }
    if (parsed.fileMutations.some(record => privatePaths.has(record.destination))) throw new Error();
    // Ancestor lookup is linear in total path depth, not record pairs.
    const kinds = new Map(parsed.fileMutations.map(record => [record.destination, record.kind]));
    for (const record of parsed.fileMutations) {
      for (let parent = dirname(record.destination); containsPath(context.roomHome, parent); parent = dirname(parent)) {
        const kind = kinds.get(parent);
        if (kind && kind !== 'directory') throw new Error();
        if (parent === context.roomHome) break;
      }
    }
    if (!containsPath(context.roomHome, transactionRoot)) throw new Error();
    return { ...parsed, previousManifest: parsed.previousManifest === null ? null : validateManifest(parsed.previousManifest, context),
      providerBefore: validateProviders(parsed.providerBefore), providerAfter: validateProviders(parsed.providerAfter) };
  } catch { throw new TransactionError(); }
}
export function loadJournal(content: string | Uint8Array, context: JournalContext): TransactionJournalV1 {
  try {
    const text = typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);
    return validateJournal(JSON.parse(text) as unknown, context);
  } catch { throw new TransactionError(); }
}
export function serializeJournal(value: unknown, context: JournalContext): string {
  return canonicalJson(validateJournal(value, context)) + '\n';
}
const transitions: Record<JournalState, readonly JournalState[]> = {
  staged: ['publishing-files', 'rolling-back', 'recovery-required'],
  'publishing-files': ['patching-paseo', 'rolling-back', 'recovery-required'],
  'patching-paseo': ['verifying', 'rolling-back', 'recovery-required'],
  verifying: ['committed', 'rolling-back', 'recovery-required'],
  'rolling-back': ['rolled-back', 'recovery-required'], 'recovery-required': ['rolling-back'], committed: [], 'rolled-back': [],
};
export function transitionJournal(journal: TransactionJournalV1, state: JournalState, context: JournalContext): TransactionJournalV1 {
  if (!transitions[journal.state].includes(state)) throw new TransactionError();
  return validateJournal({ ...journal, state }, context);
}
export interface FileChange {
  /** Prior ownership admitted by planner/manifest observation, not an adoption request. */
  readonly before: ManifestArtifact | null;
  readonly after: ArtifactSpec | null;
}
export interface BeginTransaction {
  readonly operation: TransactionJournalV1['operation'];
  readonly previousManifest: InstallationManifestV1 | null;
  /** Non-null only when this transaction owns a first-install root bootstrap. */
  readonly bootstrapEndpointIdentitySha256?: string | null;
  readonly changes: readonly FileChange[];
  readonly providerBefore: TransactionProviderRecord;
  readonly providerAfter: TransactionProviderRecord;
  /** Adapter semantic validation (TOML/catalog/link declarations); called before any IO. */
  readonly validateArtifacts: (artifacts: readonly ArtifactSpec[]) => void | Promise<void>;
}

/** Filesystem-only primitive. Caller owns admission/global serialization and all
 * provider/manifest actions. The managed root must already exist privately;
 * infrastructure bootstrap/manifest commit are deliberately not inferred here.
 * Methods must be awaited; concurrent calls are rejected, never queued/retried. */
export class FilesystemTransaction {
  private busy = false;
  private disk: FileValue;
  private constructor(private journal: TransactionJournalV1, readonly context: JournalContext, readonly filesystem: TransactionFilesystem, disk: FileValue) {
    this.disk = disk;
  }
  get snapshot(): TransactionJournalV1 { return validateJournal(this.journal, this.context); }
  get directory(): string { return transactionDirectory(this.context); }
  get journalPath(): string { return join(this.directory, 'journal.json'); }
  private async exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.busy) throw new TransactionError();
    this.busy = true;
    try { return await action(); } catch { throw new TransactionError(); } finally { this.busy = false; }
  }
  private static checkContext(context: JournalContext, filesystem: TransactionFilesystem): void {
    if (context.roomHome !== filesystem.context.roomHome || !equal(context.forbiddenFilePaths ?? [], filesystem.context.forbiddenFilePaths ?? [])) throw new TransactionError();
    transactionDirectory(context);
  }
  static async begin(context: JournalContext, input: BeginTransaction, filesystem: TransactionFilesystem): Promise<FilesystemTransaction> {
    try {
      this.checkContext(context, filesystem);
      const specs = input.changes.flatMap(change => change.after ? [change.after] : []);
      // Copy first: callers cannot mutate declarations while semantic validation awaits.
      const changes = structuredClone(input.changes).map(change => ({
        before: change.before === null ? null : manifestArtifactSchema.parse(change.before),
        after: change.after === null ? null : artifactSpecSchema.parse(change.after),
      }));
      const initial = structuredClone({ operation: input.operation, previousManifest: input.previousManifest,
        bootstrapEndpointIdentitySha256: input.bootstrapEndpointIdentitySha256 ?? null,
        providerBefore: input.providerBefore, providerAfter: input.providerAfter });
      const records: FileMutationRecord[] = changes.map((change, index) => {
        if (!change.before && !change.after) throw new Error();
        if (change.before && change.after && change.before.path !== change.after.path) throw new Error();
        const destination = change.after?.path ?? change.before?.path;
        if (!destination) throw new Error();
        // Reject reserved file declarations BEFORE hashing even authored content.
        if (context.forbiddenFilePaths?.includes(destination) && (change.before?.kind === 'file' || change.after?.kind === 'file')) throw new Error();
        const before = change.before ? valueOf(manifestArtifactSchema.parse(change.before)) : { kind: 'absent' as const };
        const spec = change.after;
        const after = spec ? valueOf(manifestArtifactSchema.parse(spec.kind === 'file'
          ? { kind: 'file', path: spec.path, mode: spec.mode, sha256: sha256(spec.content) }
          : spec.kind === 'symlink' ? { ...spec, mode: 0o777 } : spec)) : { kind: 'absent' as const };
        return mutationSchema.parse({ action: !change.before ? 'create' : !change.after ? 'remove' : 'update', destination,
          kind: spec?.kind ?? change.before?.kind, before: before.kind === 'file' ? { ...before, backup: `file-${String(index)}` } : before,
          after, stagedFile: after.kind === 'file' ? `file-${String(index)}` : null, progress: 'planned', parent: null, pending: null, pendingLinks: [],
          privatePaths: ['prepared', 'capture', 'rollback-prepared', 'rollback-capture'].map(role => ({ role,
            name: `.paseo-room-${randomUUID()}-${role}`, expected: ['capture', 'rollback-prepared'].includes(role) ? before : after })) });
      });
      const journal = validateJournal({ schemaVersion: 1, transactionId: context.transactionId, ...initial, state: 'staged', fileMutations: records }, context);
      await input.validateArtifacts(structuredClone(specs));
      const tx = new FilesystemTransaction(journal, structuredClone(context), filesystem, { kind: 'absent' });
      const transactions = dirname(tx.directory);
      if ((await filesystem.inspect(transactions)).kind === 'absent') await filesystem.directory(transactions);
      else if (!equal(await filesystem.inspect(transactions), { kind: 'directory', mode: 0o700 })) throw new Error();
      await filesystem.directory(tx.directory); // exclusive creation; unfinished journals are never adopted
      // Declarations precede every prepared file and before-image, even if a
      // crash leaves an incomplete (therefore unpublishable) staged bundle.
      await tx.persist();
      await filesystem.directory(join(tx.directory, 'staging'));
      await filesystem.directory(join(tx.directory, 'before'));
      for (const [index, record] of records.entries()) {
        const spec = changes[index]?.after;
        if (spec?.kind === 'file' && record.stagedFile !== null) await filesystem.file(join(tx.directory, 'staging', record.stagedFile), Buffer.from(spec.content));
      }
      // Capture all before-images only after all rendering/staging has succeeded.
      const createdDirectories = new Set(records.filter(record => record.action === 'create' && record.kind === 'directory').map(record => record.destination));
      for (const record of records) {
        const expected = beforeValue(record.before);
        let missingParent = false;
        for (let parent = dirname(record.destination); parent !== context.roomHome; parent = dirname(parent)) {
          if (createdDirectories.has(parent)) { missingParent = true; break; }
        }
        if (missingParent) {
          if (expected.kind !== 'absent') throw new Error();
          continue; // Parent create is checked for absence before it can be published.
        }
        record.parent = parentSchema.parse(await filesystem.parent(record.destination));
        if (!equal(await filesystem.inspect(record.destination, record.parent), expected)) throw new Error();
        if (record.before.kind === 'file') {
          const bytes = await filesystem.read(record.destination, expected);
          await filesystem.file(join(tx.directory, 'before', record.before.backup), bytes);
        }
      }
      tx.journal = validateJournal({ ...journal, fileMutations: records }, context);
      await tx.persist();
      return tx;
    } catch { throw new TransactionError(); }
  }
  static async open(context: JournalContext, filesystem: TransactionFilesystem): Promise<FilesystemTransaction> {
    this.checkContext(context, filesystem);
    const path = join(transactionDirectory(context), 'journal.json');
    const disk = await filesystem.inspect(path);
    const journal = loadJournal(await filesystem.read(path, disk), context);
    return new FilesystemTransaction(journal, structuredClone(context), filesystem, disk);
  }
  private async persist(): Promise<void> {
    const content = Buffer.from(serializeJournal(this.journal, this.context));
    const after: FileValue = { kind: 'file', mode: 0o600, sha256: sha256(content) };
    await this.filesystem.fault('before-journal', this.journalPath);
    // Fixed private journal successor. A leftover must equal this exact intended
    // document; divergent/partial successors are retained, never guessed away.
    if (this.disk.kind === 'absent') {
      await this.filesystem.file(this.journalPath, content);
      this.disk = after;
      await this.filesystem.fault('after-journal', this.journalPath);
      return;
    }
    const temp = join(this.directory, 'journal.next');
    await this.discardSuccessor();
    const parent = await this.filesystem.file(temp, content);
    try { await this.filesystem.rename(this.journalPath, temp, this.disk, after, parent); }
    catch {
      // Rename may have completed before a directory fsync/fault failed. Only our
      // exact intended document may advance the expected disk value; never adopt
      // an unknown journal or retry an ambiguous rename.
      if (equal(await this.filesystem.inspect(this.journalPath), after)) this.disk = after;
      throw new TransactionError();
    }
    this.disk = after;
    await this.filesystem.fault('after-journal', this.journalPath);
  }
  private async discardSuccessor(): Promise<void> {
    const temp = join(this.directory, 'journal.next');
    const existing = await this.filesystem.inspect(temp);
    if (existing.kind === 'absent') return;
    const candidate = loadJournal(await this.filesystem.read(temp, existing), this.context);
    const durable = loadJournal(await this.filesystem.read(this.journalPath, this.disk), this.context);
    if (!this.isSuccessor(durable, candidate)) throw new TransactionError();
    await this.filesystem.perform(temp, { action: 'remove', expected: existing });
  }
  private isSuccessor(previous: TransactionJournalV1, next: TransactionJournalV1): boolean {
    if (previous.state !== next.state && !transitions[previous.state].includes(next.state)) return false;
    const immutable = (value: TransactionJournalV1): unknown => ({ ...value, state: 'staged',
      fileMutations: value.fileMutations.map(record => ({ ...record, progress: 'planned', parent: null, pending: null, pendingLinks: [] })) });
    if (!equal(immutable(previous), immutable(next))) return false;
    const progress = ['planned', 'intent', 'completed', 'compensating', 'compensated'];
    return previous.fileMutations.every((record, index) => {
      const successor = next.fileMutations[index];
      if (!successor || progress.indexOf(successor.progress) < progress.indexOf(record.progress)) return false;
      if (record.parent) {
        if (!successor.parent) return false;
        const sameIdentity = equal({ ...successor.parent, links: record.parent.links }, record.parent);
        if (!sameIdentity) {
          const ownerIndex = previous.fileMutations.findIndex(owner => owner.destination === dirname(record.destination) &&
            owner.before.kind === 'directory' && owner.progress === 'compensating');
          const restored = ownerIndex >= 0 ? next.fileMutations[ownerIndex] : undefined;
          if (previous.state !== 'rolling-back' || !restored || restored.before.kind !== 'directory' ||
              !['compensating', 'compensated'].includes(restored.progress)) return false;
          const siblings = next.fileMutations.filter(item => dirname(item.destination) === dirname(record.destination) && item.parent);
          if (!siblings.every(item => equal(item.parent, successor.parent))) return false;
        } else if (successor.parent.links !== record.parent.links && !previous.fileMutations.some(owner =>
          owner.parent?.device === record.parent?.device && owner.parent?.inode === record.parent?.inode &&
          owner.pendingLinks.includes(successor.parent?.links ?? -1))) return false;
      }
      return true;
    });
  }
  /** Caller has independently validated the matching durable manifest commit point. */
  async reconcileCommitted(): Promise<void> {
    return this.exclusive(async () => {
      if (this.journal.state === 'committed') return;
      this.journal = validateJournal({ ...this.journal, state: 'committed' }, this.context);
      await this.persist();
    });
  }
  /** Read-only validation of an interrupted journal successor. */
  async successorSafe(): Promise<boolean> {
    const path = join(this.directory, 'journal.next');
    const disk = await this.filesystem.inspect(path);
    return disk.kind === 'absent' || this.isSuccessor(this.snapshot,
      loadJournal(await this.filesystem.read(path, disk), this.context));
  }
  async retireSuccessor(): Promise<void> { await this.discardSuccessor(); }
  async transition(state: JournalState): Promise<void> {
    return this.exclusive(async () => {
      this.journal = transitionJournal(this.journal, state, this.context);
      await this.persist();
    });
  }
  private privatePath(record: FileMutationRecord, role: z.infer<typeof privateSchema>['role']): string {
    const entry = record.privatePaths.find(value => value.role === role);
    if (!entry) throw new TransactionError();
    return join(dirname(record.destination), entry.name);
  }
  private async reconcileParent(record: FileMutationRecord): Promise<void> {
    if (!record.parent) return;
    const admitted = await this.filesystem.parent(record.destination);
    if (!equal({ ...admitted, links: record.parent.links }, record.parent)) throw new TransactionError();
    const owner = this.journal.fileMutations.find(other => other.parent?.device === admitted.device &&
      other.parent.inode === admitted.inode && other.pending !== null);
    if (!owner?.pending) {
      if (admitted.links !== record.parent.links) throw new TransactionError();
      return;
    }
    const pending = owner.pending;
    const path = pending.role === 'destination' ? owner.destination : this.privatePath(owner, pending.role);
    const finish = async (): Promise<void> => {
      if (!owner.pendingLinks.includes(admitted.links)) throw new TransactionError();
      const reply = await this.filesystem.perform(path, pending.value.kind === 'file'
        ? { action: 'sync-file', expected: pending.value }
        : { action: 'sync', expected: pending.value }, admitted);
      this.acceptParent(admitted, reply.parent);
    };
    if (pending.action === 'publish') {
      const source = this.privatePath(owner, owner.progress === 'compensating' ? 'rollback-prepared' : 'prepared');
      try {
        const current = await this.filesystem.inspect(path, admitted);
        if (equal(current, pending.value)) { await finish(); return; }
        if (current.kind !== 'absent' || !equal(await this.filesystem.inspect(source, admitted), pending.value) || admitted.links !== record.parent.links) throw new TransactionError();
        return; // Publication had not started; the declared prepared file is intact.
      } catch (error) {
        if (error instanceof TransactionError) throw error;
        const reply = await this.filesystem.perform(path, { action: 'reconcile', source: basename(source), sourceExpected: pending.value }, admitted);
        this.acceptParent(admitted, reply.parent);
        return;
      }
    }
    const declaration = pending.role === 'destination' ? undefined : owner.privatePaths.find(entry => entry.role === pending.role);
    const before = pending.role === 'destination' || pending.action !== 'remove'
      ? { kind: 'absent' as const }
      : declaration?.expected;
    if (!before) throw new TransactionError();
    const current = await this.filesystem.inspect(path, admitted, pending.value.kind !== 'file' && before.kind !== 'file');
    if (equal(current, pending.value)) { await finish(); return; }
    if (!equal(current, before) || admitted.links !== record.parent.links) throw new TransactionError();
    // The action had not started. No durability barrier is needed.
  }
  private async ownedAction(record: FileMutationRecord, path: string,
    operation: Parameters<TransactionFilesystem['perform']>[1], deltas: readonly number[]): Promise<void> {
    if (!record.parent) throw new TransactionError();
    const parent = record.parent;
    const entry = record.privatePaths.find(value => join(dirname(record.destination), value.name) === path);
    const role = path === record.destination ? 'destination' : entry?.role;
    if (!role || !['file', 'publish', 'link', 'directory', 'remove'].includes(operation.action)) throw new TransactionError();
    const value = operation.action === 'remove' ? { kind: 'absent' as const } : entry?.expected ??
      (record.progress === 'compensating' ? beforeValue(record.before) : record.after);
    record.pending = mutationSchema.shape.pending.parse({ role, action: operation.action, value });
    record.pendingLinks = [...new Set(deltas.map(delta => parent.links + delta))];
    await this.persist();
    const reply = await this.filesystem.perform(path, operation, parent);
    this.acceptParent(parent, reply.parent);
    record.pendingLinks = [];
    record.pending = null;
    await this.persist();
  }
  private async reconcile(record: FileMutationRecord): Promise<void> {
    if (!record.parent) return;
    await this.reconcileParent(record);
    for (const entry of record.privatePaths) {
      const path = join(dirname(record.destination), entry.name);
      try {
        const current = await this.filesystem.inspect(path, record.parent, entry.expected.kind !== 'file');
        if (current.kind !== 'absent' && !equal(current, entry.expected)) throw new TransactionError();
      } catch {
        // Only the declared prepared file and destination may temporarily share
        // an inode. The anchored action validates the exact pair and nlink=2.
        if (!['prepared', 'rollback-prepared'].includes(entry.role) || entry.expected.kind !== 'file') throw new TransactionError();
        const previous = record.parent;
        const reply = await this.filesystem.perform(record.destination, { action: 'reconcile', source: entry.name,
          sourceExpected: entry.expected }, previous);
        this.acceptParent(previous, reply.parent);
      }
    }
  }
  private acceptParent(previous: Metadata, next: Metadata | undefined): void {
    if (!next) throw new TransactionError();
    for (const record of this.journal.fileMutations) {
      if (record.parent?.device === previous.device && record.parent.inode === previous.inode) record.parent = parentSchema.parse(next);
    }
  }
  private async syncValue(record: FileMutationRecord, value: FileValue): Promise<void> {
    if (!record.parent) throw new TransactionError();
    await this.filesystem.perform(record.destination, value.kind === 'file'
      ? { action: 'sync-file', expected: value } : { action: 'sync', expected: value }, record.parent);
  }
  private async rebindImmediateChildren(directory: string): Promise<void> {
    const next = parentSchema.parse(await this.filesystem.parent(join(directory, '.parent-probe')));
    for (const record of this.journal.fileMutations) {
      if (dirname(record.destination) === directory) record.parent = next;
    }
  }
  private async replace(record: FileMutationRecord, expected: FileValue, desired: FileValue, restoring: boolean): Promise<void> {
    const path = record.destination;
    if (!record.parent) throw new TransactionError();
    let parent: Metadata = record.parent;
    const capture = this.privatePath(record, restoring ? 'rollback-capture' : 'capture');
    const temp = this.privatePath(record, restoring ? 'rollback-prepared' : 'prepared');
    // Preparing cannot change the destination. The full declaration was persisted
    // before this method, including both forward and rollback names.
    if (desired.kind === 'file' && (await this.filesystem.inspect(temp, parent)).kind === 'absent') {
      const name = restoring && record.before.kind === 'file' ? record.before.backup : record.stagedFile;
      if (name === null) throw new TransactionError();
      const bytes = await this.filesystem.read(join(this.directory, restoring ? 'before' : 'staging', name), desired);
      await this.filesystem.fault('before-fsync', temp);
      await this.ownedAction(record, temp, { action: 'file', expected: { kind: 'absent' }, content: bytes.toString('base64') }, [process.platform === 'darwin' ? 1 : 0]);
      parent = record.parent;
      await this.filesystem.fault('after-fsync', temp);
    }
    if (expected.kind !== 'absent') {
      const captured = await this.filesystem.inspect(capture, parent, expected.kind !== 'file');
      if (captured.kind === 'absent') {
        // Refuse nonempty directories before moving mutable runtime children.
        if (expected.kind === 'directory' && (await this.filesystem.entries(path)).length !== 0) throw new TransactionError();
        await this.filesystem.fault('before-rename', path);
        await this.filesystem.perform(capture, { action: 'capture', source: basename(path), sourceExpected: expected }, parent);
        await this.filesystem.fault('after-rename', path);
      } else if (!equal(captured, expected)) throw new TransactionError();
    }
    if (desired.kind === 'file') {
      await this.ownedAction(record, path, { action: 'publish', source: basename(temp), sourceExpected: desired }, [0, process.platform === 'darwin' ? 1 : 0]);
    } else if (desired.kind === 'symlink') {
      await this.ownedAction(record, path, { action: 'link', expected: { kind: 'absent' }, target: desired.target, linkMode: desired.mode }, [process.platform === 'darwin' ? 1 : 0]);
    } else if (desired.kind === 'directory') {
      await this.ownedAction(record, path, { action: 'directory', expected: { kind: 'absent' } }, [1]);
      // A recreated directory has a new inode. Rebind only its declared immediate
      // children so reverse compensation remains anchored to the restored container.
      await this.rebindImmediateChildren(path);
    } else {
      if ((await this.filesystem.inspect(path, parent)).kind !== 'absent') throw new TransactionError();
      await this.syncValue(record, desired);
    }
  }
  /** Input order is the planner's dependency order (directories before children). */
  async publish(interrupted: () => boolean = () => false): Promise<void> {
    return this.exclusive(async () => {
      if (this.journal.state !== 'staged' || interrupted()) throw new TransactionError();
      // Recheck the complete private bundle before the first destination mutation.
      for (const record of this.journal.fileMutations) {
        if (record.stagedFile !== null && !equal(await this.filesystem.inspect(join(this.directory, 'staging', record.stagedFile)), record.after)) throw new TransactionError();
        if (record.before.kind === 'file' && !equal(await this.filesystem.inspect(join(this.directory, 'before', record.before.backup)), beforeValue(record.before))) throw new TransactionError();
      }
      this.journal = transitionJournal(this.journal, 'publishing-files', this.context);
      await this.persist();
      for (const record of this.journal.fileMutations) {
        if (interrupted()) throw new TransactionError();
        if (!record.parent) record.parent = parentSchema.parse(await this.filesystem.parent(record.destination));
        record.progress = 'intent';
        await this.persist();
        await this.filesystem.fault('before-mutation', record.destination);
        if (interrupted()) throw new TransactionError();
        await this.replace(record, beforeValue(record.before), record.after, false);
        record.progress = 'completed';
        await this.filesystem.fault('after-mutation', record.destination);
        await this.persist();
        // Once completion is durable, manifest metadata/private before-images are
        // sufficient for rollback. Retire same-parent captures before a later
        // parent-directory removal tests emptiness.
        await this.removePrivate(record);
      }
    });
  }
  /** No provider effects: caller must compensate providerAfter before invoking.
   * Interrupted steps are reconciled from declared exact captures/prepared paths,
   * never by overwriting a destination. Independently safe records continue. */
  async compensate(): Promise<'rolled-back' | 'recovery-required'> {
    return this.exclusive(async () => {
      if (this.journal.state === 'rolled-back') return 'rolled-back';
      if (this.journal.state === 'committed') throw new TransactionError();
      if (this.journal.state !== 'rolling-back') this.journal = transitionJournal(this.journal, 'rolling-back', this.context);
      await this.persist();
      let diverged = false;
      for (const record of [...this.journal.fileMutations].reverse()) {
        if (record.progress === 'planned' || record.progress === 'compensated') continue;
        try {
          await this.filesystem.fault('before-compensation', record.destination);
          await this.reconcile(record);
          record.pending = null; record.pendingLinks = [];
          const current = await this.filesystem.inspect(record.destination, record.parent ?? undefined);
          const before = beforeValue(record.before);
          if (equal(current, before) && ['intent', 'compensating'].includes(record.progress)) {
            if (before.kind === 'directory') {
              await this.rebindImmediateChildren(record.destination);
              // Persist the new child-parent inode binding before this restored
              // directory can be treated as compensated.
              await this.persist();
            }
            await this.syncValue(record, before);
            record.progress = 'compensating';
          } else {
            const capturedBefore = await this.filesystem.inspect(this.privatePath(record, 'capture'), record.parent ?? undefined, before.kind !== 'file');
            const capturedAfter = await this.filesystem.inspect(this.privatePath(record, 'rollback-capture'), record.parent ?? undefined, record.after.kind !== 'file');
            const interruptedCapture = current.kind === 'absent' && (equal(capturedBefore, before) && before.kind !== 'absent' ||
              equal(capturedAfter, record.after) && record.after.kind !== 'absent');
            if (!equal(current, record.after) && !interruptedCapture) throw new TransactionError();
            record.progress = 'compensating';
            await this.persist();
            await this.filesystem.fault('before-mutation', record.destination);
            await this.replace(record, current.kind === 'absent' ? current : record.after, before, true);
            await this.filesystem.fault('after-mutation', record.destination);
          }
          await this.removePrivate(record);
          record.progress = 'compensated';
          await this.persist();
          await this.filesystem.fault('after-compensation', record.destination);
        } catch { diverged = true; }
      }
      this.journal = transitionJournal(this.journal, diverged ? 'recovery-required' : 'rolled-back', this.context);
      await this.persist();
      return diverged ? 'recovery-required' : 'rolled-back';
    });
  }
  private async removePrivate(record: FileMutationRecord): Promise<void> {
    if (!record.parent) return;
    for (const entry of record.privatePaths) {
      const path = join(dirname(record.destination), entry.name);
      const current = await this.filesystem.inspect(path, record.parent, entry.expected.kind !== 'file');
      if (current.kind === 'absent') continue;
      if (!equal(current, entry.expected)) throw new TransactionError();
      await this.filesystem.fault('before-cleanup', path);
      await this.ownedAction(record, path, { action: 'remove', expected: entry.expected }, [process.platform === 'darwin' || entry.expected.kind === 'directory' ? -1 : 0]);
      await this.filesystem.fault('after-cleanup', path);
    }
  }
  private async cleanupParentExists(record: FileMutationRecord): Promise<boolean> {
    const ancestors: string[] = [];
    for (let path = dirname(record.destination); path !== this.context.roomHome; path = dirname(path)) ancestors.push(path);
    for (const path of ancestors.reverse()) {
      const current = await this.filesystem.inspect(path);
      if (current.kind === 'absent') {
        const owner = this.journal.fileMutations.find(value => value.destination === path && value.kind === 'directory');
        if (!owner || !(this.journal.state === 'rolled-back' && owner.before.kind === 'absent' && ['planned', 'compensated'].includes(owner.progress) ||
            this.journal.state === 'committed' && owner.after.kind === 'absent')) throw new TransactionError();
        return false; // A declared terminal absent ancestor has no remaining leaves.
      }
      if (current.kind !== 'directory') throw new TransactionError();
    }
    return true;
  }
  /** Exact known leaves only; never rm-recursive. Unknown additions are retained.
   * Before-images remain until terminal cleanup is explicitly requested. */
  async cleanup(): Promise<void> {
    return this.exclusive(async () => {
      if (!['committed', 'rolled-back'].includes(this.journal.state) ||
          !equal(loadJournal(await this.filesystem.read(this.journalPath, this.disk), this.context), this.journal)) throw new TransactionError();
      await this.discardSuccessor();
      const allowed = new Map<string, Set<string>>([
        [this.directory, new Set(['journal.json', 'before', 'staging'])],
        [join(this.directory, 'staging'), new Set(this.journal.fileMutations.flatMap(record => record.stagedFile === null ? [] : [record.stagedFile]))],
        [join(this.directory, 'before'), new Set(this.journal.fileMutations.flatMap(record => record.before.kind === 'file' ? [record.before.backup] : []))],
      ]);
      for (const [path, names] of allowed) {
        if ((await this.filesystem.inspect(path)).kind !== 'absent' && (await this.filesystem.entries(path)).some(name => !names.has(name))) throw new TransactionError();
      }
      const remove = async (path: string, expected: FileValue): Promise<void> => {
        await this.filesystem.fault('before-cleanup', path);
        const current = await this.filesystem.inspect(path);
        if (current.kind !== 'absent') {
          if (!equal(current, expected)) throw new TransactionError();
          await this.filesystem.perform(path, { action: 'remove', expected });
        } else {
          // A prior cleanup may have unlinked the leaf and crashed before its
          // parent fsync. Re-establish that durability barrier before the journal
          // can be deleted.
          await this.filesystem.perform(path, { action: 'sync', expected: { kind: 'absent' } });
        }
        await this.filesystem.fault('after-cleanup', path);
      };
      for (const record of [...this.journal.fileMutations].reverse()) {
        if (record.parent && await this.cleanupParentExists(record)) {
          await this.reconcile(record);
          await this.removePrivate(record);
        }
      }
      for (const record of this.journal.fileMutations) {
        if ((await this.filesystem.inspect(join(this.directory, 'staging'))).kind !== 'absent' && record.stagedFile !== null) await remove(join(this.directory, 'staging', record.stagedFile), record.after);
        if ((await this.filesystem.inspect(join(this.directory, 'before'))).kind !== 'absent' && record.before.kind === 'file') await remove(join(this.directory, 'before', record.before.backup), beforeValue(record.before));
      }
      for (const name of ['staging', 'before']) await remove(join(this.directory, name), { kind: 'directory', mode: 0o700 });
      // The journal is last: failures preserve terminal evidence whenever possible.
      await remove(this.journalPath, this.disk);
      await remove(this.directory, { kind: 'directory', mode: 0o700 });
    });
  }
}

export interface TransactionSignals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}
export class TransactionSignalError extends Error {
  constructor(readonly signal: 'SIGINT' | 'SIGTERM', readonly compensationFailed: boolean) { super(`Transaction interrupted by ${signal}.`); }
}
/** Install only around active work. The first signal wins; subsequent signals do
 * not duplicate compensation. No process.kill/exit; callers map the typed outcome.
 * Compensation waits for active work to settle, avoiding concurrent publication. */
export async function withTransactionSignals<T>(work: (interrupted: () => boolean) => Promise<T>,
  compensate: () => Promise<'rolled-back' | 'recovery-required'>, signals: TransactionSignals = process): Promise<T> {
  let signal: 'SIGINT' | 'SIGTERM' | undefined;
  const interrupt = (): void => { signal ??= 'SIGINT'; };
  const terminate = (): void => { signal ??= 'SIGTERM'; };
  signals.on('SIGINT', interrupt);
  signals.on('SIGTERM', terminate);
  try {
    let result: T;
    try { result = await work(() => signal !== undefined); }
    catch (error) { if (!signal) throw error; throw await outcome(signal); }
    if (signal) throw await outcome(signal);
    return result;
  } finally {
    signals.removeListener('SIGINT', interrupt);
    signals.removeListener('SIGTERM', terminate);
  }
  async function outcome(received: 'SIGINT' | 'SIGTERM'): Promise<TransactionSignalError> {
    let failed: boolean;
    try { failed = await compensate() !== 'rolled-back'; } catch { failed = true; }
    return new TransactionSignalError(received, failed);
  }
}

/** Fixed complete null snapshot for first install/uninstall; no daemon access. */
export function absentTransactionProviders(): TransactionProviderRecord {
  return Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, null])) as TransactionProviderRecord;
}
