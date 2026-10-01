/**
 * Turn-end and reporting-permission handling (docs/design/runtime-coordination.md §3.4, §5.1).
 *
 * A turn that ends with no accepted report — once every spool entry it sent is terminal — is a
 * missing report: the assignment is blocked and Lead is told. Prose in the final message is
 * never read as a report. Unresolved report persistence is uncertain instead, and holds the
 * generation fence closed. A pending permission for the reporting tool is an expected wait, not
 * a missing report; the runtime never answers it, because that decision belongs to a person.
 *
 * A turn is judged only as the open generation's own turn. Lead may answer the moment the asking
 * turn ends, and the answer opens the next generation before this handler has judged that turn;
 * the earlier turn's end must not close the generation its answer opened.
 */
import type { PluginLifecycleEvents } from '@getpaseo/plugin/server';
import { assignmentName } from '../brief.js';
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

/** Starts kept per agent, and agents kept at all; a Peer's turns never overlap, so a few suffice. */
const KEPT_STARTS = 8;
const KEPT_AGENTS = 1_000;

/**
 * When each turn began, as Paseo announced it to this process. It tells a late end of an earlier
 * turn from the end of the turn a new prompt opened. Knowledge starts with the process: a turn that
 * began before it is unknown, and is judged as it always was.
 */
export class TurnStarts {
  /** Every turn that began at or after this instant was announced here. */
  readonly since: number;
  private readonly starts = new Map<string, { readonly turnId: string | null; readonly at: number }[]>();

  constructor(private readonly now: () => number = Date.now) {
    this.since = now();
  }

  started(agentId: string, turnId: string | null): void {
    const kept = (this.starts.get(agentId) ?? []).slice(-(KEPT_STARTS - 1));
    this.starts.delete(agentId);
    this.starts.set(agentId, [...kept, { turnId, at: this.now() }]);
    const oldest = this.starts.size > KEPT_AGENTS ? this.starts.keys().next().value : undefined;
    if (oldest !== undefined) this.starts.delete(oldest);
  }

  /** When the named turn began; without a turn id, the latest start, since an agent's turns never overlap. */
  startOf(agentId: string, turnId: string | null): number | undefined {
    const starts = this.starts.get(agentId) ?? [];
    return (turnId === null ? starts.at(-1) : starts.filter(start => start.turnId === turnId).at(-1))?.at;
  }

  /** Whether a turn of the agent began at or after `at`. */
  startedSince(agentId: string, at: number): boolean {
    return (this.starts.get(agentId) ?? []).some(start => start.at >= at);
  }
}

/** When the open generation's prompt was requested, from the ledger. */
export function promptRequestedAt(loaded: LoadedProject, view: AssignmentView): number | undefined {
  const requested = loaded.events.filter(event => event.type === 'run.requested' && event.assignmentId === view.id && event.data.generation === view.runGeneration).at(-1);
  return requested === undefined ? undefined : Date.parse(requested.occurredAt);
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
  const association = await controller.deps.correlations.findByAssignment(view.id, agentId);
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
  await recordMissing(controller, loaded, view);
  return 'missing';
}

async function recordMissing(controller: Controller, loaded: LoadedProject, view: AssignmentView): Promise<void> {
  await controller.append(loaded, { type: 'report.missing', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { generation: view.reportingGeneration } });
  await controller.notices.notify(loaded, {
    kind: 'report-missing', class: 'owner', disposition: 'lead-now', assignmentId: view.id,
    text: `The Peer of ${assignmentName(view)} ended its turn without an accepted ask or handoff. Anything in its final message is not a report; answer with a follow-up or abandon the assignment.`,
    recipient: { agentId: view.leadAgentId, role: 'lead' },
  });
}

/**
 * Settles a generation held uncertain because its ended turn left a report in the spool (§3.4):
 * once every spool entry from that Peer is terminal and none was accepted, the turn produced no
 * report. `answering` is a request being answered now, whose reply is not yet written. Callers
 * hold the project's serial lane. A generation uncertain for another reason, such as a run whose
 * delivery is unknown, is left to its own recovery.
 */
