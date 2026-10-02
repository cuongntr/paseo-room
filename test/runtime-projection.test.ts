import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { project } from '../src/runtime-plugin/server/domain/state.js';
import { snapshot } from '../src/runtime-plugin/server/projection.js';
import type { ProjectStore } from '../src/runtime-plugin/server/store/project.js';
import { harness, readOnlyBrief, writableBrief, type Harness } from './runtime-harness.js';

const open: Harness[] = [];
afterEach(async () => { await Promise.all(open.splice(0).map(h => h.cleanup())); });

async function room(): Promise<{ h: Harness; store: ProjectStore }> {
  const h = await harness();
  open.push(h);
  return { h, store: await h.controller.projectFor(h.repo) };
}

/** The projection a full fold of the ledger gives, which an incremental one must equal. */
async function full(store: ProjectStore): Promise<ReturnType<typeof project>> {
  return project(store.meta.projectId, (await store.replay()).events);
}

async function create(h: Harness, brief: Record<string, unknown>): Promise<string> {
  const created = await h.controller.createAssignment(h.lead, brief);
  if (!created.ok) throw new Error(created.message);
  return created.value.assignmentId;
}

describe('runtime projection', () => {
  it('folds only what is new and always equals a full fold', async () => {
    const { h, store } = await room();
    for (const step of [
      () => create(h, writableBrief(h.base)),
      () => create(h, readOnlyBrief(h.base)),
      async () => { const id = await create(h, writableBrief(h.base)); await h.controller.dispatch(h.lead, { assignmentId: id, peerProvider: 'codex-peer' }); },
    ]) {
      await step();
      const kept = await snapshot(store);
      expect(kept.state).toEqual((await full(store)).state);
      expect(kept.violations).toEqual([]);
    }
  });

  it('gives each load its own copy, which its appends never reach another', async () => {
    const { h, store } = await room();
    await create(h, writableBrief(h.base));
    const first = await h.controller.load(store);
    if (!first.ok) throw new Error(first.message);
    first.value.state.assignments.clear();
    const id = await create(h, readOnlyBrief(h.base));
    const second = await h.controller.load(store);
    if (!second.ok) throw new Error(second.message);
    expect(second.value.state.assignments.size).toBe(2);
    expect(second.value.state.assignments.has(id)).toBe(true);
    expect(second.value.state).toEqual((await full(store)).state);
  });

  it('agrees across concurrent loads, folding each event once', async () => {
    const { h, store } = await room();
    await create(h, writableBrief(h.base));
    await snapshot(store);
    await create(h, readOnlyBrief(h.base));
    await create(h, readOnlyBrief(h.base));
    const loads = await Promise.all(Array.from({ length: 10 }, () => snapshot(store)));
    const expected = (await full(store)).state;
    for (const load of loads) expect(load.state).toEqual(expected);
  });

  it('folds again from the start when a file leaves or returns below what was folded', async () => {
    const { h, store } = await room();
    await create(h, writableBrief(h.base));
    const middle = await create(h, readOnlyBrief(h.base));
    await create(h, readOnlyBrief(h.base));
    expect((await snapshot(store)).state.assignments.has(middle)).toBe(true);
    const file = (await store.replay()).events.find(event => event.type === 'assignment.created' && event.assignmentId === middle);
    const name = `${String(file?.sequence).padStart(12, '0')}.json`;

    await store.quarantine(name);
    const without = await snapshot(store);
    expect(without.state.assignments.has(middle)).toBe(false);
    expect(without.state).toEqual((await full(store)).state);

    await rename(join(store.quarantineDirectory, name), join(store.eventsDirectory, name));
    const restored = await snapshot(store);
    expect(restored.state.assignments.has(middle)).toBe(true);
    expect(restored.state).toEqual((await full(store)).state);
  });

  it('folds again when a file in the middle is replaced while the length stays the same', async () => {
    const { h, store } = await room();
    await create(h, writableBrief(h.base));
    const middle = await create(h, readOnlyBrief(h.base));
    await create(h, readOnlyBrief(h.base));
    await snapshot(store);
    const event = (await store.replay()).events.find(entry => entry.type === 'assignment.created' && entry.assignmentId === middle);
    const name = `${String(event?.sequence).padStart(12, '0')}.json`;
    const original = JSON.parse(await readFile(join(store.eventsDirectory, name), 'utf8')) as { data: { input: { outcome: string } } };

    await store.quarantine(name);
    await store.replay();
    original.data.input.outcome = 'Restored with another outcome';
    await writeFile(join(store.eventsDirectory, name), JSON.stringify(original));
    const after = await snapshot(store);
    expect(after.state.assignments.get(middle)?.input.outcome).toBe('Restored with another outcome');
    expect(after.state).toEqual((await full(store)).state);
  });

  it('never extends a fold made from an older listing past a file that has since left', async () => {
    const { h, store } = await room();
    await create(h, writableBrief(h.base));
    const gone = await create(h, readOnlyBrief(h.base));
    const stale = await store.replay();
    const event = stale.events.find(entry => entry.type === 'assignment.created' && entry.assignmentId === gone);
    await store.quarantine(`${String(event?.sequence).padStart(12, '0')}.json`);
    await store.replay();
    // A load whose listing was taken before the quarantine finishes after it.
    const replay = store.replay.bind(store);
    store.replay = () => { store.replay = replay; return Promise.resolve(stale); };
    expect((await snapshot(store)).state.assignments.has(gone)).toBe(true);
    await create(h, readOnlyBrief(h.base));
    const after = await snapshot(store);
    expect(after.state.assignments.has(gone)).toBe(false);
    expect(after.state).toEqual((await full(store)).state);
  });
});
