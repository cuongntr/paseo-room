import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A filesystem without hard links: `link()` fails the way FAT/exFAT and some network mounts do.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: () => Promise.reject(Object.assign(new Error('operation not permitted'), { code: 'EPERM' })),
  };
});

const { PublishUnsupportedError, ensurePrivateDirectory, publishOnce } = await import('../src/runtime-plugin/server/store/publish.js');

const root = await mkdtemp(join(tmpdir(), 'paseo-room-publish-unsupported-'));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('publication without hard links', () => {
  it('fails closed instead of falling back to a replacing rename', async () => {
    const dir = join(root, 'events');
    await ensurePrivateDirectory(dir);
    await expect(publishOnce(dir, 'event.json', 'x')).rejects.toBeInstanceOf(PublishUnsupportedError);
    expect(await readdir(dir)).toEqual([]);
  });
});
