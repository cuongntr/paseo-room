import { join } from 'node:path';
import { constants } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { FileMetadata } from '../src/core/seams.js';
import { hashAnchoredFile, createGuardedFileHash } from '../src/core/guarded-hash.js';
import { sha256 } from '../src/core/hash.js';

const expected: FileMetadata = { kind: 'file', mode: 0o100600, uid: 501, device: 1, inode: 10, links: 1 };
const parent: FileMetadata = { ...expected, kind: 'directory', mode: 0o40700, inode: 9, links: 2 };
function fixture(actual: FileMetadata = expected) {
  const handle = { stat: vi.fn(() => Promise.resolve(actual)), hash: vi.fn(() => Promise.resolve(sha256('authored'))), close: vi.fn(() => Promise.resolve()) };
  const open = vi.fn(() => Promise.resolve(handle));
  const statCwd = vi.fn(() => Promise.resolve(parent));
  return { handle, open, statCwd, read: (name: string, expected: FileMetadata, forbidden: readonly FileMetadata[]) => hashAnchoredFile({ name, parent, expected, forbidden }, { statCwd, open, flags: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK }) };
}
describe('guarded descriptor read', () => {
  it('opens read-only/no-follow, fstats before bytes, and closes the same descriptor', async () => {
    const f = fixture();
    expect(await f.read('owned', expected, [])).toBe(sha256('authored'));
    expect(f.open).toHaveBeenCalledExactlyOnceWith('owned', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(f.handle.stat.mock.invocationCallOrder[0]).toBeLessThan(f.handle.hash.mock.invocationCallOrder[0] ?? 0);
    expect(f.handle.hash.mock.invocationCallOrder[0]).toBeLessThan(f.handle.close.mock.invocationCallOrder[0] ?? 0);
    expect(f.handle.close).toHaveBeenCalledTimes(1);
  });
  it.each<Partial<FileMetadata>>([
    { kind: 'symlink' }, { kind: 'directory' }, { kind: 'other' }, { device: 2 }, { inode: 11 },
    { uid: 502 }, { mode: 0o100644 }, { mode: 0o104600 }, { mode: 0o600 }, { links: 0 }, { links: 2 },
  ])('rejects opened metadata mismatch before reading %#', async change => {
    const f = fixture({ ...expected, ...change });
    await expect(f.read('owned', expected, [])).rejects.toThrow('Unsafe hash');
    expect(f.handle.hash).not.toHaveBeenCalled(); expect(f.handle.close).toHaveBeenCalledTimes(1);
  });
  it('rejects forbidden credential identity even when expected metadata matches', async () => {
    const f = fixture();
    await expect(f.read('owned', expected, [expected])).rejects.toThrow('Unsafe hash');
    expect(f.handle.hash).not.toHaveBeenCalled(); expect(f.handle.close).toHaveBeenCalledTimes(1);
  });
  it.each(['open', 'stat', 'hash', 'close'] as const)('fails closed on %s errors with descriptor cleanup', async boundary => {
    const f = fixture(); const error = new Error('injected IO failure');
    if (boundary === 'open') f.open.mockRejectedValue(error);
    else f.handle[boundary].mockRejectedValue(error);
    await expect(f.read('owned', expected, [])).rejects.toThrow(error);
    expect(f.handle.close).toHaveBeenCalledTimes(boundary === 'open' ? 0 : 1);
    if (boundary !== 'hash' && boundary !== 'close') expect(f.handle.hash).not.toHaveBeenCalled();
  });
});

describe('cwd and child output boundary', () => {
  it.each<Partial<FileMetadata>>([{ kind: 'symlink' }, { device: 2 }, { inode: 12 }, { uid: 502 }, { mode: 0o40755 }, { links: 3 }])('rejects changed cwd before opening anything %#', async change => {
    const f = fixture(); f.statCwd.mockResolvedValue({ ...parent, ...change });
    await expect(f.read('owned', expected, [])).rejects.toThrow('Unsafe hash');
    expect(f.open).not.toHaveBeenCalled(); expect(f.handle.hash).not.toHaveBeenCalled();
  });
  it.each(['', '.', '..', 'a/b', 'a\\b', 'a\n', 'a\0'])('rejects non-component names %#', async name => {
    const f = fixture(); await expect(f.read(name, expected, [])).rejects.toThrow(); expect(f.open).not.toHaveBeenCalled();
  });
  it('validates cwd before leaf open', async () => {
    const f = fixture(); await f.read('owned', expected, []);
    expect(f.statCwd.mock.invocationCallOrder[0]).toBeLessThan(f.open.mock.invocationCallOrder[0] ?? 0);
  });
  it.each(['bad', 'A'.repeat(64), '0'.repeat(64) + '\n', '0'.repeat(65)])('rejects malformed output %#', async stdout => {
    const hash = createGuardedFileHash(() => Promise.resolve({ stdout, stderr: '', exitCode: 0 }));
    await expect(hash('/owned/file', parent, expected, [])).rejects.toThrow('Unsafe hash');
  });
  it.each(['timeout', 'nonzero', 'stderr'])('sanitizes %s failures', async failure => {
    const hash = createGuardedFileHash(() => {
      if (failure === 'timeout') return Promise.reject(new Error('credential sentinel'));
      return Promise.resolve({ stdout: sha256('authored'), stderr: failure === 'stderr' ? 'credential sentinel' : '', exitCode: failure === 'nonzero' ? 1 : 0 });
    });
    await expect(hash('/owned/file', parent, expected, [])).rejects.toThrow(/^Unsafe hash$/);
  });
  it('uses absolute Node, empty env, no shell and bounded output/time', async () => {
    const run = vi.fn(() => Promise.resolve({ stdout: sha256('authored'), stderr: '', exitCode: 0 }));
    await createGuardedFileHash(run)('/owned/file', parent, expected, []);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath, cwd: '/owned', env: {}, shell: false, timeout: 5000, maxBuffer: 1024 }));
  });
});

