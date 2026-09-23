/**
 * Conservative recovery of unresolved intents (docs/design/runtime-coordination.md §6).
 *
 * Runs on plugin start and on relevant lifecycle or RPC activity — never as a polling patrol.
 * Each unresolved intent is settled only from bounded live evidence: an exact labelled child for
 * a create, the exact message id in a timeline for a prompt, a closed live status for an
 * archive, a published sidecar for a gate. Ambiguous evidence stays uncertain. Recovery never
 * adopts an agent by title or cwd, never resends a prompt, never opens a later generation and
 * never signals a process.
 *
 * Paseo's lifecycle events are fire-and-forget, so a Peer turn that ends while this plugin is down
 * is never announced. Recovery judges such a turn exactly as the turn-end handler would, but only
 * on live proof that it is over: the delivered prompt of the open generation, no active turn, and
 * a record Paseo changed after that prompt arrived.
 *
 * Phase 2 rows (docs/design/runtime-coordination-phase2.md §7): an unresolved worktree create is
 * reissued with its recorded id and key and then closed, never adopted — or recorded as failed
 * when Paseo's receipt replays a failure and it lists no such workspace; an unresolved close is
 * settled by Paseo no longer listing the workspace, plus whether its directory is gone; a lease
 * whose Peer died waits for an explicit reclaim. Nothing is settled by elapsed time.
 */
