import { join, dirname } from 'node:path';
import { canonicalJson, sha256 } from './hash.js';
import { FilesystemTransaction, serializeJournal, TransactionError } from './transaction.js';
import { type FileValue } from './transaction-fs.js';

/** Manifest publication legitimately changes the root's directory link count on
 * macOS. FilesystemTransaction.cleanup cannot infer that orchestrator effect.
 * After a committed manifest, retire only the completed, private bundle; never
 * revisit or mutate managed destinations. Interrupted cleanup is left for recover. */
export async function cleanupCommittedTransaction(tx: FilesystemTransaction): Promise<void> {
  const journal = tx.snapshot;
  if (journal.state !== 'committed') throw new TransactionError();
  const fs = tx.filesystem;
  const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
  const journalValue: FileValue = { kind: 'file', mode: 0o600, sha256: sha256(serializeJournal(journal, tx.context)) };
  if (!equal(await fs.inspect(tx.journalPath), journalValue)) throw new TransactionError();
  const leaves = new Map<string, FileValue>();
  for (const record of journal.fileMutations) {
    if (record.progress !== 'completed' || record.pending !== null || !record.parent) throw new TransactionError();
    const ancestors: string[] = [];
    for (let path = dirname(record.destination); path !== tx.context.roomHome; path = dirname(path)) ancestors.push(path);
    let parentExists = true;
    for (const path of ancestors.reverse()) {
      const current = await fs.inspect(path);
      if (current.kind === 'absent') {
        if (!journal.fileMutations.some(owner => owner.destination === path && owner.before.kind === 'directory' && owner.after.kind === 'absent')) throw new TransactionError();
        parentExists = false;
        break;
      }
      if (current.kind !== 'directory') throw new TransactionError();
    }
    if (parentExists) {
      const parent = await fs.parent(record.destination);
      if (!equal({ ...parent, links: record.parent.links }, record.parent)) throw new TransactionError();
      for (const entry of record.privatePaths) {
        if ((await fs.inspect(join(dirname(record.destination), entry.name), parent)).kind !== 'absent') throw new TransactionError();
      }
    }
    if (record.stagedFile !== null) leaves.set(join(tx.directory, 'staging', record.stagedFile), record.after);
    if (record.before.kind === 'file') leaves.set(join(tx.directory, 'before', record.before.backup),
      { kind: 'file', mode: 0o600, sha256: record.before.sha256 });
  }
  await tx.retireSuccessor();
  for (const name of ['before', 'staging']) {
    const directory = join(tx.directory, name);
    if ((await fs.inspect(directory)).kind !== 'absent' && (await fs.entries(directory)).some(entry => !leaves.has(join(directory, entry)))) throw new TransactionError();
  }
  if ((await fs.entries(tx.directory)).some(name => !['before', 'staging', 'journal.json'].includes(name))) throw new TransactionError();
  // Validate the whole bundle before deleting its first known leaf.
  const available = new Map<string, FileValue>();
  for (const [path, expected] of leaves) {
    if ((await fs.inspect(dirname(path))).kind === 'absent') continue;
    const current = await fs.inspect(path);
    if (current.kind !== 'absent' && !equal(current, expected)) throw new TransactionError();
    available.set(path, current);
  }
  for (const [path, expected] of available) await fs.perform(path, expected.kind === 'absent'
    ? { action: 'sync', expected } : { action: 'remove', expected });
  for (const name of ['before', 'staging']) {
    const path = join(tx.directory, name);
    const current = await fs.inspect(path);
    await fs.perform(path, current.kind === 'absent' ? { action: 'sync', expected: current }
      : { action: 'remove', expected: { kind: 'directory', mode: 0o700 } });
  }
  await fs.perform(tx.journalPath, { action: 'remove', expected: journalValue });
  await fs.perform(tx.directory, { action: 'remove', expected: { kind: 'directory', mode: 0o700 } });
}