it('keeps the original cwd after a live parent rename (macOS/Linux)', async () => {
  const fs = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { paseoFilesystem } = await import('../src/paseo/runtime.js');
  const { runHashChild } = await import('../src/core/guarded-hash.js');
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'anchored-hash-')));
  try {
    const owned = join(root, 'owned'); const outside = join(root, 'outside');
    await fs.mkdir(owned, { mode: 0o700 }); await fs.mkdir(outside, { mode: 0o700 });
    await fs.writeFile(join(owned, 'file'), 'authored', { mode: 0o600 });
    await fs.writeFile(join(outside, 'file'), 'disposable credential sentinel', { mode: 0o600 });
    const parentMetadata = await paseoFilesystem.lstat(owned);
    const leafMetadata = await paseoFilesystem.lstat(join(owned, 'file'));
    if (!parentMetadata || !leafMetadata) throw new Error('fixture missing');
    const marker = join(root, 'anchored'); const release = join(root, 'release');
    const hash = createGuardedFileHash(async input => {
      // Synchronize immediately after the real child stat('.') and before leaf open.
      const args = [...input.args]; const script = args[2];
      if (!script) throw new Error('missing script');
      const call = script.lastIndexOf('(fs, constants, createHash)');
      args[2] = script.slice(0, call) + `({ ...fs, async stat(path) {
        const result = await fs.stat(path);
        await fs.writeFile(${JSON.stringify(marker)}, 'ready');
        for (;;) { try { await fs.stat(${JSON.stringify(release)}); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
        return result;
      } }, constants, createHash)` + script.slice(call + '(fs, constants, createHash)'.length);
      const pending = runHashChild({ ...input, args });
      // Attach immediately so a child startup failure cannot become unhandled.
      const completion = pending.then(value => ({ value }), () => ({ value: null }));
      const deadline = Date.now() + 3000;
      while (!(await paseoFilesystem.lstat(marker))) {
        if (Date.now() > deadline) throw new Error('synchronization timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      await fs.rename(owned, owned + '-old'); await fs.symlink(outside, owned);
      await fs.writeFile(release, 'continue');
      const result = await completion;
      if (!result.value) throw new Error('child failed');
      return result.value;
    });
    expect(await hash(join(owned, 'file'), parentMetadata, leafMetadata, [])).toBe(sha256('authored'));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['timeout', 'nonzero', 'overflow'] as const)('bounds a real child %s and sanitizes diagnostics', async failure => {
  const { runHashChild } = await import('../src/core/guarded-hash.js');
  const hash = createGuardedFileHash(input => runHashChild({ ...input, cwd: '/', timeout: 100,
    args: ['--eval', failure === 'timeout' ? 'setInterval(() => {}, 1000)' : failure === 'overflow' ? 'process.stdout.write("x".repeat(2048))' : 'throw new Error("synthetic sentinel")'] }));
  await expect(hash('/owned/file', parent, expected, [])).rejects.toThrow(/^Unsafe hash$/);
});

it('rejects an outside leaf accepted by raced lstat before opening or hashing it', async () => {
  const outsideLeaf = { ...expected, inode: 123 };
  const f = fixture(outsideLeaf);
  // Parent lstat accepted `parent`; replacement preceded leaf lstat, so even
  // expected leaf metadata now agrees with the credential. Only cwd detects it.
  f.statCwd.mockResolvedValue({ ...parent, inode: 456 });
  await expect(f.read('owned', outsideLeaf, [])).rejects.toThrow('Unsafe hash');
  expect(f.open).not.toHaveBeenCalled(); expect(f.handle.hash).not.toHaveBeenCalled();
});
