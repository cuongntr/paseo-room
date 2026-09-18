import { join } from 'node:path';
import { z } from 'zod';
import { readIfPresent } from './fsops.js';
import type { Layout } from './layout.js';
import { AGENT_IDS, ROLES, type AgentId, type Role } from './roles.js';

export const MARKER = 'room.json';

const markerSchema = z.object({
  version: z.string(),
  agents: z.array(z.enum(AGENT_IDS)).min(1),
  roles: z.array(z.enum(ROLES)).min(1),
  /**
   * The rendered contract generation this room was installed from. Optional because a room
   * written before contract provenance existed has no digest, and such a marker must still
   * parse rather than look like a foreign file.
   */
  contract: z.string().min(1).optional(),
  /**
   * False when this room deliberately suppressed the role contract in Claude's `CLAUDE.md`,
   * leaving the plugin as its only Claude carrier. Optional and defaulted to true so a room
   * written before the option existed keeps parsing and keeps its current behaviour.
   */
  claudeMemoryContract: z.boolean().optional(),
});
export type Marker = z.infer<typeof markerSchema>;

/** Deterministic on purpose: re-running setup must not show a phantom change. */
export function renderMarker(
  version: string,
  agents: readonly AgentId[],
  roles: readonly Role[],
  contract?: string,
  claudeMemoryContract?: boolean,
): string {
  return JSON.stringify({
    version, agents: [...agents], roles: [...roles],
    ...(contract === undefined ? {} : { contract }),
    // Written only when it differs from the default, so an unchanged room's marker is unchanged.
    ...(claudeMemoryContract === false ? { claudeMemoryContract: false } : {}),
  } satisfies Marker, null, 2) + '\n';
}

/** Records what setup created, so verify and remove touch nothing else. */
export async function readMarker(layout: Layout): Promise<Marker | undefined> {
  const source = await readIfPresent(join(layout.roomHome, MARKER));
  if (source === undefined) return undefined;
  try { return markerSchema.parse(JSON.parse(source)); } catch { return undefined; }
}
