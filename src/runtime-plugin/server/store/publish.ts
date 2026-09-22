/**
 * No-clobber atomic publication for runtime state (docs/design/runtime-coordination.md §4.2).
 *
 * A file is written whole to a unique sibling temporary, fsynced, and published with `link()` to
 * a name that did not exist. `link()` fails with EEXIST instead of replacing, so a published
 * file can never be overwritten — not by an overlapping plugin reload and not by a retry. A
 * filesystem that cannot hard-link fails closed; there is deliberately no rename fallback,
 * because rename silently replaces an existing target.
 */
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const TEMPORARY_PREFIX = '.tmp-';
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Where a crash-boundary test may interrupt a publication. Production passes no hook. */
export type PublishStep = 'temporary-written' | 'temporary-synced' | 'linked' | 'temporary-removed';
export type PublishHook = (step: PublishStep) => void;

export class PublishUnsupportedError extends Error {
  constructor(directory: string, cause: unknown) {
    super(`The filesystem at ${directory} cannot publish runtime state without the risk of overwriting it (hard links unavailable).`, { cause });
    this.name = 'PublishUnsupportedError';
  }
}

export class AlreadyPublishedError extends Error {
  constructor(readonly path: string) {
    super(`${path} is already published and is never replaced.`);
    this.name = 'AlreadyPublishedError';
  }
}

function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

const UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/** Creates a room-owned runtime directory as 0700. Existing directories are tightened, never loosened. */
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stat = await lstat(path);
  if (!stat.isDirectory()) throw new Error(`${path} is not a directory.`);
  if ((stat.mode & 0o777) !== PRIVATE_DIR_MODE) await chmod(path, PRIVATE_DIR_MODE);
}

async function writeTemporary(directory: string, content: string | Uint8Array, hook?: PublishHook): Promise<string> {
  const temporary = join(directory, `${TEMPORARY_PREFIX}${String(process.pid)}-${randomBytes(8).toString('hex')}`);
  const handle = await open(temporary, 'wx', PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content);
    hook?.('temporary-written');
    await handle.sync();
    hook?.('temporary-synced');
  } finally {
    await handle.close();
  }
  return temporary;
}

async function syncDirectory(directory: string): Promise<void> {
  // Directory fsync makes the new name durable. Some platforms refuse it; the file itself is
  // already synced, so that refusal is tolerated rather than failing the publication.
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'EPERM', 'EBADF', 'ENOTSUP'].includes(code(error) ?? '')) throw error;
  } finally {
    await handle?.close();
  }
}

async function publishWith(
  directory: string,
  content: string | Uint8Array,
  allocate: (attempt: number) => string | undefined,
  hook?: PublishHook,
): Promise<string> {
  const temporary = await writeTemporary(directory, content, hook);
  let published: string | undefined;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const name = allocate(attempt);
      if (name === undefined) break;
      const target = join(directory, name);
      try {
        await link(temporary, target);
        published = target;
        break;
      } catch (error) {
        const reason = code(error);
        if (reason === 'EEXIST') continue;
        if (reason !== undefined && UNSUPPORTED.has(reason)) throw new PublishUnsupportedError(directory, error);
        throw error;
      }
    }
    if (published !== undefined) hook?.('linked');
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  if (published === undefined) return '';
  hook?.('temporary-removed');
  await syncDirectory(directory);
  return published;
}

/**
 * Publishes `content` under exactly `name`. An existing file is never replaced: the call throws
 * `AlreadyPublishedError` and leaves both the existing file and nothing else behind.
 */
export async function publishOnce(directory: string, name: string, content: string | Uint8Array, hook?: PublishHook): Promise<string> {
  const path = await publishWith(directory, content, attempt => (attempt === 0 ? name : undefined), hook);
  if (path === '') throw new AlreadyPublishedError(join(directory, name));
  return path;
}

/**
 * Publishes `content` under the first free name `allocate` offers. EEXIST moves to the next
 * attempt, so two concurrent writers both succeed under distinct names and neither overwrites.
 */
export async function publishAllocating(
  directory: string,
  content: string | Uint8Array,
  allocate: (attempt: number) => string,
  options: { readonly maxAttempts?: number; readonly hook?: PublishHook } = {},
): Promise<string> {
  const maxAttempts = options.maxAttempts ?? 64;
  const path = await publishWith(directory, content, attempt => (attempt < maxAttempts ? allocate(attempt) : undefined), options.hook);
  if (path === '') throw new Error(`Could not allocate a free name in ${directory} after ${String(maxAttempts)} attempts.`);
  return path;
}

/** Temporary files a crash left behind. They are never read as state; callers report them. */
export async function staleTemporaries(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter(name => name.startsWith(TEMPORARY_PREFIX)).sort();
}
