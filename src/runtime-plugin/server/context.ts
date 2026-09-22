/**
 * The runtime's per-process wiring. Built once per plugin subprocess from the generated room
 * location; every hook, event and RPC handler supplies Paseo's handle before doing any work.
 */
import { join } from 'node:path';
import { Controller } from './controller.js';
import { CorrelationRegistry } from './correlations.js';
import type { RoomLocation } from './generated/location.js';
import type { HookDependencies } from './hooks.js';
import { GitEvidence } from './git.js';
import { createLeadHandlers, createSupervisorHandlers } from './handlers/actions.js';
import { createPeerHandlers } from './handlers/peer.js';
import { createTurnHandlers, type TurnHandlers } from './handlers/turns.js';
import { PaseoHandle, sdkPaseoPort } from './paseo-port.js';
import { Recognition, type ManifestState } from './recognition.js';
import { Recovery } from './recovery.js';
import { Spool, type OperationHandler } from './spool.js';
import { writeToolFiles } from './tools.js';

export interface RuntimeContext {
  readonly location: RoomLocation;
  readonly recognition: Recognition;
  readonly correlations: CorrelationRegistry;
  readonly handle: PaseoHandle;
  readonly hooks: HookDependencies;
  readonly controller: Controller;
  readonly recovery: Recovery;
  /** Operation handlers by seat; filled by the handler modules before the spool starts. */
  readonly registries: { supervisor: Record<string, OperationHandler>; lead: Record<string, OperationHandler>; peer: Record<string, OperationHandler> };
  readonly spool: Spool;
  readonly turns: TurnHandlers;
  /** Writes the advertised tool lists and starts draining the spool. */
  start(): Promise<void>;
  /** Resolves once the manifest has been read; a failure leaves the runtime paused, not crashed. */
  readonly ready: Promise<ManifestState>;
}

export function createRuntimeContext(location: RoomLocation, nodePath = process.execPath): RuntimeContext {
  const recognition = new Recognition(location.pluginDirectory);
  const correlations = new CorrelationRegistry(join(location.runtimeRoot, 'correlations'));
  const handle = new PaseoHandle();
  const controller = new Controller({ runtimeRoot: location.runtimeRoot, paseo: sdkPaseoPort(handle), git: new GitEvidence(), recognition, correlations });
  const registries = {
    supervisor: createSupervisorHandlers(controller),
    lead: createLeadHandlers(controller),
    peer: { ...createPeerHandlers(controller) },
  };
  const spool = new Spool({
    root: join(location.runtimeRoot, 'spool'),
    // Only a durable association routes a call; a provisional correlation reaches nothing.
    resolve: async correlation => {
      const association = await correlations.lookup(correlation);
      return association === undefined ? undefined : { kind: association.kind, role: association.role };
    },
    registries,
    log: message => { console.error(`[paseo-room-runtime] ${message}`); },
  });
  const ready = recognition.load();
  return {
    location,
    recognition,
    correlations,
    handle,
    controller,
    recovery: new Recovery(controller),
    hooks: {
      recognition, correlations, nodePath, runtimeRoot: location.runtimeRoot,
      bridgeScript: join(location.pluginDirectory, 'server', 'bridge', 'bridge.mjs'),
    },
    registries,
    spool,
    turns: createTurnHandlers(controller, spool),
    ready,
    async start() {
      await ready;
      await writeToolFiles(location.runtimeRoot);
      await spool.start();
    },
  };
}
