import { join } from 'node:path';
import { sha256 } from './hash.js';
import { transactionDirectory, type JournalContext } from './transaction.js';
import { type TransactionFilesystem } from './transaction-fs.js';

/** An unresolved RPC can complete late. A durable fence forbids automatic retry
 * or compensation, including across process death. No provider values/secrets. */
export async function guardedProviderMutation(context: JournalContext, fs: TransactionFilesystem,
  mutation: () => Promise<unknown>): Promise<void> {
  const path = join(transactionDirectory(context), 'provider-mutation.pending');
  const bytes = Buffer.from('Unresolved provider mutation; preserve evidence.\n');
  await fs.file(path, bytes);
  await mutation();
  await fs.perform(path, { action: 'remove', expected: { kind: 'file', mode: 0o600, sha256: sha256(bytes) } });
}
