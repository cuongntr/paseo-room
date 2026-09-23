/**
 * Turn-end and reporting-permission handling (docs/design/runtime-coordination.md §3.4, §5.1).
 *
 * A turn that ends with no accepted report — once every spool entry it sent is terminal — is a
 * missing report: the assignment is blocked and Lead is told. Prose in the final message is
 * never read as a report. Unresolved report persistence is uncertain instead, and holds the
 * generation fence closed. A pending permission for the reporting tool is an expected wait, not
 * a missing report; the runtime never answers it, because that decision belongs to a person.
 */
import type { PluginLifecycleEvents } from '@getpaseo/plugin/server';
import type { Controller, LoadedProject } from '../controller.js';
import type { AssignmentView } from '../domain/state.js';
import { BRIDGE_SERVER_NAME } from '../hooks.js';
import type { Spool } from '../spool.js';
import { ProjectStore } from '../store/project.js';

const plugin = { source: 'plugin' as const };

/** The reporting tool a permission request names, when it names one of ours. */
export function reportingToolOf(name: string): 'ask' | 'handoff' | undefined {
  const match = new RegExp(`(?:^|__)${BRIDGE_SERVER_NAME}__(ask|handoff)$`).exec(name);
  return match?.[1] === 'ask' || match?.[1] === 'handoff' ? match[1] : undefined;
}

interface Located {
  readonly store: ProjectStore;
  readonly view: AssignmentView;
}

async function locatePeer(controller: Controller, agentId: string): Promise<Located | undefined> {
  for (const store of await ProjectStore.list(controller.deps.runtimeRoot, controller.deps.now)) {
    const loaded = await controller.load(store);
    if (!loaded.ok) continue;
    const view = [...loaded.value.state.assignments.values()].find(entry => entry.peerAgentId === agentId);
    if (view !== undefined) return { store, view };
  }
  return undefined;
}

/**
 * Judges a Peer turn that has ended. Callers hold the project's serial lane. The turn-end event
 * drains the spool first; recovery cannot (a drain waits on the same lane), so any report still
 * unresolved there is recorded as uncertain rather than missing — never the other way round.
 */
export async function settleEndedTurn(controller: Controller, spool: Spool, loaded: LoadedProject, view: AssignmentView, agentId: string): Promise<'missing' | 'uncertain' | 'waiting' | 'none'> {
  if (view.reportingState !== 'open' || (view.state !== 'active' && view.state !== 'awaiting-permission')) return 'none';
  const association = await controller.deps.correlations.findByAssignment(view.id);
  const pending = association === undefined ? [] : await spool.unresolvedFor(association.correlationId);
  if (pending.length > 0) {
    await controller.append(loaded, { type: 'report.uncertain', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { generation: view.reportingGeneration, requestId: pending[0] ?? '', reason: 'A report from this turn has not been recorded yet.' } });
    return 'uncertain';
  }
  if (view.state === 'awaiting-permission') {
    const live = await controller.deps.paseo.getAgent(agentId).catch(() => undefined);
    if (live?.pendingPermissions.some(permission => permission.id === view.awaitingPermissionId) === true) return 'waiting';
    await controller.append(loaded, { type: 'permission.resolved', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { generation: view.reportingGeneration, permissionRequestId: view.awaitingPermissionId ?? 'unknown', outcome: 'other' } });
  }
  await controller.append(loaded, { type: 'report.missing', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { generation: view.reportingGeneration } });
  await controller.notices.notify(loaded, {
    kind: 'report-missing', class: 'owner', disposition: 'lead-now', assignmentId: view.id,
    text: `The Peer on ${view.id} ended its turn without an accepted ask or handoff. Anything in its final message is not a report; answer with a follow-up or abandon the assignment.`,
    recipient: { agentId: view.leadAgentId, role: 'lead' },
  });
  return 'missing';
}

export interface TurnHandlers {
  turnEnded(event: PluginLifecycleEvents['agent.turn_ended']): Promise<'missing' | 'uncertain' | 'waiting' | 'none'>;
  permissionRequested(event: PluginLifecycleEvents['agent.permission_requested']): Promise<boolean>;
  permissionResolved(event: PluginLifecycleEvents['agent.permission_resolved']): Promise<boolean>;
}

export function createTurnHandlers(controller: Controller, spool: Spool): TurnHandlers {
  const within = async <T>(agentId: string, fallback: T, work: (loaded: LoadedProject, view: AssignmentView) => Promise<T>): Promise<T> => {
    const located = await locatePeer(controller, agentId);
    if (located === undefined) return fallback;
    return await controller.serial(located.store.meta.projectId, async () => {
      const loaded = await controller.load(located.store);
      const view = loaded.ok ? loaded.value.state.assignments.get(located.view.id) : undefined;
      return loaded.ok && view !== undefined ? await work(loaded.value, view) : fallback;
    });
  };

  return {
    async turnEnded(event) {
      // Let every report this turn sent reach a terminal reply before judging the turn.
      await spool.schedule();
      return await within(event.agent.id, 'none' as const, async (loaded, view) => await settleEndedTurn(controller, spool, loaded, view, event.agent.id));
    },

    async permissionRequested(event) {
      const tool = reportingToolOf(event.request.name);
      if (tool === undefined) return false;
      return await within(event.agent.id, false, async (loaded, view) => {
        if (view.state !== 'active' || view.reportingState !== 'open') return false;
        await controller.append(loaded, { type: 'permission.awaiting', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { generation: view.reportingGeneration, permissionRequestId: event.request.id, tool } });
        await controller.notices.notify(loaded, {
          kind: 'awaiting-permission', class: 'owner', disposition: 'lead-now', assignmentId: view.id,
          text: `The Peer on ${view.id} is waiting for someone to allow its ${tool} reporting tool (${event.request.name}). The runtime does not answer permissions.`,
          recipient: { agentId: view.leadAgentId, role: 'lead' },
        });
        await controller.notices.notify(loaded, {
          kind: 'awaiting-permission', class: 'operator', disposition: 'operator-now', assignmentId: view.id,
          text: `Allow or deny ${event.request.name} for Peer ${event.agent.id} in Paseo.`,
        });
        return true;
      });
    },

    async permissionResolved(event) {
      return await within(event.agent.id, false, async (loaded, view) => {
        if (view.state !== 'awaiting-permission' || view.awaitingPermissionId !== event.requestId) return false;
        const behavior = (event.resolution as { behavior?: unknown }).behavior;
        const outcome = behavior === 'allow' ? 'allowed' : behavior === 'deny' ? 'denied' : 'other';
        await controller.append(loaded, { type: 'permission.resolved', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { generation: view.reportingGeneration, permissionRequestId: event.requestId, outcome } });
        return true;
      });
    },
  };
}
