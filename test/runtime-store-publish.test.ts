import { mkdtemp, readdir, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AlreadyPublishedError, ensurePrivateDirectory, publishAllocating, publishOnce, staleTemporaries,
  type PublishStep,
} from '../src/runtime-plugin/server/store/publish.js';

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'paseo-room-publish-'));
  roots.push(root);
  const path = join(root, 'events');
  await ensurePrivateDirectory(path);
  return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const crash = (at: PublishStep) => (step: PublishStep): void => { if (step === at) throw new Error(`crash at ${step}`); };

describe('no-clobber runtime publication', () => {
  it('publishes whole files as 0600 inside a 0700 directory', async () => {
    const dir = await directory();
    const path = await publishOnce(dir, '000000000001.json', '{"a":1}\n');
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await staleTemporaries(dir)).toEqual([]);
  });

  it('never replaces a published name', async () => {
    const dir = await directory();
    await publishOnce(dir, 'meta.json', 'first');
    await expect(publishOnce(dir, 'meta.json', 'second')).rejects.toBeInstanceOf(AlreadyPublishedError);
    expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe('first');
    expect(await readdir(dir)).toEqual(['meta.json']);
  });

  it('reallocates on EEXIST so concurrent writers both land and neither overwrites', async () => {
    const dir = await directory();
    const name = (attempt: number): string => `${String(attempt + 1).padStart(12, '0')}.json`;
    const paths = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      publishAllocating(dir, `writer-${String(index)}`, name)));
    expect(new Set(paths).size).toBe(20);
    const contents = await Promise.all((await readdir(dir)).map(file => readFile(join(dir, file), 'utf8')));
    expect(contents.sort()).toEqual(Array.from({ length: 20 }, (_, index) => `writer-${String(index)}`).sort());
  });

  it('fails when no free name remains rather than replacing one', async () => {
    const dir = await directory();
    await publishOnce(dir, 'only.json', 'kept');
    await expect(publishAllocating(dir, 'new', () => 'only.json', { maxAttempts: 3 })).rejects.toThrow('Could not allocate');
    expect(await readFile(join(dir, 'only.json'), 'utf8')).toBe('kept');
    expect(await staleTemporaries(dir)).toEqual([]);
  });

  it('leaves either nothing or one complete file when interrupted at any step', async () => {
    for (const step of ['temporary-written', 'temporary-synced', 'linked', 'temporary-removed'] as const) {
      const dir = await directory();
      await expect(publishOnce(dir, 'event.json', 'complete', crash(step))).rejects.toThrow(`crash at ${step}`);
      const names = (await readdir(dir)).filter(name => !name.startsWith('.tmp-'));
      if (step === 'temporary-written' || step === 'temporary-synced') {
        expect(names).toEqual([]);
        // The interrupted temporary is visible to diagnostics and is never read as state.
        expect(await staleTemporaries(dir)).toHaveLength(1);
      } else {
        expect(names).toEqual(['event.json']);
        expect(await readFile(join(dir, 'event.json'), 'utf8')).toBe('complete');
      }
    }
  });

  it('tightens an existing runtime directory to 0700 and refuses a non-directory', async () => {
    const dir = await directory();
    await chmod(dir, 0o755);
    await ensurePrivateDirectory(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const file = join(dir, 'file');
    await writeFile(file, 'x');
    await expect(ensurePrivateDirectory(file)).rejects.toThrow();
  });
});
