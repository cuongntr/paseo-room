import { execFile } from 'node:child_process';
import { basename, dirname, isAbsolute } from 'node:path';
import type { FileMetadata, GuardedFileHasher } from './seams.js';

export interface HashRequest {
  readonly name: string;
  readonly parent: FileMetadata;
  readonly expected: FileMetadata;
  readonly forbidden: readonly Pick<FileMetadata, 'device' | 'inode'>[];
}
export interface HashHandle {
  stat(): Promise<FileMetadata>;
  hash(): Promise<string>;
  close(): Promise<void>;
}
export interface AnchoredHashIO {
  readonly flags: number;
  statCwd(): Promise<FileMetadata>;
  open(name: string, flags: number): Promise<HashHandle>;
}

/** Self-contained child entrypoint, serialized without imports from the package.
 * cwd is an OS-held directory reference: never resolve the original parent again.
 * The injected IO seam tests the very same ordering used in the child. */
function childIO(fs: typeof import('node:fs/promises'), constants: typeof import('node:fs').constants,
  createHash: typeof import('node:crypto').createHash): AnchoredHashIO {
  const metadata = (stat: import('node:fs').Stats): FileMetadata => ({
    kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other',
    mode: stat.mode, device: stat.dev, inode: stat.ino, links: stat.nlink, uid: stat.uid,
  });
  return {
    // NONBLOCK prevents a raced FIFO from hanging before fstat rejection.
    flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    async statCwd() { return metadata(await fs.stat('.')); },
    async open(name, flags) {
      const handle = await fs.open(name, flags);
      return {
        async stat() { return metadata(await handle.stat()); },
        async hash() {
          const hash = createHash('sha256');
          const buffer = Buffer.alloc(64 * 1024);
          for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
          }
          return hash.digest('hex');
        },
        async close() { await handle.close(); },
      };
    },
  };
}

export async function hashAnchoredFile(input: HashRequest, io: AnchoredHashIO): Promise<string> {
  const matches = (actual: FileMetadata, expected: FileMetadata): boolean =>
    (['kind', 'device', 'inode', 'uid', 'mode', 'links'] as const).every(key => actual[key] === expected[key]);
  const parent = await io.statCwd(); // MUST precede even the relative leaf open.
  if (parent.kind !== 'directory' || !matches(parent, input.parent)) throw new Error('Unsafe hash');
  if (!input.name || input.name === '.' || input.name === '..') throw new Error('Unsafe hash');
  for (const char of input.name) {
    if (char === '/' || char === '\\' || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) throw new Error('Unsafe hash');
  }
  const handle = await io.open(input.name, io.flags);
  try {
    const actual = await handle.stat();
    if (actual.kind !== 'file' || actual.links !== 1 || (actual.mode & 0o7777) !== 0o600 ||
        !matches(actual, input.expected) || input.forbidden.some(id => id.device === actual.device && id.inode === actual.inode)) {
      throw new Error('Unsafe hash');
    }
    return await handle.hash();
  } finally { await handle.close(); }
}

export interface HashChildInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly timeout: number;
  readonly maxBuffer: number;
}
export type HashChildRunner = (input: HashChildInput) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
export const runHashChild: HashChildRunner = input => new Promise((resolve, reject) => {
  execFile(input.executable, [...input.args], { cwd: input.cwd, env: input.env, shell: input.shell,
    timeout: input.timeout, maxBuffer: input.maxBuffer, encoding: 'utf8', killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
    if (error) reject(new Error('Unsafe hash'));
    else resolve({ stdout, stderr, exitCode: 0 });
  });
});
export function createGuardedFileHash(run: HashChildRunner = runHashChild): GuardedFileHasher['hashFileNoFollow'] {
  return async (path, parent, expected, forbidden) => {
    try {
      if (!isAbsolute(path) || !isAbsolute(process.execPath) || !['darwin', 'linux'].includes(process.platform)) throw new Error();
      const request: HashRequest = { name: basename(path), parent, expected, forbidden };
      const script = `import * as fs from 'node:fs/promises'; import { constants } from 'node:fs'; import { createHash } from 'node:crypto'; try { (${hashAnchoredFile.toString()})(JSON.parse(process.argv[1]), (${childIO.toString()})(fs, constants, createHash)).then(digest => process.stdout.write(digest)).catch(() => { process.exitCode = 1; }); } catch { process.exitCode = 1; }`;
      const result = await run({ executable: process.execPath, args: ['--input-type=module', '--eval', script, JSON.stringify(request)],
        cwd: dirname(path), env: {}, shell: false, timeout: 5000, maxBuffer: 1024 });
      if (result.exitCode !== 0 || result.stderr !== '' || !/^[a-f0-9]{64}$/.test(result.stdout)) throw new Error();
      return result.stdout;
    } catch { throw new Error('Unsafe hash'); } // Never expose child diagnostics, arguments, or bytes.
  };
}
export const hashFileNoFollow = createGuardedFileHash();
