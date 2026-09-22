/**
 * Client entry of the paseo-room runtime coordination plugin (preview).
 *
 * Runs inside the Paseo app on every platform: React Native primitives only, no DOM, and no
 * import from `server/` or any `node:` module. See docs/design/runtime-coordination.md §8.1.
 */
import type { PluginClientContribution } from '@getpaseo/plugin/client';
import { RuntimeSurface, RuntimeWorkspacePanel } from './client/views.js';

const SURFACE = 'paseo-room-runtime';

const contribute: PluginClientContribution = client => {
  // The surface is registered before the sidebar item that points at it.
  const removers = [
    client.addSurface(SURFACE, RuntimeSurface),
    client.addSidebarItem({ id: SURFACE, title: 'Room runtime', icon: 'workflow', surface: SURFACE }),
    client.addWorkspacePanel({ id: SURFACE, title: 'Room runtime', icon: 'workflow', context: 'workspace', Component: RuntimeWorkspacePanel }),
  ];
  return async () => { for (const remove of removers.reverse()) await remove(); };
};

export default contribute;
