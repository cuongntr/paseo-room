import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry } from '../fsops.js';
import type { Role } from '../roles.js';

/** The one operator resource Peer receives as an exact projection rather than an alias. */
export const SKILLS = 'skills';

/** A room-owned orchestration skill: advertised to seats that orchestrate, never to Peer. */
function isPaseoSkill(name: string): boolean {
  return name.toLowerCase().startsWith('paseo');
}

/**
 * Peer has no room tools, so the room also stops loading orchestration surfaces into it.
 * This closes known configuration paths — Peer still has a shell, so it is not containment.
 */
function receivesExecutableResources(role: Role): boolean {
  return role !== 'peer';
}

/** Names under the operator skills directory; a missing directory is an empty projection. */
async function skillNames(path: string, reserved: ReadonlySet<string>): Promise<string[]> {
  try {
    return (await readdir(path)).filter(name => !isPaseoSkill(name) && !reserved.has(name)).sort();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export interface RoleResourceInput {
  readonly role: Role;
  /** The role home every generated alias is created inside. */
  readonly target: string;
  /** The operator agent home the shared resources are read from. */
  readonly home: string;
  /** Shared resource basenames in the adapter's declared order, present or not. */
  readonly names: readonly string[];
  /** Absolute operator paths that exist, probed once for every role. */
  readonly shared: readonly string[];
  /** Basenames whose contents can run code, withheld from Peer. */
  readonly executable: readonly string[];
  /**
   * Names inside the projected `skills` directory that the agent's own runtime writes and
   * owns. They are neither linked nor reconciled: the agent creates its own copy inside the
   * role home, so projecting one would alias runtime state and reconciling one would delete it.
   */
  readonly reservedSkills?: readonly string[];
}

/**
 * Supervisor and Lead keep one alias per shared operator resource that exists, so they never
 * gain a broken link. Peer receives no executable resource, and its `skills` becomes an exact
 * managed directory of links to the non-`paseo*` operator skills, so an inventory change
 * cannot leave it silently stale.
 *
 * Peer's projection is declared even when the operator deleted the whole skills directory:
 * an empty managed directory is what lets a later run remove yesterday's child links, or
 * migrate the legacy whole-directory symlink, instead of leaving them unreconciled.
 *
 * A name the agent's own runtime owns inside that directory is reserved rather than projected:
 * the room neither aliases it nor counts it stale, so the agent's state survives a run.
 */
export async function roleResourceEntries(input: RoleResourceInput): Promise<Entry[]> {
  const present = new Set(input.shared);
  const executable = new Set(input.executable);
  const reserved = new Set(input.reservedSkills ?? []);
  const entries: Entry[] = [];
  for (const name of input.names) {
    const path = join(input.home, name);
    const alias = join(input.target, name);
    if (!receivesExecutableResources(input.role)) {
      if (executable.has(name)) continue;
      if (name === SKILLS) {
        const children = present.has(path) ? await skillNames(path, reserved) : [];
        entries.push({
          kind: 'managed-dir', path: alias, children, legacyLink: path,
          ...(reserved.size === 0 ? {} : { reserved: [...reserved] }),
        });
        for (const child of children) entries.push({ kind: 'link', path: join(alias, child), target: join(path, child) });
        continue;
      }
    }
    if (!present.has(path)) continue;
    entries.push({ kind: 'link', path: alias, target: path });
  }
  return entries;
}
