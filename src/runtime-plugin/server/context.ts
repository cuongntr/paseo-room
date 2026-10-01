/**
 * The runtime's per-process wiring. Built once per plugin subprocess from the generated room
 * location; every hook, event and RPC handler supplies Paseo's handle before doing any work.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Controller } from './controller.js';
import { CorrelationRegistry } from './correlations.js';
import type { RoomLocation } from './generated/location.js';
import type { CompactMarkDependencies, HookDependencies } from './hooks.js';
import { GitEvidence } from './git.js';
import { createLeadHandlers, createSupervisorHandlers } from './handlers/actions.js';
import { createPeerHandlers } from './handlers/peer.js';
import { createTurnHandlers, TurnStarts, type TurnHandlers } from './handlers/turns.js';
import { PaseoHandle, sdkPaseoPort } from './paseo-port.js';
import { Recognition, type ManifestState } from './recognition.js';
import { Recovery } from './recovery.js';
import { Spool, type OperationHandler } from './spool.js';
import { writeToolFiles } from './tools.js';
import { AttentionEngine } from './attention/engine.js';
import { SeatStarter } from './attention/seat-starter.js';
import { controllerLedger, Succession } from './attention/succession.js';
import { SuccessionStore } from './attention/succession-store.js';
import { SUCCESSION_TEXT } from './generated/succession.js';
import { DEFAULT_ATTENTION_SETTINGS, type AttentionSettings } from '../shared/attention.js';
import { DEFAULT_PEER_EFFORT_SETTINGS, type PeerEffortSettings } from '../shared/effort.js';
import { DEFAULT_SEAT_CONTEXT_SETTINGS, type SeatContextSettings } from '../shared/seat-context.js';

export interface RuntimeContext {
  readonly location: RoomLocation;
  readonly recognition: Recognition;
  readonly correlations: CorrelationRegistry;
  readonly handle: PaseoHandle;
  readonly hooks: HookDependencies;
  /** What the session-open hook reads to set a Claude seat's compact mark (seat context delta K-D3). */
  readonly compactMark: CompactMarkDependencies;
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
  /** The operator's thinking envelope for Peers (peer-effort delta); replaced when it is saved. */
  readonly peerEffort: { current: PeerEffortSettings; available: boolean };
  /** Adopts a saved envelope and rewrites the tool lists that describe it. */
  adoptPeerEffort(settings: PeerEffortSettings): Promise<void>;
  /**
   * The operator's context budgets per role (seat context delta K-D2); replaced when they are saved.
   * `read` settles once the settings store was first read.
   */
  readonly seatContext: { current: SeatContextSettings; read: Promise<void> };
  /** Human-initiated Lead replacement (seat context delta K-D5). */
  readonly succession: Succession;
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
  const seatContext = { current: DEFAULT_SEAT_CONTEXT_SETTINGS, read: Promise.resolve() };
  const now = (): Date => new Date();
  const attention = new AttentionEngine({
    paseo: controller.deps.paseo, recognition, git: controller.deps.git, runtimeRoot: location.runtimeRoot,
    now, settings: () => attentionSettings.current, contextSettings: () => seatContext.current, ready: () => handle.available,
    ledger: controllerLedger(controller),
  });
  controller.supervisorFor = gitCommonDir => attention.supervisorOf(gitCommonDir).supervisorAgentId;
  const succession = new Succession({
    paseo: controller.deps.paseo, attention, ledger: controllerLedger(controller), store: SuccessionStore.at(location.runtimeRoot, now), text: SUCCESSION_TEXT,
    starter: new SeatStarter({ paseo: controller.deps.paseo, git: controller.deps.git, recognition, attention }), contextSettings: () => seatContext.current, now,
  });
  const registries = {
    supervisor: createSupervisorHandlers(controller, attention, succession),
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
  const turnStarts = new TurnStarts();
  return {
    location,
    recognition,
    correlations,
    handle,
    controller,
    recovery: new Recovery(controller, spool, turnStarts),
    hooks: {
      recognition, correlations, nodePath, runtimeRoot: location.runtimeRoot,
      bridgeScript: join(location.pluginDirectory, 'server', 'bridge', 'bridge.mjs'),
    },
    compactMark: {
      recognition, paseo: controller.deps.paseo, settings: () => seatContext.current, settingsRead: () => seatContext.read,
      log: message => { console.error(`[paseo-room-runtime] ${message}`); }, exempt: agentId => succession.handingOver(agentId),
    },
    registries,
    spool,
    turns: createTurnHandlers(controller, spool, turnStarts),
    attention,
    attentionSettings,
    peerEffort,
    seatContext,
    succession,
    async adoptPeerEffort(settings) {
      peerEffort.current = settings;
      await writeTools();
    },
    ready,
    async start() {
      await ready;
      // The attention sensor was removed in 0.15.0; nothing reads the key it stored, so it is not kept.
      await rm(join(location.runtimeRoot, 'secrets', 'attention-key'), { force: true }).catch(() => undefined);
      await writeTools();
      await spool.start();
    },
  };
}
