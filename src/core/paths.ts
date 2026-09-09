import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ReadonlyFileSystem } from './seams.js';

export function containsPath(parent: string, child: string): boolean {
  const tail = relative(parent, child);
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`));
}

/** Resolve missing suffixes without creating them. Reject links in managed destinations. */
export async function resolveManagedRoot(filesystem: ReadonlyFileSystem, input: string): Promise<string> {
  const path = resolve(input);
  let cursor = path;
  do {
    const metadata = await filesystem.lstat(cursor);
    if (metadata && metadata.kind !== 'directory') {
      throw new Error('Choose a managed root with directory-only, non-symlink parents.');
    }
    cursor = dirname(cursor);
  } while (dirname(cursor) !== cursor);
  cursor = path;
  while (!(await filesystem.lstat(cursor))) cursor = dirname(cursor);
  return resolve(await filesystem.realpath(cursor), relative(cursor, path));
}

export function requireDisjointRoots(canonical: string, managed: string): void {
  if (containsPath(canonical, managed) || containsPath(managed, canonical)) {
    throw new Error('Choose a --room-home outside the canonical Codex home; neither root may contain the other.');
  }
}
