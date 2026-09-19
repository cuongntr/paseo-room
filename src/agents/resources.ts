import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Entry } from '../fsops.js';
import type { Role } from '../roles.js';

/** The one operator resource the room projects child by child rather than aliasing. */
export const SKILLS = 'skills';

/** An orchestration skill: advertised to seats that orchestrate, never to Peer. */
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

/**
 * The room-owned skill reaches the one seat that owns a repository's workflow policy. Peer
 * reads one brief, and Supervisor holds no standing protocol mandate, so neither receives it.
 */
function receivesRoomSkill(role: Role): boolean {
  return role === 'lead';
}

/** Names under the operator skills directory; a missing directory is an empty projection. */
async function skillNames(
  path: string,
  reserved: ReadonlySet<string>,
  keep: (name: string) => boolean,
): Promise<string[]> {
  try {
    return (await readdir(path)).filter(name => keep(name) && !reserved.has(name)).sort();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}

export interface RoomSkill {
  /** The child name inside the projected `skills` directory. */
  readonly name: string;
  /** The shared room-owned source each Lead aggregate links to; declared once. */
  readonly source: string;
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
  /** The room-owned skill, passed by every adapter; only the seats that need it receive it. */
  readonly roomSkill?: RoomSkill;
  /** Room-owned aggregate for Lead; the role-home `skills` path remains a replaceable symlink. */
  readonly leadSkillProjection?: string;
}

/**
 * The projected `skills` directory for a role the room owns by exact child inventory, or
 * `undefined` for a role that keeps the whole-directory alias.
 *
 * Peer receives the non-`paseo*` operator skills and no room-owned skill. Lead receives every
 * operator skill plus the room-owned one; the single name that collides with it exactly is not
 * linked, because the room-owned copy owns that name inside the Lead aggregate while the
 * operator's own skill stays where it is, untouched.
 *
 * The projection is declared even when the operator deleted the whole skills directory: an
 * empty managed directory is what lets a later run remove yesterday's child links. Peer's
 * role-home directory also migrates the legacy whole-directory symlink. Lead instead keeps a
 * symlink at that legacy path and projects children into a room-owned aggregate, so an older
 * package can replace the same symlink shape during rollback.
 */
async function skillsProjection(
  input: RoleResourceInput,
  path: string,
  alias: string,
  present: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): Promise<Entry[] | undefined> {
  const roomSkill = receivesRoomSkill(input.role) ? input.roomSkill : undefined;
  const projectsChildren = !receivesExecutableResources(input.role) || roomSkill !== undefined;
  if (!projectsChildren) return undefined;
  const keep = roomSkill === undefined
    ? (name: string): boolean => !isPaseoSkill(name)
    : (name: string): boolean => name !== roomSkill.name;
  const operator = present.has(path) ? await skillNames(path, reserved, keep) : [];
  const children = roomSkill === undefined ? operator : [...operator, roomSkill.name];
  const projection = input.role === 'lead' ? input.leadSkillProjection : alias;
  if (projection === undefined) throw new Error('Lead skills require a room-owned projection path.');
  return [
    {
      kind: 'managed-dir', path: projection, children,
      ...(input.role === 'peer' ? { legacyLink: path } : {}),
      ...(reserved.size === 0 ? {} : { reserved: [...reserved] }),
    },
    ...operator.map(child => ({ kind: 'link' as const, path: join(projection, child), target: join(path, child) })),
    ...(roomSkill === undefined
      ? []
      : [{ kind: 'link' as const, path: join(projection, roomSkill.name), target: roomSkill.source }]),
    ...(input.role === 'lead' ? [{ kind: 'link' as const, path: alias, target: projection }] : []),
  ];
}

/**
 * Supervisor keeps one alias per shared operator resource that exists, so it never gains a
 * broken link. Lead keeps those aliases too, except its `skills` alias points to an exact
 * room-owned aggregate so the room skill can join the operator's own without writing into the
 * operator home. Peer receives no executable resource, and its `skills` is an exact projection
 * of the non-`paseo*` operator skills.
 *
 * A name the agent's own runtime owns inside a projected directory is reserved rather than
 * projected: the room neither aliases it nor counts it stale, so the agent's state survives.
 */
export async function roleResourceEntries(input: RoleResourceInput): Promise<Entry[]> {
  const present = new Set(input.shared);
  const executable = new Set(input.executable);
  const reserved = new Set(input.reservedSkills ?? []);
  const entries: Entry[] = [];
  for (const name of input.names) {
    const path = join(input.home, name);
    const alias = join(input.target, name);
    if (name === SKILLS) {
      const projection = await skillsProjection(input, path, alias, present, reserved);
      if (projection !== undefined) {
        entries.push(...projection);
        continue;
      }
    }
    if (!receivesExecutableResources(input.role) && executable.has(name)) continue;
    if (!present.has(path)) continue;
    entries.push({ kind: 'link', path: alias, target: path });
  }
  return entries;
}
