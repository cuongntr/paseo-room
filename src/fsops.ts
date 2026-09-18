import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Operation } from './result.js';

/** A directory the room creates but whose children it does not own. */
export interface DirEntry { readonly kind: 'dir'; readonly path: string }
/** `once` writes the file only when absent: runtime state the agent owns after setup. */
export interface FileEntry { readonly kind: 'file'; readonly path: string; readonly content: string; readonly once?: true }
export interface LinkEntry { readonly kind: 'link'; readonly path: string; readonly target: string }
/**
 * A managed path this room declares must not exist, so suppressing generated content
 * removes the stale file instead of leaving an older generation behind. Like every other
 * managed entry it only ever replaces the shape it writes: a regular file. Anything else
 * is refused rather than deleted.
 */
export interface AbsentEntry { readonly kind: 'absent'; readonly path: string }
/**
 * A directory whose whole child inventory the room owns: names outside `children`
 * are removed so a generated projection cannot go stale. Ownership is declared here
 * and never inferred from an ordinary `dir`, so it stays limited to generated
 * projections such as Peer `skills` — never role homes or credential-bearing paths.
 */
export interface ManagedDirEntry {
  readonly kind: 'managed-dir';
  readonly path: string;
  readonly children: readonly string[];
  /** The single legacy shape this path may be migrated from: a symlink to this target. */
  readonly legacyLink?: string;
  /**
   * Names inside this directory the room neither writes nor reconciles, because the agent's
   * own runtime owns them. Without this, exact ownership would treat the agent's state as a
   * stale child and try to delete what it did not generate.
   */
  readonly reserved?: readonly string[];
}
export type Entry = DirEntry | FileEntry | LinkEntry | ManagedDirEntry | AbsentEntry;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * An existing path is not the shape the room manages, so replacing it would destroy
 * something this CLI does not own. Raised before any deletion.
 */
export class ManagedPathError extends Error {
  readonly path: string;
  readonly fix: string;
  constructor(path: string, message: string, fix: string) {
    super(message);
    this.name = 'ManagedPathError';
    this.path = path;
    this.fix = fix;
  }
}

const MOVE_ASIDE = 'Check that path for role-owned credentials, move it aside manually, then run setup again.';

function shape(stat: Stats): string {
  if (stat.isSymbolicLink()) return 'a symbolic link';
  if (stat.isDirectory()) return 'a directory';
  if (stat.isFile()) return 'a regular file';
  return 'a special file';
}

function refuse(path: string, expected: string, stat: Stats): never {
  throw new ManagedPathError(path, `Refusing to replace ${path}: expected ${expected} but found ${shape(stat)}.`, MOVE_ASIDE);
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

async function lstatOrAbsent(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** Names present under a managed directory that its declaration does not claim. */
async function staleChildren(entry: ManagedDirEntry): Promise<string[]> {
  const declared = new Set([...entry.children, ...entry.reserved ?? []]);
  let names: string[];
  try { names = await readdir(entry.path); } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  return names.filter(name => !declared.has(name));
}

async function current(entry: Entry): Promise<'absent' | 'same' | 'different'> {
  const stat = await lstatOrAbsent(entry.path);
  // A declared-absent path is already correct when nothing is there.
  if (entry.kind === 'absent') return stat ? 'different' : 'same';
  if (!stat) return 'absent';
  if (entry.kind === 'dir') return stat.isDirectory() ? 'same' : 'different';
  if (entry.kind === 'managed-dir') {
    if (!stat.isDirectory()) return 'different';
    return (await staleChildren(entry)).length === 0 ? 'same' : 'different';
  }
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
      action: state === 'same' ? 'noop' : entry.kind === 'absent' ? 'remove' : state === 'absent' ? 'create' : 'update',
      // A managed directory is still a directory to everything that reports operations.
      kind: entry.kind === 'managed-dir' ? 'dir' : entry.kind === 'absent' ? 'file' : entry.kind,
      target: entry.path,
    });
  }
  return operations;
}

