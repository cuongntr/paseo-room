/**
 * Conservative recovery of unresolved intents (docs/design/runtime-coordination.md §6).
 *
 * Runs on plugin start and on relevant lifecycle or RPC activity — never as a polling patrol.
 * Each unresolved intent is settled only from bounded live evidence: an exact labelled child for
 * a create, the exact message id in a timeline for a prompt, a closed live status for an
 * archive, a published sidecar for a gate. Ambiguous evidence stays uncertain. Recovery never
 * adopts an agent by title or cwd, never resends a prompt, never opens a later generation and
 * never signals a process.
 */
import type { Controller, LoadedProject } from './controller.js';
import type { AssignmentView } from './domain/state.js';
import { recoverGate } from './gate.js';
import { checkLeadOwnership } from './ownership.js';
import { ASSIGNMENT_LABEL, PARENT_AGENT_ID_LABEL } from './paseo-port.js';
import { ProjectStore } from './store/project.js';

export interface RecoveryAction {
  readonly assignmentId: string;
  readonly intent: string;
  readonly outcome: 'succeeded' | 'failed' | 'uncertain' | 'archived-unbound' | 'unchanged';
  readonly detail: string;
}

export interface RecoveryReport {
  readonly projectId: string;
  readonly paused: boolean;
  readonly actions: readonly RecoveryAction[];
}

const plugin = { source: 'plugin' as const };

function lastIntent(loaded: LoadedProject, assignmentId: string, type: 'archive.requested'): string | undefined {
  const event = loaded.events.filter(entry => entry.assignmentId === assignmentId && entry.type === type).at(-1);
  return event?.type === 'archive.requested' ? event.data.intentId : undefined;
}

export class Recovery {
  constructor(private readonly controller: Controller) {}

  async recoverAll(): Promise<RecoveryReport[]> {
    const stores = await ProjectStore.list(this.controller.deps.runtimeRoot, this.controller.deps.now);
    const reports: RecoveryReport[] = [];
    for (const store of stores) reports.push(await this.recoverProject(store));
    return reports;
  }

  /** Recovery for the project that owns a Paseo agent, when a lifecycle event names it. */
  async recoverForAgent(agentId: string): Promise<RecoveryReport | undefined> {
    for (const store of await ProjectStore.list(this.controller.deps.runtimeRoot, this.controller.deps.now)) {
      const loaded = await this.controller.load(store);
      if (loaded.ok && [...loaded.value.state.assignments.values()].some(view => view.peerAgentId === agentId)) {
        return await this.recoverProject(store);
      }
    }
    return undefined;
  }

  async recoverProject(store: ProjectStore): Promise<RecoveryReport> {
    return await this.controller.serial(store.meta.projectId, async () => {
      const loaded = await this.controller.load(store);
      if (!loaded.ok) return { projectId: store.meta.projectId, paused: true, actions: [] };
      const actions: RecoveryAction[] = [];
      for (const view of [...loaded.value.state.assignments.values()]) {
        for (const [intentId, type] of Object.entries(view.openIntents)) {
          const current = loaded.value.state.assignments.get(view.id) ?? view;
          if (type === 'agent.create-requested') actions.push(await this.recoverCreate(loaded.value, current, intentId));
          else if (type === 'run.requested') actions.push(await this.recoverRun(loaded.value, current, intentId));
          else if (type === 'archive.requested') actions.push(await this.recoverArchive(loaded.value, current, intentId));
        }
        const current = loaded.value.state.assignments.get(view.id) ?? view;
        if (current.closure === 'uncertain' && !Object.values(current.openIntents).includes('archive.requested')) {
          const intentId = lastIntent(loaded.value, current.id, 'archive.requested');
          if (intentId !== undefined) actions.push(await this.recoverArchive(loaded.value, current, intentId));
        }
        const running = (loaded.value.state.assignments.get(view.id) ?? view).gates.filter(run => run.status === 'running' && !this.controller.activeGates.has(run.gateRunId));
        for (const gate of running) {
          actions.push(await this.recoverGateRun(loaded.value, view.id, gate.gateRunId));
        }
        const unsettled = (loaded.value.state.assignments.get(view.id) ?? view).gates.filter(run => run.status === 'uncertain');
        for (const gate of unsettled) {
          const late = await recoverGate(gate.gateRunId, loaded.value.store.gatesDirectory);
          if (late.status === 'finished') {
            await this.controller.append(loaded.value, { type: 'gate.finished', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { result: late.result } });
            actions.push({ assignmentId: view.id, intent: gate.gateRunId, outcome: 'succeeded', detail: 'A late gate result sidecar settled the gate.' });
          }
        }
      }
      await this.controller.notices.retryUndelivered(loaded.value);
      await checkLeadOwnership(this.controller, this.controller.notices, loaded.value);
      return { projectId: store.meta.projectId, paused: false, actions };
    });
  }

