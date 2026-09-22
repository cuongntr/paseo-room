/**
 * Paseo lifecycle events as notifications (docs/design/runtime-coordination.md §3.3).
 *
 * Paseo `0.8.0` emits these fire-and-forget, so no transition waits on a handler and every
 * handler corroborates through a fresh read before it changes anything. The first handler to
 * receive Paseo's handle also runs start-up recovery; a failure there is retried on the next event.
 */
import type { PluginLifecycleEvents, PluginServerContext } from '@getpaseo/plugin/server';
import type { PaseoHandle } from './paseo-port.js';
import type { Recovery } from './recovery.js';

export interface LifecycleListeners {
  readonly turnEnded?: (event: PluginLifecycleEvents['agent.turn_ended']) => Promise<void>;
  readonly permissionRequested?: (event: PluginLifecycleEvents['agent.permission_requested']) => Promise<void>;
  readonly permissionResolved?: (event: PluginLifecycleEvents['agent.permission_resolved']) => Promise<void>;
}

export function registerLifecycle(
  server: Pick<PluginServerContext, 'on'>,
  handle: PaseoHandle,
  recovery: Recovery,
  listeners: LifecycleListeners = {},
  log: (message: string) => void = message => { console.error(`[paseo-room-runtime] ${message}`); },
): () => void {
  let recovered: Promise<unknown> | undefined;
  const startupRecovery = (): void => {
    recovered ??= recovery.recoverAll().catch((error: unknown) => {
      recovered = undefined;
      log(`Start-up recovery did not complete and will be retried: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
  const guard = (name: string, work: () => Promise<unknown>): Promise<void> =>
    work().then(() => undefined, (error: unknown) => { log(`${name} handler failed: ${error instanceof Error ? error.message : String(error)}`); });

  const disposers = [
    server.on('agent.archived', (event, context) => {
      handle.supply(context.paseo);
      startupRecovery();
      return guard('agent.archived', () => recovery.recoverForAgent(event.agent.id));
    }),
    server.on('agent.turn_ended', (event, context) => {
      handle.supply(context.paseo);
      startupRecovery();
      return guard('agent.turn_ended', async () => { await listeners.turnEnded?.(event); await recovery.recoverForAgent(event.agent.id); });
    }),
    server.on('agent.permission_requested', (event, context) => {
      handle.supply(context.paseo);
      startupRecovery();
      return guard('agent.permission_requested', async () => { await listeners.permissionRequested?.(event); });
    }),
    server.on('agent.permission_resolved', (event, context) => {
      handle.supply(context.paseo);
      startupRecovery();
      return guard('agent.permission_resolved', async () => { await listeners.permissionResolved?.(event); });
    }),
    server.on('agent.created', (_event, context) => { handle.supply(context.paseo); startupRecovery(); }),
    server.on('agent.turn_started', (_event, context) => { handle.supply(context.paseo); startupRecovery(); }),
  ];
  return () => { for (const dispose of disposers) dispose(); };
}