import type { Controller, LoadedProject } from './controller.js';
import type { AssignmentView } from './domain/state.js';
import { recoverGate } from './gate.js';
import { settleEndedTurn } from './handlers/turns.js';
import { checkLeadOwnership } from './ownership.js';
import { ASSIGNMENT_LABEL, CreationConflictError, PARENT_AGENT_ID_LABEL, type AgentSnapshot, type WorkspaceSnapshot } from './paseo-port.js';
import type { Spool } from './spool.js';
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
  constructor(private readonly controller: Controller, private readonly spool?: Spool) {}

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
          else if (type === 'workspace.create-requested') actions.push(await this.recoverWorkspaceCreate(loaded.value, current, intentId));
          else if (type === 'workspace.close-requested') actions.push(await this.recoverWorkspaceClose(loaded.value, current, intentId));
        }
        const ended = await this.recoverEndedTurn(loaded.value, loaded.value.state.assignments.get(view.id) ?? view);
        if (ended !== undefined) actions.push(ended);
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

  /**
   * Searches only from the unresolved create intent. When the intent recorded the agent id the
   * runtime chose, that exact id decides; a create recorded without one (a Phase 1 ledger), or
   * whose id Paseo does not know, falls back to exact provider, parent and assignment label.
   */
  private async recoverCreate(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const requested = loaded.events.find(event => event.type === 'agent.create-requested' && event.assignmentId === view.id && event.data.intentId === intentId);
    const chosen = requested?.type === 'agent.create-requested' ? requested.data.agentId : undefined;
    const exact = chosen === undefined ? undefined : await this.controller.deps.paseo.getAgent(chosen);
    const ours = (agent: AgentSnapshot): boolean =>
      agent.labels[ASSIGNMENT_LABEL] === view.id && agent.provider === view.peerProviderId && agent.labels[PARENT_AGENT_ID_LABEL] === view.leadAgentId;
    const lease = loaded.state.ownership.get(view.id)?.lease;
    if (exact !== undefined && lease !== undefined && exact.workspaceId !== lease.workspaceId) {
      return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: `Agent ${exact.id} sits in workspace ${String(exact.workspaceId)}, not its lease's ${lease.workspaceId}.` };
    }
    if (exact !== undefined && !ours(exact)) {
      return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: `Agent ${exact.id} does not carry this assignment's provider, parent and label.` };
    }
    const matches = exact !== undefined ? [exact] : (await this.controller.deps.paseo.listAgents()).filter(ours);
    if (matches.length === 0) {
      await this.controller.append(loaded, { type: 'agent.create-failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, reason: 'No agent carries this assignment\'s label.' } });
      // A lease released this way never had a Peer: its worktree closes like any other.
      await this.controller.afterRelease(loaded, view.id);
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

  /** A turn whose end nobody announced: judged only once live evidence proves it is over. */
  private async recoverEndedTurn(loaded: LoadedProject, view: AssignmentView): Promise<RecoveryAction | undefined> {
    const agentId = view.peerAgentId;
    if (this.spool === undefined || agentId === undefined || view.reportingState !== 'open') return undefined;
    if ((view.state !== 'active' && view.state !== 'awaiting-permission') || Object.values(view.openIntents).includes('run.requested')) return undefined;
    const live = await this.controller.deps.paseo.getAgent(agentId);
    if (live === undefined || !turnIsOver(live)) return undefined;
    const intent = `turn-g${String(view.runGeneration)}`;
    if (await this.controller.deps.paseo.promptDelivered(agentId, `${view.id}-g${String(view.runGeneration)}`) !== 'delivered') return undefined;
    const outcome = await settleEndedTurn(this.controller, this.spool, loaded, view, agentId);
    if (outcome === 'missing') return { assignmentId: view.id, intent, outcome: 'failed', detail: 'The Peer turn ended unannounced, without an accepted report.' };
    if (outcome === 'uncertain') return { assignmentId: view.id, intent, outcome: 'uncertain', detail: 'The Peer turn ended unannounced with a report still unresolved.' };
    return { assignmentId: view.id, intent, outcome: 'unchanged', detail: 'The Peer is waiting on a reporting permission.' };
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
        await this.controller.afterRelease(loaded, view.id);
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

  /**
   * Reissues the identical worktree request with the recorded id and key (delta P2-D3, §7):
   * Paseo's receipt returns the workspace it already made, or makes it once. Recovery never
   * adopts a worktree — Lead was never told the dispatch succeeded — so it is refused and closed.
   */
  private async recoverWorkspaceCreate(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const record = loaded.state.workspaces.get(view.id);
    if (record === undefined) return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: 'No worktree record.' };
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await this.controller.deps.paseo.createWorktreeWorkspace({
        workspaceId: record.workspaceId, idempotencyKey: record.idempotencyKey, title: `room ${view.id}`, cwd: loaded.store.meta.canonicalRoot,
        baseCommit: record.baseCommit, branchName: record.branchName, worktreeSlug: record.worktreeSlug,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
      if (error instanceof CreationConflictError) {
        await this.controller.append(loaded, { type: 'workspace.create-failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, reason } });
        return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: `Paseo refused the recorded request: ${reason}` };
      }
      // Paseo's receipt replays a definite failure as an error too. With no active workspace of
      // this id there is nothing a Peer could have been placed in, so the create failed; a
      // listed one is refused and closed like any recovered worktree. An unreadable list decides
      // nothing.
      const live = await this.controller.deps.paseo.getWorkspace(record.workspaceId).catch(() => null);
      if (live === undefined) {
        await this.controller.append(loaded, { type: 'workspace.create-failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, reason: `The reissued request failed (${reason}) and Paseo lists no workspace ${record.workspaceId}.`.slice(0, 1_000) } });
        return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: 'Paseo holds a failure for the recorded request and no such workspace.' };
      }
      if (live === null) return { assignmentId: view.id, intent: intentId, outcome: 'unchanged', detail: `The reissued request was not confirmed: ${reason}` };
      snapshot = live;
    }
    if (snapshot.id !== record.workspaceId) {
      return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: `Paseo answered with workspace ${snapshot.id}, not ${record.workspaceId}.` };
    }
    await this.controller.append(loaded, { type: 'workspace.create-refused', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, workspaceId: record.workspaceId, reason: 'Recovered after an interrupted dispatch; recovery never adopts a worktree.' } });
    const closed = await this.controller.closeWorkspace(loaded, view.id, { discardUncommitted: false, reason: 'Recovered after an interrupted dispatch; no Peer was ever placed in it.' }).catch(() => undefined);
    return { assignmentId: view.id, intent: intentId, outcome: 'archived-unbound', detail: `Closed recovered worktree ${record.workspaceId}${closed?.ok === true ? '' : ' (close unconfirmed)'}.` };
  }

  /** A close is settled only by Paseo no longer listing the workspace; a live one failed. */
  private async recoverWorkspaceClose(loaded: LoadedProject, view: AssignmentView, intentId: string): Promise<RecoveryAction> {
    const record = loaded.state.workspaces.get(view.id);
    if (record === undefined) return { assignmentId: view.id, intent: intentId, outcome: 'uncertain', detail: 'No worktree record.' };
    const live = await this.controller.deps.paseo.getWorkspace(record.workspaceId);
    if (live !== undefined && !live.archiving) {
      await this.controller.append(loaded, { type: 'workspace.close-failed', payloadVersion: 1, assignmentId: view.id, actor: plugin, data: { intentId, workspaceId: record.workspaceId, reason: 'Paseo still lists the workspace as active.' } });
      return { assignmentId: view.id, intent: intentId, outcome: 'failed', detail: 'The worktree is still open; it may be closed again.' };
    }
    if (live !== undefined) return { assignmentId: view.id, intent: intentId, outcome: 'unchanged', detail: 'Paseo is still archiving the workspace.' };
    const directoryRemoved = record.worktreePath === undefined || !await this.controller.deps.git.directoryPresent(record.worktreePath);
    // Paseo lists only active workspaces, so the archive time is known only as "by now".
    const archivedAt = (this.controller.deps.now?.() ?? new Date()).toISOString();
    await this.controller.append(loaded, { type: 'workspace.close-succeeded', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { intentId, workspaceId: record.workspaceId, archivedAt, directoryRemoved } });
    return { assignmentId: view.id, intent: intentId, outcome: 'succeeded', detail: directoryRemoved ? 'The worktree is closed and its directory removed.' : 'The worktree is closed but its directory remains for cleanup.' };
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

/** No turn is running and Paseo changed the record after the last prompt arrived. */
function turnIsOver(live: AgentSnapshot): boolean {
  if (live.activeTurn || (live.status !== 'idle' && live.status !== 'error' && live.status !== 'closed')) return false;
  if (live.lastUserMessageAt === null) return false;
  return Date.parse(live.updatedAt) > Date.parse(live.lastUserMessageAt);
}
