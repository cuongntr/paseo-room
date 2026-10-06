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
import { RoomSeatPanel, RoomSeatsSettings, RuntimeSurface, RuntimeWorkspacePanel } from './client/views.js';

const SURFACE = 'paseo-room-runtime';
const SEAT_PANEL = 'paseo-room-seat';

/**
 * Beside a seat's conversation: what the seat is, does and is told. A host without agent panels
 * refuses the registration; the rest of the plugin still loads.
 */
function seatPanel(client: PluginClientContext): () => void | Promise<void> {
  try {
    return client.addWorkspacePanel({ id: SEAT_PANEL, title: 'Room seat', icon: 'IdCard', context: 'agent', Component: RoomSeatPanel });
  } catch {
    return () => undefined;
  }
}

// Hoisted on purpose; see the note in index.server.ts about Paseo's eager export copy.
export default function contribute(client: PluginClientContext): () => Promise<void> {
  bindHost({ openSettings: id => { client.openSettings(id); } });
  // The surface is registered before the sidebar item that points at it.
  const removers: (() => void | Promise<void>)[] = [
    client.addSurface(SURFACE, RuntimeSurface),
    client.addSidebarItem({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', surface: SURFACE }),
    client.addWorkspacePanel({ id: SURFACE, title: 'Room runtime', icon: 'Workflow', context: 'workspace', Component: RuntimeWorkspacePanel }),
    seatPanel(client),
    client.addSettingsScreen({ id: SEATS_SETTINGS_SCREEN, title: 'Room seats', icon: 'Users', Component: RoomSeatsSettings }),
    client.addSettingsScreen({ id: ATTENTION_SETTINGS_SCREEN, title: 'Room attention', icon: 'Bell', Component: RoomAttentionSettings }),
    // Each room seat's composer names its role; the agent keeps its own name.
    startRolePills(client, SURFACE),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
}
