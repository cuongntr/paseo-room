/**
 * Client entry of the paseo-room runtime coordination plugin (preview).
 *
 * Runs inside the Paseo app on every platform: React Native primitives only, no DOM, and no
 * import from `server/` or any `node:` module. See docs/design/runtime-coordination.md §8.1.
 */
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { RoomAttentionSettings } from './client/attention-settings.js';
import { ATTENTION_SETTINGS_SCREEN, SEATS_SETTINGS_SCREEN, bindHost } from './client/host.js';
import { startRolePills } from './client/role-pills.js';
import { RoomSeatsSettings, RuntimeSurface, RuntimeWorkspacePanel } from './client/views.js';

const SURFACE = 'paseo-room-runtime';

// Hoisted on purpose; see the note in index.server.ts about Paseo's eager export copy.
export default function contribute(client: PluginClientContext): () => Promise<void> {
  bindHost({ openSettings: id => { client.openSettings(id); } });
  // The surface is registered before the sidebar item that points at it.
  const removers: (() => void | Promise<void>)[] = [
    client.addSurface(SURFACE, RuntimeSurface),
    client.addSidebarItem({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', surface: SURFACE }),
    client.addWorkspacePanel({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', context: 'workspace', Component: RuntimeWorkspacePanel }),
    client.addSettingsScreen({ id: SEATS_SETTINGS_SCREEN, title: 'Room seats', icon: 'Users', Component: RoomSeatsSettings }),
    client.addSettingsScreen({ id: ATTENTION_SETTINGS_SCREEN, title: 'Room attention', icon: 'Bell', Component: RoomAttentionSettings }),
    // Each room seat's composer names its role; the agent keeps its own name.
    startRolePills(client, SURFACE),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}
