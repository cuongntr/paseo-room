import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Operation } from './result.js';

export type Entry =
  | { readonly kind: 'dir'; readonly path: string }
  /** `once` writes the file only when absent: runtime state the agent owns after setup. */
  | { readonly kind: 'file'; readonly path: string; readonly content: string; readonly once?: true }
  | { readonly kind: 'link'; readonly path: string; readonly target: string };

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

async function current(entry: Entry): Promise<'absent' | 'same' | 'different'> {
  let stat;
  try { stat = await lstat(entry.path); } catch { return 'absent'; }
  if (entry.kind === 'dir') return stat.isDirectory() ? 'same' : 'different';
  if (entry.kind === 'link') {
    if (!stat.isSymbolicLink()) return 'different';
    return await readlink(entry.path) === entry.target ? 'same' : 'different';
  }
  if (!stat.isFile()) return 'different';
  if (entry.once) return 'same';
  return await readFile(entry.path, 'utf8') === entry.content ? 'same' : 'different';
}

/** Everything lives under the room home, which this CLI owns outright. */
export async function planEntries(entries: readonly Entry[]): Promise<Operation[]> {
  const operations: Operation[] = [];
  for (const entry of entries) {
    const state = await current(entry);
    operations.push({
      action: state === 'same' ? 'noop' : state === 'absent' ? 'create' : 'update',
      kind: entry.kind,
      target: entry.path,
    });
  }
  return operations;
}

/** Rewrites only what differs, so a repeat run costs stats rather than writes. */
export async function applyEntries(entries: readonly Entry[]): Promise<void> {
  for (const entry of entries) {
    if (await current(entry) === 'same') continue;
    if (entry.kind === 'dir') {
      await mkdir(entry.path, { recursive: true, mode: DIR_MODE });
      continue;
    }
    await mkdir(dirname(entry.path), { recursive: true, mode: DIR_MODE });
    await rm(entry.path, { force: true, recursive: true });
    if (entry.kind === 'link') await symlink(entry.target, entry.path);
    else {
      await writeFile(entry.path, entry.content, { mode: FILE_MODE });
      await chmod(entry.path, FILE_MODE);
    }
  }
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

/** Which of `names` exist under `home`, probed once for all roles that share them. */
export async function existingPaths(home: string, names: readonly string[]): Promise<string[]> {
  const paths = names.map(name => join(home, name));
  const present = await Promise.all(paths.map(exists));
  return paths.filter((_, index) => present[index] === true);
}

export async function readIfPresent(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch { return undefined; }
}
