/**
 * Server side of the runtime RPCs (docs/design/runtime-coordination.md §8.2, D8).
 *
 * Read RPCs derive the operator's view from local state, so they keep working while Paseo is
 * unreachable and then say live facts are stale. Operator mutations go through the same
 * controller checks as seat calls, record a human actor, and require an idempotency key: a
 * retried key returns the first answer. No RPC runs a shell command or returns a secret.
 */
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import {
  runtimeAbandonRpc, runtimeAssignmentRpc, runtimeHealthRpc, runtimeLeaseReclaimRpc, runtimeProjectRpc, runtimeQuarantineRpc, runtimeRecoverRpc,
  runtimeResolveOwnershipRpc, runtimeWorkspaceCloseRpc,
} from '../shared/rpc-contracts.js';
import type { RuntimeWarningV1 } from '../shared/rpc.js';
import { RUNTIME_PLUGIN_ID } from '../shared/identity.js';
import type { Controller } from './controller.js';
import { project } from './domain/state.js';
import { assignmentDetailView, projectStatusView, revision, type StatusInput } from './domain/views.js';
import { peerStopped, type PaseoApi, type PaseoHandle } from './paseo-port.js';
import type { Recovery } from './recovery.js';
import { ProjectStore } from './store/project.js';

export interface RpcRuntime {
  readonly controller: Controller;
  readonly recovery: Recovery;
  readonly handle: PaseoHandle;
}

type Answer = { schema: 1; revision: string; data: unknown; warnings: RuntimeWarningV1[] } | {
  schema: 1; revision: string; warnings: RuntimeWarningV1[];
  error: { code: string; message: string; recoveryAction: string; retryable: boolean };
};

const human = { source: 'human' as const };

function error(code: string, message: string, recoveryAction: string, retryable = false): Answer {
  return { schema: 1, revision: 'none', warnings: [], error: { code, message: message.slice(0, 1_000), recoveryAction, retryable } };
}

function staleness(runtime: RpcRuntime): RuntimeWarningV1[] {
  return runtime.handle.available ? [] : [{ code: 'live-facts-stale', message: 'Paseo has not been reached from this plugin process yet; live facts may be stale.' }];
}

function answer(runtime: RpcRuntime, data: unknown): Answer {
  return { schema: 1, revision: revision(data), data, warnings: staleness(runtime) };
}

async function storeOf(runtime: RpcRuntime, projectId: string): Promise<ProjectStore | undefined> {
  return (await ProjectStore.list(runtime.controller.deps.runtimeRoot, runtime.controller.deps.now)).find(store => store.meta.projectId === projectId);
}

async function statusInput(runtime: RpcRuntime, store: ProjectStore): Promise<StatusInput> {
  const replay = await store.replay();
  const projection = project(store.meta.projectId, replay.events);
  return {
    projectId: store.meta.projectId, canonicalRoot: store.meta.canonicalRoot, replay, violations: projection.violations,
    state: projection.state, events: replay.events, liveAvailable: runtime.handle.available, present: existsSync,
  };
}

const LIVENESS_MS = 2_000;