/** Unique so two runs, or a leftover from a failed one, can never collide. */
function tempSibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.paseo-room-${randomBytes(8).toString('hex')}`);
}

/** A managed file or link may replace only an absent path or the same shape. */
async function assertReplaceable(entry: FileEntry | LinkEntry): Promise<void> {
  const stat = await lstatOrAbsent(entry.path);
  if (!stat) return;
  if (entry.kind === 'link') {
    if (!stat.isSymbolicLink()) refuse(entry.path, 'a symbolic link', stat);
    return;
  }
  if (!stat.isFile()) refuse(entry.path, 'a regular file', stat);
}

/** Build beside the target and rename, so a reader never sees a half-written path. */
async function replaceAtomically(entry: FileEntry | LinkEntry): Promise<void> {
  const temp = tempSibling(entry.path);
  try {
    if (entry.kind === 'link') await symlink(entry.target, temp);
    else {
      await writeFile(temp, entry.content, { mode: FILE_MODE });
      await chmod(temp, FILE_MODE);
    }
    await rename(temp, entry.path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function applyDirectory(path: string): Promise<void> {
  const stat = await lstatOrAbsent(path);
  if (stat && !stat.isDirectory()) refuse(path, 'a directory', stat);
  await mkdir(path, { recursive: true, mode: DIR_MODE });
}

/**
 * Creates the projection, migrating the one declared legacy symlink by unlinking the
 * link alone, and removes only undeclared children that are links or files. An
 * unrecognized shape — including a real child directory — fails instead of being
 * deleted recursively.
 */
async function applyManagedDirectory(entry: ManagedDirEntry): Promise<void> {
  const stat = await lstatOrAbsent(entry.path);
  if (stat?.isSymbolicLink() === true) {
    const target = await readlink(entry.path);
    if (entry.legacyLink === undefined || target !== entry.legacyLink) {
      throw new ManagedPathError(entry.path,
        `Refusing to replace ${entry.path}: this room owns that directory, but it is a symbolic link to ${target}.`,
        MOVE_ASIDE);
    }
    // Unlink the alias only; the operator directory it pointed at is never touched.
    await unlink(entry.path);
    await mkdir(entry.path, { recursive: true, mode: DIR_MODE });
    return;
  }
  if (stat && !stat.isDirectory()) refuse(entry.path, 'a directory this room owns', stat);
  await mkdir(entry.path, { recursive: true, mode: DIR_MODE });
  if (!stat) return;
  for (const name of await staleChildren(entry)) {
    const child = join(entry.path, name);
    const childStat = await lstatOrAbsent(child);
    if (!childStat) continue;
    if (!childStat.isFile() && !childStat.isSymbolicLink()) {
      throw new ManagedPathError(child,
        `Refusing to remove ${child}: this room manages ${entry.path} by name, but that stale child is ${shape(childStat)} rather than a generated file or link.`,
        MOVE_ASIDE);
    }
    await rm(child, { force: true });
  }
}

/**
 * Removes a suppressed managed file. Only a regular file is ever deleted: a directory,
 * link or special file at that path belongs to something this room does not own.
 */
async function removeManagedFile(path: string): Promise<void> {
  const stat = await lstatOrAbsent(path);
  if (!stat) return;
  if (!stat.isFile()) refuse(path, 'a regular file this room generated', stat);
  await rm(path, { force: true });
}

/** Rewrites only what differs, so a repeat run costs stats rather than writes. */
export async function applyEntries(entries: readonly Entry[]): Promise<void> {
  for (const entry of entries) {
    if (await current(entry) === 'same') continue;
    if (entry.kind === 'dir') {
      await applyDirectory(entry.path);
      continue;
    }
    if (entry.kind === 'managed-dir') {
      await applyManagedDirectory(entry);
      continue;
    }
    if (entry.kind === 'absent') {
      await removeManagedFile(entry.path);
      continue;
    }
    await mkdir(dirname(entry.path), { recursive: true, mode: DIR_MODE });
    await assertReplaceable(entry);
    await replaceAtomically(entry);
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