  /** Searches only from the unresolved create intent: exact provider, parent and assignment label. */
  private async recoverCreate(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const agents = await this.controller.deps.paseo.listAgents();
    const matches = agents.filter(agent =>
      agent.labels[ASSIGNMENT_LABEL] === view.id && agent.provider === view.peerProviderId && agent.labels[PARENT_AGENT_ID_LABEL] === view.leadAgentId);
    if (matches.length === 0) {
      await this.controller.append(loaded, { type: 'agent.create-failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, reason: 'No agent carries this assignment\'s label.' } });
      return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: 'The Peer was never created.' };
    }
    const [only] = matches;
    if (matches.length > 1 || only === undefined || only.lastUserMessageAt !== null) {
      return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: matches.length > 1 ? 'Several agents carry this assignment\'s label.' : 'The labelled agent has already received a prompt.' };
    }
    // A matching child with no prior prompt is archived, never adopted or prompted.
    await this.controller.append(loaded, { type: 'agent.create-succeeded', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { intentId, agentId: only.id } });
    await this.controller.append(loaded, { type: 'binding.refused', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { agentId: only.id, reason: 'Recovered after an interrupted dispatch; recovery never adopts a Peer.' } });
    await this.controller.archiveUnbound(loaded, view.id, only.id);
    return { assignmentId: view.id, intent: intentId, outcome: 'archived-unbound', detail: `Archived recovered child ${only.id}.` };
  }

  /** Delivery is proven only by the exact message id in the Peer's timeline. */
  private async recoverRun(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const agentId = view.peerAgentId;
    const generation = view.runGeneration;
    if (agentId === undefined) return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: 'No bound Peer.' };
    const delivered = await this.controller.deps.paseo.promptDelivered(agentId, `${view.id}-g${String(generation)}`);
    if (delivered === 'delivered') {
      await this.controller.append(loaded, { type: 'run.succeeded', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { intentId, generation } });
      return { assignmentId: view.id, intent: intentId, outcome: 'succeeded', detail: 'The prompt is in the Peer\'s timeline.' };
    }
    if (delivered === 'absent') {
      await this.controller.append(loaded, { type: 'run.failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, generation, reason: 'The prompt is not in the Peer\'s complete timeline.' } });
      return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: 'The prompt never reached the Peer.' };
    }
    return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: 'The Peer\'s timeline is incomplete.' };
  }

  /** Writer release needs archive plus a closed live status; anything else stays uncertain. */
  private async recoverArchive(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const agentId = view.peerAgentId;
    if (agentId === undefined) return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: 'No managed Peer.' };
    const snapshot = await this.controller.deps.paseo.getAgent(agentId);
    if (snapshot?.status === 'closed' && snapshot.archivedAt !== null) {
      await this.controller.append(loaded, { type: 'archive.succeeded', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { intentId, agentId, archivedAt: snapshot.archivedAt, liveStatus: 'closed' } });
      const owner = loaded.state.ownership.get(view.id);
      if (owner !== undefined && (owner.state === 'releasing' || owner.state === 'uncertain')) {
        await this.controller.append(loaded, { type: 'ownership.released', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { agentId, archivedAt: snapshot.archivedAt } });
      }
      return { assignmentId: view.id, intent: intentId, outcome: 'succeeded', detail: 'The Peer is archived and closed.' };
    }
    if (snapshot !== undefined && snapshot.archivedAt === null && view.openIntents[intentId] === 'archive.requested') {
      await this.controller.append(loaded, { type: 'archive.failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, agentId, reason: `The Peer is ${snapshot.status} and not archived.` } });
      const owner = loaded.state.ownership.get(view.id);
      if (owner !== undefined && owner.state !== 'released' && owner.state !== 'uncertain') {
        await this.controller.append(loaded, { type: 'ownership.uncertain', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { reason: 'Archive did not take effect.' } });
      }
      return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: 'The Peer is still live; Lead may close again.' };
    }
    return { assignmentId: view.id, intent: intentId, outcome: 'unchanged', detail: snapshot === undefined ? 'Paseo no longer knows the Peer; its stop cannot be proven.' : 'The archive is still unconfirmed.' };
  }

  private async recoverGateRun(loaded: LoadedProject, assignmentId: string, gateRunId: string): Promise<RecoveryAction> {
    const outcome = await recoverGate(gateRunId, loaded.store.gatesDirectory);
    if (outcome.status === 'finished') {
      await this.controller.append(loaded, { type: 'gate.finished', payloadVersion: 1, assignmentId, actor: plugin, data: { result: outcome.result } });
      return { assignmentId, intent: gateRunId, outcome: 'succeeded', detail: 'The gate result sidecar was published.' };
    }
    const reason = outcome.status === 'uncertain' ? outcome.reason : outcome.message;
    await this.controller.append(loaded, { type: 'gate.uncertain', payloadVersion: 1, assignmentId, actor: plugin, data: { gateRunId, reason } });
    return { assignmentId, intent: gateRunId, outcome: 'uncertain', detail: reason };
  }
}
