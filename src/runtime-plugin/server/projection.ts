/**
 * The projection a plugin process keeps of each project (docs/design/runtime-coordination.md §4.2).
 *
 * An event file is published once and never rewritten, so the fold of the events already seen is
 * kept and a load folds only the events published since. Folding a whole ledger again cost every
 * operation 130 ms on cmdb's 7,700 events, nearly all of it re-checking worktree lease collisions,
 * and a turn end runs several loads (2026-10-02). Each caller receives its own copy of the
 * projection, which it may extend with the events it appends. The fold is kept only while the
 * replay begins with exactly the events it consumed — the store hands back the same object for a
 * file it already read — so a file quarantined, replaced, or published late below them makes the
 * ledger fold again from the start. Loads of one project take turns, so no event is folded twice.
 */
import { cloneState, emptyProjectState, foldInto, project, type ProjectState, type Violation } from './domain/state.js';
import type { RuntimeEventV1 } from './events/schema.js';
import type { ProjectStore, ReplayResult } from './store/project.js';

export interface ProjectSnapshot {
  readonly replay: ReplayResult;
  /** The caller's own copy: what it folds into it reaches no other caller. */
  readonly state: ProjectState;
  readonly violations: readonly Violation[];
}

interface Folded {
  readonly state: ProjectState;
  /** The replayed events consumed so far, in order. */
  readonly events: RuntimeEventV1[];
  /** The first illegal transition; nothing after it is folded. */
  violation: Violation | undefined;
}

const FOLDS = new Map<string, Folded>();
const TURNS = new Map<string, Promise<unknown>>();

/** Replays a project and returns its projection, folding only what is new since the last load. */
export async function snapshot(store: ProjectStore): Promise<ProjectSnapshot> {
  const key = store.eventsDirectory;
  const previous = TURNS.get(key) ?? Promise.resolve();
  const next = previous.then(() => take(store, key), () => take(store, key));
  TURNS.set(key, next.catch(() => undefined));
  return await next;
}

/** Whether `events` begins with exactly the events `folded` consumed, object for object. */
function beginsWith(events: readonly RuntimeEventV1[], folded: Folded): boolean {
  if (events.length < folded.events.length) return false;
  for (let index = 0; index < folded.events.length; index += 1) if (events[index] !== folded.events[index]) return false;
  return true;
}

async function take(store: ProjectStore, key: string): Promise<ProjectSnapshot> {
  const replay = await store.replay();
  // A paused ledger is never folded onto what was kept; what can be read is projected as it is.
  if (replay.status !== 'ok') {
    const projection = project(store.meta.projectId, replay.events);
    return { replay, state: projection.state, violations: projection.violations };
  }
  let folded = FOLDS.get(key);
  if (folded === undefined || !beginsWith(replay.events, folded)) {
    folded = { state: emptyProjectState(store.meta.projectId), events: [], violation: undefined };
    FOLDS.set(key, folded);
  }
  const from = folded.events.length;
  folded.violation ??= foldInto(folded.state, replay.events, from);
  for (let index = from; index < replay.events.length; index += 1) {
    const event = replay.events[index];
    if (event !== undefined) folded.events.push(event);
  }
  return { replay, state: cloneState(folded.state), violations: folded.violation === undefined ? [] : [folded.violation] };
}
