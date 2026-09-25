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
import { AttentionEngine } from './attention/engine.js';
import { AttentionKey } from './attention/key.js';
import { AttentionLog } from './attention/log.js';
import { SystemOneSensor } from './attention/sensor.js';
import { DEFAULT_ATTENTION_SETTINGS, type AttentionSettings } from '../shared/attention.js';
import { DEFAULT_PEER_EFFORT_SETTINGS, type PeerEffortSettings } from '../shared/effort.js';

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
  /** The Room Observer, signals and Supervisor letters (docs/design/runtime-coordination-attention.md). */
  readonly attention: AttentionEngine;
  /** The current Room attention settings; replaced when the operator saves them. */
  readonly attentionSettings: { current: AttentionSettings; available: boolean };
  readonly attentionKey: AttentionKey;
  /** The operator's thinking envelope for Peers (peer-effort delta); replaced when it is saved. */
  readonly peerEffort: { current: PeerEffortSettings; available: boolean };
  /** Adopts a saved envelope and rewrites the tool lists that describe it. */
  adoptPeerEffort(settings: PeerEffortSettings): Promise<void>;
  readonly sensor: SystemOneSensor;
  /** Writes the advertised tool lists and starts draining the spool. */
  start(): Promise<void>;
  /** Resolves once the manifest has been read; a failure leaves the runtime paused, not crashed. */
  readonly ready: Promise<ManifestState>;
}

export function createRuntimeContext(location: RoomLocation, nodePath = process.execPath): RuntimeContext {
  const recognition = new Recognition(location.pluginDirectory);
  const correlations = new CorrelationRegistry(join(location.runtimeRoot, 'correlations'));
  const handle = new PaseoHandle();
  const peerEffort = { current: DEFAULT_PEER_EFFORT_SETTINGS, available: false };
  // One write at a time: start and a settings change may both rewrite the tool lists.
  let toolWrites: Promise<void> = Promise.resolve();
  const writeTools = (): Promise<void> => {
    const next = toolWrites.then(() => writeToolFiles(location.runtimeRoot, peerEffort.current));
    toolWrites = next.catch(() => undefined);
    return next;
  };
  const controller = new Controller({
    runtimeRoot: location.runtimeRoot, paseo: sdkPaseoPort(handle), git: new GitEvidence(), recognition, correlations, peerEffort: () => peerEffort.current,
  });
  const attentionSettings = { current: DEFAULT_ATTENTION_SETTINGS, available: false };
  const attentionKey = AttentionKey.at(location.runtimeRoot);
  const now = (): Date => new Date();
  const sensor = new SystemOneSensor({ settings: () => attentionSettings.current, key: attentionKey, log: AttentionLog.at(location.runtimeRoot, now), now });
  const attention = new AttentionEngine({
    paseo: controller.deps.paseo, recognition, git: controller.deps.git, runtimeRoot: location.runtimeRoot,
    now, settings: () => attentionSettings.current, sensor, ready: () => handle.available,
  });
  controller.supervisorFor = gitCommonDir => attention.supervisorOf(gitCommonDir).supervisorAgentId;
  const registries = {
    supervisor: createSupervisorHandlers(controller, attention),
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
    recovery: new Recovery(controller, spool),
    hooks: {
      recognition, correlations, nodePath, runtimeRoot: location.runtimeRoot,
      bridgeScript: join(location.pluginDirectory, 'server', 'bridge', 'bridge.mjs'),
    },
    registries,
    spool,
    turns: createTurnHandlers(controller, spool),
    attention,
    attentionSettings,
    attentionKey,
    peerEffort,
    async adoptPeerEffort(settings) {
      peerEffort.current = settings;
      await writeTools();
    },
    sensor,
    ready,
    async start() {
      await ready;
      await writeTools();
      await spool.start();
    },
  };
}
