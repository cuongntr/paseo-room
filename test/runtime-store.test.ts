import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_SCHEMA } from '../src/runtime-plugin/server/events/schema.js';
import { ProjectStore, runtimeRoot, type NewEvent } from '../src/runtime-plugin/server/store/project.js';

const roots: string[] = [];
async function room(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'paseo-room-store-'));
  roots.push(home);
  return runtimeRoot(home);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const binding = { canonicalRoot: '/work/My Repo', gitCommonDir: '/work/My Repo/.git' };
const held = (agentId: string): NewEvent => ({ type: 'ownership.held', payloadVersion: 1, actor: { source: 'plugin' }, data: { agentId } });

async function rawEvent(store: ProjectStore, sequence: number, overrides: Record<string, unknown> = {}): Promise<void> {
  const event = {
    schema: EVENT_SCHEMA, version: 1, type: 'ownership.held', payloadVersion: 1,
    id: `evt_raw${String(sequence).padStart(8, '0')}`, sequence, projectId: store.meta.projectId,
    actor: { source: 'plugin' }, occurredAt: '2026-09-22T10:00:00.000Z', data: { agentId: 'a' }, ...overrides,
  };
  await writeFile(join(store.eventsDirectory, `${String(sequence).padStart(12, '0')}.json`), JSON.stringify(event));
}

describe('runtime project store', () => {
  it('binds a project by Git common directory with private files and a first bound event', async () => {
    const root = await room();
    const store = await ProjectStore.create(root, binding);
    expect(store.directory).toMatch(/projects\/my-repo-[0-9a-f-]{36}$/);
    expect((await stat(store.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.directory, 'meta.json'))).mode & 0o777).toBe(0o600);
    const replay = await store.replay();
    expect(replay.status).toBe('ok');
    expect(replay.events.map(event => [event.sequence, event.type])).toEqual([[1, 'project.bound']]);

    expect((await ProjectStore.find(root, binding.gitCommonDir))?.meta.projectId).toBe(store.meta.projectId);
    expect(await ProjectStore.find(root, '/work/My Repo')).toBeUndefined();
    expect(await ProjectStore.find(root, '/elsewhere/.git')).toBeUndefined();
  });

  it('appends in sequence and two concurrent writers never overwrite each other', async () => {
    const root = await room();
    const first = await ProjectStore.create(root, binding);
    const second = await ProjectStore.open(first.directory);
    await Promise.all(Array.from({ length: 15 }, (_, index) => [
      first.append(held(`first-${String(index)}`)), second.append(held(`second-${String(index)}`)),
    ]).flat());
    const replay = await (await ProjectStore.open(first.directory)).replay();
    expect(replay.status).toBe('ok');
    expect(replay.events).toHaveLength(31);
    expect(replay.events.map(event => event.sequence)).toEqual(Array.from({ length: 31 }, (_, index) => index + 1));
    expect(new Set(replay.events.map(event => event.id)).size).toBe(31);
    expect(replay.gaps).toEqual([]);
  });

  it('pauses only the project whose ledger is unreadable, preserving the evidence', async () => {
    const root = await room();
    const broken = await ProjectStore.create(root, binding);
    const healthy = await ProjectStore.create(root, { canonicalRoot: '/work/other', gitCommonDir: '/work/other/.git' });
    await writeFile(join(broken.eventsDirectory, '000000000002.json'), '{ not json');

    const replay = await broken.replay();
    expect(replay.status).toBe('paused');
    expect(replay.problems).toEqual([expect.objectContaining({ file: '000000000002.json', reason: 'unreadable' })]);
    expect(await readdir(broken.eventsDirectory)).toContain('000000000002.json');
    expect((await healthy.replay()).status).toBe('ok');
  });

  it('refuses unknown types, unsupported versions, mismatched sequences, foreign and duplicate events', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'assignment.teleported' }, 'unknown-type'],
      [{ payloadVersion: 9 }, 'unsupported-version'],
      [{ data: {} }, 'invalid'],
      [{ sequence: 7 }, 'sequence-mismatch'],
      [{ projectId: '00000000-0000-4000-8000-000000000000' }, 'foreign-project'],
    ];
    for (const [overrides, reason] of cases) {
      const store = await ProjectStore.create(await room(), binding);
      await rawEvent(store, 2, overrides);
      const replay = await store.replay();
      expect(replay.status).toBe('paused');
      expect(replay.problems[0]?.reason).toBe(reason);
    }

    const store = await ProjectStore.create(await room(), binding);
    await rawEvent(store, 2);
    await rawEvent(store, 3);
    await writeFile(join(store.eventsDirectory, '000000000003.json'), JSON.stringify({
      ...JSON.parse(await readFile(join(store.eventsDirectory, '000000000002.json'), 'utf8')) as object, sequence: 3,
    }));
    expect((await store.replay()).problems[0]?.reason).toBe('duplicate-id');
  });

  it('reports sequence gaps and stale temporaries without pausing', async () => {
    const store = await ProjectStore.create(await room(), binding);
    await rawEvent(store, 4);
    await writeFile(join(store.eventsDirectory, '.tmp-1-deadbeef'), 'partial');
    const replay = await store.replay();
    expect(replay.status).toBe('ok');
    expect(replay.gaps).toEqual([2, 3]);
    expect(replay.staleTemporaries).toEqual(['.tmp-1-deadbeef']);
    expect((await store.append(held('next'))).sequence).toBe(5);
  });

  it('rebuilds a byte-equivalent cache after the cache is deleted', async () => {
    const store = await ProjectStore.create(await room(), binding);
    for (const agent of ['a', 'b', 'c']) await store.append(held(agent));
    const derive = async (): Promise<string> => JSON.stringify((await store.replay()).events.map(event => [event.sequence, event.type, event.data]));
    await store.writeCache('status.json', await derive());
    const before = await store.readCache('status.json');
    await store.clearCache();
    expect(await store.readCache('status.json')).toBeUndefined();
    await store.writeCache('status.json', await derive());
    expect(await store.readCache('status.json')).toBe(before);
  });

  it('quarantines only on an explicit call and only event files', async () => {
    const store = await ProjectStore.create(await room(), binding);
    await writeFile(join(store.eventsDirectory, '000000000002.json'), 'garbage');
    expect((await store.replay()).status).toBe('paused');
    await store.quarantine('000000000002.json');
    expect(await readdir(store.quarantineDirectory)).toEqual(['000000000002.json']);
    expect((await store.replay()).status).toBe('ok');
    await expect(store.quarantine('../meta.json')).rejects.toThrow();
  });

  it('replays 10,000 events cold within the performance target', async () => {
    const store = await ProjectStore.create(await room(), binding);
    const writes: Promise<void>[] = [];
    for (let sequence = 2; sequence <= 10_001; sequence += 1) writes.push(rawEvent(store, sequence));
    await Promise.all(writes);
    const started = performance.now();
    const replay = await (await ProjectStore.open(store.directory)).replay();
    const elapsed = performance.now() - started;
    expect(replay.status).toBe('ok');
    expect(replay.events).toHaveLength(10_001);
    expect(elapsed).toBeLessThan(5_000);
  }, 60_000);
});
