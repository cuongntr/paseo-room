import { dirname } from 'node:path';
import { type TransactionFilesystem, type FileValue } from './transaction-fs.js';

/** Missing ancestors discharge missing descendants; unsafe parents are never
 * followed. This reads metadata only until the admitted destination is reached. */
export async function inspectTransactionPath(fs: TransactionFilesystem, path: string, nonFile = false): Promise<FileValue> {
  if (path === fs.context.roomHome) return fs.inspect(path, undefined, nonFile);
  const parents: string[] = [];
  for (let parent = dirname(path); parent !== fs.context.roomHome; parent = dirname(parent)) {
    if (dirname(parent) === parent) throw new Error('Unsafe transaction path.');
    parents.push(parent);
  }
  for (const parent of parents.reverse()) {
    const value = await fs.inspect(parent, undefined, true);
    if (value.kind === 'absent') return value;
    if (value.kind !== 'directory') throw new Error('Unsafe transaction parent.');
  }
  return fs.inspect(path, undefined, nonFile);
}
