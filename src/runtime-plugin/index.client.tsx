/**
 * Client entry of the paseo-room runtime coordination plugin (preview).
 *
 * Runs inside the Paseo app on every platform: React Native primitives only, no DOM, and no
 * import from `server/` or any `node:` module. See docs/design/runtime-coordination.md §8.1.
 */
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { RoomSeatsSettings, RuntimeSurface, RuntimeWorkspacePanel } from './client/views.js';

const SURFACE = 'paseo-room-runtime';

// Hoisted on purpose; see the note in index.server.ts about Paseo's eager export copy.
export default function contribute(client: PluginClientContext): () => Promise<void> {
  // The surface is registered before the sidebar item that points at it.
  const removers = [
    client.addSurface(SURFACE, RuntimeSurface),
    client.addSidebarItem({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', surface: SURFACE }),
    client.addWorkspacePanel({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', context: 'workspace', Component: RuntimeWorkspacePanel }),
    client.addSettingsScreen({ id: 'paseo-room-seats', title: 'Room seats', icon: 'Users', Component: RoomSeatsSettings }),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}
