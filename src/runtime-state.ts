import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { project } from './runtime-plugin/server/domain/state.js';
import { quiescence, worktreesOnDisk, type QuiescenceBlocker } from './runtime-plugin/server/domain/views.js';
import { ProjectStore, runtimeRoot } from './runtime-plugin/server/store/project.js';

/**
 * A read-only look at the runtime state a room recorded, using the plugin's own replay and
 * projection. The CLI never writes, repairs or quarantines anything under `runtime/`.
 */
export interface RuntimeStateSummary {
  readonly root: string;
  readonly projects: number;
  /** Everything still active or uncertain; a paused ledger counts, since it cannot be proven quiet. */
  readonly blockers: readonly (QuiescenceBlocker & { readonly project: string })[];
  /** Runtime worktrees Paseo still lists, awaiting a close. They are Paseo's; the CLI never closes them. */
  readonly retainedWorktrees: number;
  /** Directories Paseo archived but left behind. The CLI never deletes them either. */
  readonly leftoverDirectories: number;
}

export async function inspectRuntimeState(roomHome: string): Promise<RuntimeStateSummary> {
  const root = runtimeRoot(roomHome);
  const names = await readdir(join(root, 'projects')).catch(() => [] as string[]);
  const blockers: (QuiescenceBlocker & { project: string })[] = [];
  const stores: ProjectStore[] = [];
  let retained = 0;
  let leftover = 0;
  for (const name of names.sort()) {
    try {
      stores.push(await ProjectStore.open(join(root, 'projects', name)));
    } catch {
      // Unreadable metadata is unknown state, never an empty project.
      blockers.push({ project: name, kind: 'assignment', id: name, detail: 'has unreadable project metadata' });
    }
  }
  for (const store of stores) {
    const replay = await store.replay();
    const projection = project(store.meta.projectId, replay.events);
    if (replay.status !== 'ok' || projection.violations.length > 0) {
      blockers.push({ project: store.meta.canonicalRoot, kind: 'assignment', id: store.meta.projectId, detail: 'the project ledger is paused and cannot be proven quiet' });
      continue;
    }
    for (const blocker of quiescence(projection.state).blockers) blockers.push({ ...blocker, project: store.meta.canonicalRoot });
    const onDisk = worktreesOnDisk(projection.state, existsSync);
    retained += onDisk.retained;
    leftover += onDisk.leftover;
  }
  return { root, projects: names.length, blockers, retainedWorktrees: retained, leftoverDirectories: leftover };
}

export function describeBlockers(summary: RuntimeStateSummary, limit = 5): string {
  const shown = summary.blockers.slice(0, limit).map(blocker => `${blocker.project}: ${blocker.kind} ${blocker.id} ${blocker.detail}`);
  const more = summary.blockers.length > limit ? `; and ${String(summary.blockers.length - limit)} more` : '';
  return `${shown.join('; ')}${more}`;
}