/** The value, or null when it failed or did not arrive in time. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => { timer = setTimeout(() => { resolve(null); }, ms); });
  try {
    return await Promise.race([work.catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const missing = (projectId: string): Answer => error('project_unknown', `No runtime project ${projectId}.`, 'Refresh the project list.');

export function createRpcHandlers(runtime: RpcRuntime) {
  const idempotent = new Map<string, Answer>();
  const once = async (key: string, work: () => Promise<Answer>): Promise<Answer> => {
    const known = idempotent.get(key);
    if (known !== undefined) return known;
    const result = await work();
    idempotent.set(key, result);
    return result;
  };
  const { controller } = runtime;

  return {
    async health(): Promise<Answer> {
      const manifest = controller.deps.recognition.current;
      const projects = [];
      for (const store of await ProjectStore.list(controller.deps.runtimeRoot, controller.deps.now)) {
        const input = await statusInput(runtime, store);
        const view = projectStatusView(input);
        projects.push({ projectId: view.projectId, canonicalRoot: view.canonicalRoot, health: view.health.value, findings: view.findings.length });
      }
      return answer(runtime, {
        plugin: { id: RUNTIME_PLUGIN_ID, manifest: manifest.status, ...(manifest.status === 'paused' ? { reason: manifest.reason } : {}) },
        projects,
      });
    },

    async project(input: z.infer<typeof runtimeProjectRpc.input>): Promise<Answer> {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      const status = await statusInput(runtime, store);
      const view = projectStatusView(status);
      // Live liveness only decides whether the panel offers a Human reclaim; the view itself stays
      // local. Leases are read at once and each read is bounded, so a stalled daemon cannot stall
      // the project view.
      const leases = await Promise.all(view.leases.map(async lease => {
        let peer: 'archived' | 'gone' | 'live' | 'unknown' = 'unknown';
        if (runtime.handle.available && lease.reclaimable && lease.agentId !== undefined) {
          const live = await bounded(controller.deps.paseo.getAgent(lease.agentId), LIVENESS_MS);
          peer = live === null ? 'unknown' : live === undefined ? 'gone' : peerStopped(live) ? 'archived' : 'live';
        }
        return { ...lease, peer };
      }));
      return answer(runtime, { ...view, leases, problems: status.replay.problems.map(problem => ({ file: problem.file, reason: problem.reason })) });
    },

    async assignment(input: z.infer<typeof runtimeAssignmentRpc.input>): Promise<Answer> {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      const status = await statusInput(runtime, store);
      const detail = assignmentDetailView(status.state, input.assignmentId, 'operator', existsSync);
      return detail === undefined ? error('assignment_unknown', `No assignment ${input.assignmentId}.`, 'Refresh the project view.') : answer(runtime, detail);
    },

    recover: (input: z.infer<typeof runtimeRecoverRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      const report = await runtime.recovery.recoverProject(store);
      return report.paused
        ? error('project_paused', 'The project ledger is paused; recovery cannot run.', 'Export the project and inspect the named event file.')
        : answer(runtime, { actions: report.actions });
    }),

    abandon: (input: z.infer<typeof runtimeAbandonRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      return await controller.serial(store.meta.projectId, async () => {
        const loaded = await controller.load(store);
        if (!loaded.ok) return error(loaded.code, loaded.message, 'Export the project and inspect the named event file.');
        try {
          await controller.append(loaded.value, { type: 'assignment.abandoned', payloadVersion: 1, assignmentId: input.assignmentId, actor: human, idempotencyKey: input.idempotencyKey, data: { reason: input.reason } });
        } catch (failure) {
          return error('assignment_state', failure instanceof Error ? failure.message : String(failure), 'Wait for the current turn to settle, or request archive first for an uncertain assignment.');
        }
        return answer(runtime, { state: 'abandoned' });
      });
    }),

    resolveOwnership: (input: z.infer<typeof runtimeResolveOwnershipRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      return await controller.serial(store.meta.projectId, async () => {
        const loaded = await controller.load(store);
        if (!loaded.ok) return error(loaded.code, loaded.message, 'Export the project and inspect the named event file.');
        if (loaded.value.state.ownershipConflict?.leadAgentIds.includes(input.keptLeadAgentId) !== true) {
          return error('ownership_not_in_conflict', 'That Lead is not part of an open ownership conflict.', 'Refresh the project view.');
        }
        await controller.append(loaded.value, { type: 'project.ownership-resolved', payloadVersion: 1, actor: human, idempotencyKey: input.idempotencyKey, data: { keptLeadAgentId: input.keptLeadAgentId, decidedBy: 'human' } });
        return answer(runtime, { resolved: true });
      });
    }),

    workspaceClose: (input: z.infer<typeof runtimeWorkspaceCloseRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      return await controller.serial(store.meta.projectId, async () => {
        const loaded = await controller.load(store);
        if (!loaded.ok) return error(loaded.code, loaded.message, 'Export the project and inspect the named event file.');
        const closed = await controller.closeRetained(loaded.value, input.assignmentId, input, human);
        return closed.ok
          ? answer(runtime, closed.value)
          : error(closed.code, closed.message, closed.code === 'workspace_retained' ? 'Inspect the worktree; discard only with a reason.' : 'Refresh the assignment view.', closed.retryable);
      });
    }),

    leaseReclaim: (input: z.infer<typeof runtimeLeaseReclaimRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      return await controller.serial(store.meta.projectId, async () => {
        const loaded = await controller.load(store);
        if (!loaded.ok) return error(loaded.code, loaded.message, 'Export the project and inspect the named event file.');
        const reclaimed = await controller.reclaim(loaded.value, input.assignmentId, input.reason, 'human');
        return reclaimed.ok
          ? answer(runtime, reclaimed.value)
          : error(reclaimed.code, reclaimed.message, reclaimed.code === 'writer_not_proven_stopped' ? 'Archive the Peer in Paseo first.' : 'Refresh the assignment view.', reclaimed.retryable);
      });
    }),

    quarantine: (input: z.infer<typeof runtimeQuarantineRpc.input>): Promise<Answer> => once(input.idempotencyKey, async () => {
      const store = await storeOf(runtime, input.projectId);
      if (store === undefined) return missing(input.projectId);
      return await controller.serial(store.meta.projectId, async () => {
        try {
          await store.quarantine(input.file);
        } catch (failure) {
          return error('quarantine_failed', failure instanceof Error ? failure.message : String(failure), 'Check the file name against the project finding.');
        }
        return answer(runtime, { quarantined: input.file });
      });
    }),
  };
}

/** Registers every runtime RPC; each supplies Paseo's handle first and validates its own answer. */
export function registerRpcs(server: Pick<PluginServerContext, 'handle'>, runtime: RpcRuntime): void {
  const handlers = createRpcHandlers(runtime);
  const supply = (paseo: PaseoApi): void => { runtime.handle.supply(paseo); };
  server.handle(runtimeHealthRpc, async (_input, { paseo }) => { supply(paseo); return runtimeHealthRpc.output.parse(await handlers.health()); });
  server.handle(runtimeProjectRpc, async (input, { paseo }) => { supply(paseo); return runtimeProjectRpc.output.parse(await handlers.project(input)); });
  server.handle(runtimeAssignmentRpc, async (input, { paseo }) => { supply(paseo); return runtimeAssignmentRpc.output.parse(await handlers.assignment(input)); });
  server.handle(runtimeRecoverRpc, async (input, { paseo }) => { supply(paseo); return runtimeRecoverRpc.output.parse(await handlers.recover(input)); });
  server.handle(runtimeAbandonRpc, async (input, { paseo }) => { supply(paseo); return runtimeAbandonRpc.output.parse(await handlers.abandon(input)); });
  server.handle(runtimeResolveOwnershipRpc, async (input, { paseo }) => { supply(paseo); return runtimeResolveOwnershipRpc.output.parse(await handlers.resolveOwnership(input)); });
  server.handle(runtimeQuarantineRpc, async (input, { paseo }) => { supply(paseo); return runtimeQuarantineRpc.output.parse(await handlers.quarantine(input)); });
  server.handle(runtimeWorkspaceCloseRpc, async (input, { paseo }) => { supply(paseo); return runtimeWorkspaceCloseRpc.output.parse(await handlers.workspaceClose(input)); });
  server.handle(runtimeLeaseReclaimRpc, async (input, { paseo }) => { supply(paseo); return runtimeLeaseReclaimRpc.output.parse(await handlers.leaseReclaim(input)); });
}
