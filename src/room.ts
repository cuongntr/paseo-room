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
});
export type Marker = z.infer<typeof markerSchema>;

/** Deterministic on purpose: re-running setup must not show a phantom change. */
export function renderMarker(version: string, agents: readonly AgentId[], roles: readonly Role[]): string {
  return JSON.stringify({ version, agents: [...agents], roles: [...roles] } satisfies Marker, null, 2) + '\n';
}

/** Records what setup created, so verify and remove touch nothing else. */
export async function readMarker(layout: Layout): Promise<Marker | undefined> {
  const source = await readIfPresent(join(layout.roomHome, MARKER));
  if (source === undefined) return undefined;
  try { return markerSchema.parse(JSON.parse(source)); } catch { return undefined; }
}
