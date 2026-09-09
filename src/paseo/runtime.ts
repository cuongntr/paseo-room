import { lstat, realpath, readFile, readlink, readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { processRunner } from '../core/process.js';
import type { GuardedFileHasher, ReadonlyFileSystem } from '../core/seams.js';
import type { ProbeDependencies } from './cli-probe.js';
import { hashFileNoFollow } from '../core/guarded-hash.js';

export const paseoFilesystem: ReadonlyFileSystem & GuardedFileHasher = {
  async lstat(path) {
    try {
      const stat = await lstat(path);
      return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
        mode: stat.mode, device: stat.dev, inode: stat.ino, links: stat.nlink, uid: stat.uid };
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  }, realpath, readFile, readlink, readdir, hashFileNoFollow,
};
export function localProbeDependencies(): ProbeDependencies {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('Local Paseo admission requires macOS or Linux.');
  return {
    filesystem: paseoFilesystem, runner: processRunner, uid, hostname: hostname(),
    async processUid(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const result = await processRunner.run({ executable: '/bin/ps', args: ['-p', String(pid), '-o', 'uid='],
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, shell: false, timeoutMs: 2000 });
      const output = result.stdout.trim();
      return result.exitCode === 0 && /^\d+$/.test(output) ? Number(output) : null;
    },
  };
}