export async function settleUncertainReport(
  controller: Controller, unresolvedFor: (correlation: string) => Promise<string[]>, loaded: LoadedProject, view: AssignmentView, answering?: string,
): Promise<boolean> {
  if (view.state !== 'uncertain' || view.reportingState !== 'uncertain' || view.peerAgentId === undefined) return false;
  const cause = loaded.events.filter(event => event.assignmentId === view.id && (event.type === 'report.uncertain' || event.type === 'run.uncertain')).at(-1);
  if (cause?.type !== 'report.uncertain' || cause.data.generation !== view.reportingGeneration) return false;
  const association = await controller.deps.correlations.findByAssignment(view.id, view.peerAgentId);
  const pending = association === undefined ? [] : (await unresolvedFor(association.correlationId)).filter(id => id !== answering);
  if (pending.length > 0) return false;
  await recordMissing(controller, loaded, view);
  return true;
}

/** What Lead was refused as `peer_busy`, by the state it answered from. */
const REFUSED: Partial<Record<AssignmentView['state'], string>> = { questioned: 'answer', blocked: 'follow-up', 'handed-back': 'rework' };

/**
 * Tells Lead that a Peer it was refused as busy has ended its turn, so what it tried to send can go.
 * Only while the assignment still waits in the generation of the refusal; a later generation means
 * Lead's retry went through. Call inside the project's queue.
 */
async function wakeRefusedLead(controller: Controller, loaded: LoadedProject, view: AssignmentView): Promise<void> {
  const refused = controller.busyRefusals.get(view.id);
  if (refused === undefined) return;
  controller.busyRefusals.delete(view.id);
  const what = REFUSED[view.state];
  if (what === undefined || refused !== view.reportingGeneration) return;
  await controller.notices.notify(loaded, {
    kind: 'peer-free', class: 'owner', disposition: 'lead-now', assignmentId: view.id,
    text: `The Peer of ${assignmentName(view)} has ended its turn, so the ${what} refused as peer_busy can go now; send it again.`,
    recipient: { agentId: view.leadAgentId, role: 'lead' },
  });
}

export interface TurnHandlers {
  turnStarted(event: PluginLifecycleEvents['agent.turn_started']): void;
  turnEnded(event: PluginLifecycleEvents['agent.turn_ended']): Promise<'missing' | 'uncertain' | 'waiting' | 'none'>;
  permissionRequested(event: PluginLifecycleEvents['agent.permission_requested']): Promise<boolean>;
  permissionResolved(event: PluginLifecycleEvents['agent.permission_resolved']): Promise<boolean>;
}

export function createTurnHandlers(controller: Controller, spool: Spool, starts: TurnStarts): TurnHandlers {
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
    turnStarted(event) {
      starts.started(event.agent.id, event.turnId);
    },

    async turnEnded(event) {
      // Read before any wait: once this turn has ended, the next may start before it is judged.
      const startedAt = starts.startOf(event.agent.id, event.turnId);
      // Let every report this turn sent reach a terminal reply before judging the turn.
      await spool.schedule();
      return await within(event.agent.id, 'none' as const, async (loaded, view) => {
        const requestedAt = promptRequestedAt(loaded, view);
        // Began before this generation's prompt was sent: an earlier turn ending late. A turn this
        // process never saw begin, when the prompt was sent after it started, began before the
        // prompt too, since every start since then was announced here (as for recovery).
        if (requestedAt !== undefined && (startedAt === undefined ? requestedAt >= starts.since : startedAt < requestedAt)) return 'none';
        const outcome = await settleEndedTurn(controller, spool, loaded, view, event.agent.id);
        if (outcome === 'none') await wakeRefusedLead(controller, loaded, view);
        return outcome;
      });
    },

    async permissionRequested(event) {
      const tool = reportingToolOf(event.request.name);
      if (tool === undefined) return false;
      return await within(event.agent.id, false, async (loaded, view) => {
        if (view.state !== 'active' || view.reportingState !== 'open') return false;
        await controller.append(loaded, { type: 'permission.awaiting', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { generation: view.reportingGeneration, permissionRequestId: event.request.id, tool } });
        await controller.notices.notify(loaded, {
          kind: 'awaiting-permission', class: 'owner', disposition: 'lead-now', assignmentId: view.id,
          text: `The Peer of ${assignmentName(view)} is waiting for someone to allow its ${tool} reporting tool (${event.request.name}). The runtime does not answer permissions.`,
          recipient: { agentId: view.leadAgentId, role: 'lead' },
        });
        await controller.notices.notify(loaded, {
          kind: 'awaiting-permission', class: 'operator', disposition: 'operator-now', assignmentId: view.id,
          text: `Allow or deny ${event.request.name} for the Peer of ${assignmentName(view)} (agent ${event.agent.id}) in Paseo.`,
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
