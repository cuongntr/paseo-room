/**
 * The runtime controller (docs/design/runtime-coordination.md §3.3, §5, §6).
 *
 * Every mutation follows one shape: validate against the current projection, record the
 * intent, perform the external effect through the Paseo port, and record the proven result.
 * A crash between those steps leaves an unresolved intent that recovery settles from live
 * evidence; the controller never guesses and never rolls anything back. Operations on one
 * project are serialized in this process, and each append is checked against the projection
 * so an illegal transition can never reach the ledger.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { QUALIFIED_WORKTREE_DAEMONS } from '../shared/identity.js';
import type { RuntimeRole } from '../shared/policy.js';
import { renderBrief, renderContinuation } from './brief.js';
import { mintCapability, publishCapability } from './capabilities.js';
import type { CorrelationRegistry } from './correlations.js';
import { evaluateAcceptance } from './domain/acceptance.js';
import { sha256 } from './domain/receipts.js';
import { normalizeScope, parseScope } from './domain/scope.js';
import { activeLeases, applyEvent, checkEvent, leadWorkspaceWriter, leaseCollision, project, type AssignmentView, type ProjectState } from './domain/state.js';
import { validateAssignmentCreate } from './domain/validate.js';
import { EVENT_SCHEMA, type RuntimeEventV1 } from './events/schema.js';
import { gateRequestedData, runGate, type GateEvent, type GateOutcome, type GateRequest } from './gate.js';
import type { GitEvidence, WorktreeProof } from './git.js';
import { hostPaseoVersion } from './host.js';
import { Notices } from './notices.js';
import { checkLeadOwnership } from './ownership.js';
import {
  ASSIGNMENT_LABEL, CreationConflictError, PARENT_AGENT_ID_LABEL, type AgentSnapshot, type PaseoPort, type PeerLaunch, type WorkspaceSnapshot,
} from './paseo-port.js';
import type { Recognition } from './recognition.js';
import { ProjectStore, type NewEvent } from './store/project.js';

/** A seat whose identity the bridge layer has already corroborated from live Paseo facts. */
export interface Caller {
  readonly agentId: string;
  readonly providerId: string;
  readonly role: RuntimeRole;
  readonly workspaceId: string | null;
  readonly cwd: string;
}

export type ControllerResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly retryable: boolean };

export interface ControllerDependencies {
  readonly runtimeRoot: string;
  readonly paseo: PaseoPort;
  readonly git: GitEvidence;
  readonly recognition: Recognition;
  readonly correlations: CorrelationRegistry;
  readonly now?: () => Date;
  /** How long dispatch waits for the created Peer's session to associate its correlation. */
  readonly associationWaitMs?: number;
  /** The hosting daemon's version; read from Paseo's own package when not supplied. */
  readonly daemonVersion?: () => string | undefined;
  /** Versions on which worktree dispatch is qualified; `QUALIFIED_WORKTREE_DAEMONS` when not supplied. */
  readonly qualifiedDaemons?: readonly string[];
}

export interface LoadedProject {
  readonly store: ProjectStore;
  readonly state: ProjectState;
  readonly events: RuntimeEventV1[];
}

export interface DispatchInput {
  readonly assignmentId: string;
  readonly peerProvider: string;
  readonly isolation?: 'lead-workspace' | 'worktree' | undefined;
  readonly serialOnly?: readonly string[] | undefined;
}

/** A worktree lease decided before anything is recorded. */
interface LeaseRequest {
  readonly workspaceId: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly scopes: readonly string[];
  readonly serialOnly: readonly string[];
}

export const refuse = <T>(code: string, message: string, retryable = false): ControllerResult<T> => ({ ok: false, code, message, retryable });
const done = <T>(value: T): ControllerResult<T> => ({ ok: true, value });

function token(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function peerTitle(assignmentId: string): string {
  return `Peer ${assignmentId}`;
}

export class Controller {
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly notices: Notices;

  constructor(readonly deps: ControllerDependencies) {
    this.notices = new Notices(this);
  }

  get capabilitiesDirectory(): string {
    return join(this.deps.runtimeRoot, 'capabilities');
  }

  /** Runs `work` after every earlier operation on the same project in this process. */
  serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(key, next.catch(() => undefined));
    return next;
  }

  /** The project bound to the Git repository at `cwd`, created on first use. */
  async projectFor(cwd: string): Promise<ProjectStore> {
    const identity = await this.deps.git.identity(cwd);
    return await ProjectStore.find(this.deps.runtimeRoot, identity.gitCommonDir, this.deps.now)
      ?? await ProjectStore.create(this.deps.runtimeRoot, identity, this.deps.now);
  }

  private readonly assignmentProjects = new Map<string, string>();

  /** The project that records an assignment, remembered after the first lookup. */
  async locateAssignment(assignmentId: string): Promise<ProjectStore | undefined> {
    const stores = await ProjectStore.list(this.deps.runtimeRoot, this.deps.now);
    const known = this.assignmentProjects.get(assignmentId);
    const ordered = known === undefined ? stores : [...stores.filter(store => store.meta.projectId === known), ...stores.filter(store => store.meta.projectId !== known)];
    for (const store of ordered) {
      const { events } = await store.replay();
      if (events.some(event => event.type === 'assignment.created' && event.assignmentId === assignmentId)) {
        this.assignmentProjects.set(assignmentId, store.meta.projectId);
        return store;
      }
    }
    return undefined;
  }

  /** Replays a project; a paused or inconsistent ledger refuses every mutation. */
  async load(store: ProjectStore): Promise<ControllerResult<LoadedProject>> {
    const replay = await store.replay();
    if (replay.status !== 'ok') {
      return refuse('project_paused', `Project ${store.meta.projectId} is paused: ${replay.problems.map(problem => `${problem.file} ${problem.reason}`).join('; ')}.`);
    }
    const projection = project(store.meta.projectId, replay.events);
    if (projection.violations.length > 0) {
      return refuse('project_paused', `Project ${store.meta.projectId} has an inconsistent ledger at ${projection.violations[0]?.eventId ?? 'unknown'}.`);
    }
    return done({ store, state: projection.state, events: [...replay.events] });
  }

  /** Checks an event against the projection, persists it, and folds it in. */
  async append(loaded: LoadedProject, event: NewEvent): Promise<RuntimeEventV1> {
    const probe = {
      ...event, schema: EVENT_SCHEMA, version: 1, id: 'evt_probe00000000', sequence: loaded.state.lastSequence + 1,
      projectId: loaded.store.meta.projectId, occurredAt: new Date(0).toISOString(),
    } as RuntimeEventV1;
    const problem = checkEvent(loaded.state, probe);
    if (problem !== undefined) throw new Error(`Refusing ${event.type}: ${problem}`);
    const persisted = await loaded.store.append(event);
    applyEvent(loaded.state, persisted);
    loaded.events.push(persisted);
    return persisted;
  }

  private plugin = { source: 'plugin' as const };

  /** Lead creates a typed assignment in its own project. Nothing is dispatched yet. */
  async createAssignment(caller: Caller, raw: unknown): Promise<ControllerResult<{ readonly assignmentId: string }>> {
    if (caller.role !== 'lead') return refuse('unauthorized', 'Only Lead creates assignments.');
    const validation = validateAssignmentCreate(raw);
    if (!validation.ok) {
      return refuse(validation.errors[0]?.code ?? 'assignment_malformed', validation.errors.map(error => `${error.field}: ${error.message}`).join(' '));
    }
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const loaded = await this.load(store);
      if (!loaded.ok) return loaded;
      const assignmentId = token('asg');
      await this.append(loaded.value, {
        type: 'assignment.created', payloadVersion: 1, assignmentId,
        actor: { source: 'seat', role: 'lead', agentId: caller.agentId, providerId: caller.providerId },
        data: { input: validation.input, leadAgentId: caller.agentId, leadProviderId: caller.providerId },
      });
      return done({ assignmentId });
    });
  }

  /** Finds the caller's own assignment in the caller's project. */
  async leadAssignment(caller: Caller, assignmentId: string): Promise<ControllerResult<{ readonly loaded: LoadedProject; readonly view: AssignmentView }>> {
    if (caller.role !== 'lead') return refuse('unauthorized', 'Only Lead manages assignments.');
    const store = await this.projectFor(caller.cwd);
    const loaded = await this.load(store);
    if (!loaded.ok) return loaded;
    const view = loaded.value.state.assignments.get(assignmentId);
    if (view === undefined) return refuse('assignment_unknown', `No assignment ${assignmentId} in this project.`);
    if (view.leadAgentId !== caller.agentId) return refuse('unauthorized', `Assignment ${assignmentId} belongs to another Lead.`);
    return done({ loaded: loaded.value, view });
  }

  private async waitForAssociation(assignmentId: string, agentId: string): Promise<string | undefined> {
    const deadline = Date.now() + (this.deps.associationWaitMs ?? 5_000);
    for (;;) {
      const id = this.deps.correlations.forAssignment(assignmentId);
      const association = id === undefined ? undefined : await this.deps.correlations.lookup(id);
      if (association !== undefined) return association.agentId === agentId ? association.correlationId : undefined;
      if (Date.now() >= deadline) return undefined;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /** A fresh snapshot, re-read briefly while the agent is still initializing. */
  private async settledSnapshot(agentId: string): Promise<AgentSnapshot | undefined> {
    const deadline = Date.now() + (this.deps.associationWaitMs ?? 5_000);
    for (;;) {
      const snapshot = await this.deps.paseo.getAgent(agentId);
      if (snapshot?.status !== 'initializing' || Date.now() >= deadline) return snapshot;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /** The fresh-snapshot proof a Peer must pass before anything is sent to it. */
  bindingProblem(snapshot: AgentSnapshot | undefined, expected: { readonly providerId: string; readonly leadAgentId: string; readonly workspaceId: string | null; readonly assignmentId: string }): string | undefined {
    if (snapshot === undefined) return 'Paseo does not know the created agent.';
    if (snapshot.provider !== expected.providerId) return `The agent runs provider ${snapshot.provider}, not ${expected.providerId}.`;
    if (snapshot.labels[PARENT_AGENT_ID_LABEL] !== expected.leadAgentId) return 'The agent is not the Lead\'s child.';
    if (snapshot.labels[ASSIGNMENT_LABEL] !== expected.assignmentId) return 'The agent does not carry this assignment\'s label.';
    if (expected.workspaceId !== null && snapshot.workspaceId !== expected.workspaceId) return `The agent opened in workspace ${String(snapshot.workspaceId)}, not ${expected.workspaceId}.`;
    if (snapshot.status !== 'idle' || snapshot.activeTurn) return `The agent is ${snapshot.status}${snapshot.activeTurn ? ' with an active turn' : ''}, not idle.`;
    if (snapshot.lastUserMessageAt !== null) return 'The agent already received a prompt.';
    if (snapshot.archivedAt !== null) return 'The agent is archived.';
    return undefined;
  }

  /**
   * Opens the next reporting generation, records the run intent (projecting `active` before
   * the external call), publishes the generation's capability, then sends the prompt.
   */
  async beginTurn(loaded: LoadedProject, view: AssignmentView, correlationId: string, turn: 'initial' | 'answer' | 'rework' | 'follow-up', prompt: string): Promise<ControllerResult<{ readonly generation: number }>> {
    const peerAgentId = view.peerAgentId;
    if (peerAgentId === undefined) return refuse('peer_missing', 'The assignment has no bound Peer.');
    const generation = view.reportingGeneration + 1;
    const issued = mintCapability(generation);
    await this.append(loaded, { type: 'reporting.generation-opened', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { generation, capabilityHash: issued.hash, turn } });
    const intentId = token('run');
    await this.append(loaded, { type: 'run.requested', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, idempotencyKey: intentId, data: { intentId, generation, promptDigest: sha256(prompt) } });
    await publishCapability(this.capabilitiesDirectory, correlationId, issued);
    try {
      await this.deps.paseo.run(peerAgentId, prompt, `${view.id}-g${String(generation)}`);
    } catch (error) {
      // Delivery may or may not have happened: recovery decides from timeline evidence.
      await this.append(loaded, { type: 'run.uncertain', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { intentId, generation, reason: error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown' } });
      return refuse('run_uncertain', 'The prompt may not have reached the Peer; recovery will confirm before anything else is sent.', true);
    }
    await this.append(loaded, { type: 'run.succeeded', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { intentId, generation } });
    return done({ generation });
  }

  /**
   * Two-step dispatch (§3.3, §5.3): prove a clean base, reserve ownership, create the Peer with
   * no prompt, prove its identity from a fresh snapshot, publish the binding and held
   * ownership, and only then send the brief as a separate first turn.
   *
   * With `isolation: 'worktree'` (Phase 2 delta §6) the reservation carries a writer lease, and a
   * runtime-requested worktree proven by Git replaces Lead's workspace. Every worktree refusal is
   * decided on the project's projection before anything is recorded or asked of Paseo.
   */
  async dispatch(caller: Caller, input: DispatchInput): Promise<ControllerResult<{ readonly agentId: string; readonly generation: number }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, input.assignmentId);
      if (!found.ok) return found;
      const { loaded, view } = found.value;
      if (!this.deps.recognition.peerProviders().includes(input.peerProvider)) {
        return refuse('peer_provider_ineligible', `${input.peerProvider} is not an eligible room Peer provider.`);
      }
      if (view.state !== 'draft') return refuse('assignment_state', `Assignment ${view.id} is ${view.state}; only a draft is dispatched.`);
      const writable = view.input.mode === 'writable';
      const isolated = input.isolation === 'worktree';
      if (!isolated && input.serialOnly !== undefined) return refuse('isolation_required', 'serialOnly applies only to isolation "worktree"; a writer in your workspace already excludes every other writer.');
      if (isolated && !writable) return refuse('isolation_not_writable', 'Only a writable assignment is dispatched into its own worktree; read-only work never holds a writer lease.');
      const lease = isolated ? await this.worktreeRefusal(loaded, view, input.serialOnly ?? []) : undefined;
      if (lease !== undefined && !lease.ok) return lease;
      if (writable && !isolated && leadWorkspaceWriter(loaded.state) === undefined && activeLeases(loaded.state).length > 0) {
        return refuse('writer_exclusive', 'Isolated writers are still active, and a writer in your workspace excludes every other writer. Dispatch it with isolation "worktree", or wait until they are released.');
      }
      // Duplicate Leads are detected from live evidence before anything is reserved.
      if (await checkLeadOwnership(this, this.notices, loaded) === 'conflict') {
        return refuse('ownership_conflict', 'Another active Lead claims this project; dispatch is paused until the owner is confirmed.');
      }
      if (writable && !isolated) {
        const base = await this.deps.git.dispatchPrecondition(caller.cwd, { gitCommonDir: loaded.store.meta.gitCommonDir, baseCommit: view.input.baseCommit });
        if (!base.ok) return refuse({ 'wrong-repository': 'base_wrong_repository', 'base-mismatch': 'base_moved', dirty: 'base_dirty' }[base.code], base.message);
      }
      // The launch settings are operator-owned; without a model the runtime refuses, before
      // recording anything.
      const launch = await this.deps.paseo.resolveLaunch(input.peerProvider);
      if (launch === undefined) {
        return refuse('peer_model_unresolved', `${input.peerProvider} has no default model and its room profile sets none; set one in Paseo before dispatching.`);
      }
      const workspaceId = lease?.value.workspaceId ?? caller.workspaceId ?? 'unknown';
      const lead = this.lead(caller);
      try {
        await this.append(loaded, { type: 'assignment.dispatch-requested', payloadVersion: 1, assignmentId: view.id, actor: lead, data: { peerProviderId: input.peerProvider, workspaceId } });
      } catch (error) {
        return refuse('dispatch_refused', error instanceof Error ? error.message : String(error));
      }
      if (writable) {
        await this.append(loaded, { type: 'ownership.reserved', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { workspaceId, baseCommit: view.input.baseCommit } });
      }
      if (lease === undefined) {
        return await this.launchPeer(loaded, view.id, { caller, provider: input.peerProvider, launch, placement: { kind: 'lead-workspace', cwd: caller.cwd, workspaceId: caller.workspaceId } });
      }
      await this.append(loaded, { type: 'lease.reserved', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { ...lease.value, epoch: 1 } });
      const worktree = await this.createWorktree(loaded, view.id, caller);
      if (!worktree.ok) return worktree;
      return await this.launchPeer(loaded, view.id, { caller, provider: input.peerProvider, launch, placement: { kind: 'worktree', workspaceId, path: worktree.value.path, branch: worktree.value.branch } });
    });
  }

  /**
   * The worktree refusals of delta §5.3 and §8, in order: a qualified daemon, observable setup,
   * canonical scopes, then collision on this projection. Nothing is recorded or asked of Paseo.
   */
  private async worktreeRefusal(loaded: LoadedProject, view: AssignmentView, serialOnly: readonly string[]): Promise<ControllerResult<LeaseRequest>> {
    const version = (this.deps.daemonVersion ?? hostPaseoVersion)();
    const qualified = this.deps.qualifiedDaemons ?? QUALIFIED_WORKTREE_DAEMONS;
    if (version === undefined || !qualified.includes(version)) {
      return refuse('worktree_unqualified', `Worktree dispatch has not been qualified on Paseo ${version ?? '(unknown version)'}; dispatch without isolation.`);
    }
    const root = loaded.store.meta.canonicalRoot;
    if (!await this.deps.git.hasCommit(root, view.input.baseCommit)) return refuse('base_unknown', `The base ${view.input.baseCommit} is not a commit of this repository.`);
    const setup = await this.deps.git.setupDeclared(root, view.input.baseCommit);
    if (setup === 'declared' || setup === 'unreadable') {
      return refuse('worktree_setup_unobservable', setup === 'declared'
        ? 'paseo.json at the base declares worktree.setup, which Paseo runs in the background where the runtime cannot observe it finishing; dispatch without isolation.'
        : 'paseo.json at the base cannot be read, so worktree setup cannot be ruled out; dispatch without isolation.');
    }
    const scopes: string[] = [];
    for (const [field, raws, target] of [['writeScope', view.input.writeScope, scopes], ['serialOnly', serialOnly, [] as string[]]] as const) {
      for (const raw of raws) {
        const parsed = parseScope(raw);
        if (!parsed.ok) return refuse('scope_not_canonical', `${field} item ${JSON.stringify(parsed.item)} ${parsed.reason}; an isolated dispatch needs repository-relative paths and globs.`);
        target.push(parsed.entry.text);
      }
    }
    const normalizedSerial = serialOnly.map(raw => normalizeScope(raw));
    const collision = leaseCollision(loaded.state, view.id, { scopes, serialOnly: normalizedSerial });
    if (collision !== undefined) return refuse(collision.code, `${collision.message} Narrow or sequence the work; this refusal is final for this dispatch.`);
    const workspaceId = `wks_${randomBytes(8).toString('hex')}`;
    return done({ workspaceId, branch: `paseo-room/${view.id}`, baseCommit: view.input.baseCommit, scopes, serialOnly: normalizedSerial });
  }

  /**
   * Requests the lease's worktree with the identities recorded before the call, then proves it
   * with Git. A worktree that fails its proof is recorded as refused and closed; no Peer is ever
   * placed in it.
   */
  private async createWorktree(loaded: LoadedProject, assignmentId: string, caller: Caller): Promise<ControllerResult<{ readonly path: string; readonly branch: string }>> {
    const lease = loaded.state.ownership.get(assignmentId)?.lease;
    if (lease === undefined) return refuse('lease_missing', `Assignment ${assignmentId} holds no lease.`);
    const intentId = token('wsc');
    const request = {
      workspaceId: lease.workspaceId, idempotencyKey: `ws-${assignmentId}-e${String(lease.epoch)}`, title: `room ${assignmentId}`,
      cwd: loaded.store.meta.canonicalRoot, baseCommit: lease.baseCommit, branchName: lease.branch, worktreeSlug: assignmentId.toLowerCase(),
    };
    await this.append(loaded, {
      type: 'workspace.create-requested', payloadVersion: 1, assignmentId, actor: this.plugin, idempotencyKey: intentId,
      data: { intentId, workspaceId: request.workspaceId, idempotencyKey: request.idempotencyKey, baseCommit: request.baseCommit, branchName: request.branchName, worktreeSlug: request.worktreeSlug },
    });
    let snapshot: WorkspaceSnapshot;
    try {
      snapshot = await this.deps.paseo.createWorktreeWorkspace(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
      if (error instanceof CreationConflictError) {
        // Paseo created nothing for this request; its receipt belongs to another one.
        await this.append(loaded, { type: 'workspace.create-failed', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, reason } });
        return refuse('workspace_failed', `Paseo refused the worktree request: ${reason}`);
      }
      await this.append(loaded, { type: 'workspace.create-uncertain', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, reason } });
      return refuse('workspace_uncertain', 'Paseo did not confirm the worktree; recovery will reissue the identical request before anything else happens.', true);
    }
    return await this.proveWorktree(loaded, assignmentId, intentId, snapshot, caller.cwd);
  }

  /** The Git proof after creation (P2-D4); shared with recovery, which reissues the same request. */
  async proveWorktree(loaded: LoadedProject, assignmentId: string, intentId: string, snapshot: WorkspaceSnapshot, leadCwd: string): Promise<ControllerResult<{ readonly path: string; readonly branch: string }>> {
    const lease = loaded.state.ownership.get(assignmentId)?.lease;
    if (lease === undefined) return refuse('lease_missing', `Assignment ${assignmentId} holds no lease.`);
    let problem: string | undefined;
    let proof: WorktreeProof | undefined;
    if (snapshot.id !== lease.workspaceId) problem = `Paseo returned workspace ${snapshot.id}, not ${lease.workspaceId}.`;
    else if (snapshot.kind !== 'worktree' || snapshot.directory === null) problem = `Workspace ${snapshot.id} is a ${snapshot.kind} with ${snapshot.directory === null ? 'no directory' : 'a directory'}, not a worktree.`;
    else {
      const leadRoot = await this.deps.git.identity(leadCwd).then(identity => identity.canonicalRoot, () => leadCwd);
      proof = await this.deps.git.provesWorktree(snapshot.directory, { gitCommonDir: loaded.store.meta.gitCommonDir, baseCommit: lease.baseCommit, leadRoot });
      if (!proof.ok) problem = `${proof.code}: ${proof.message}`;
    }
    if (problem !== undefined || proof === undefined || !proof.ok) {
      const reason = (problem ?? 'unknown').slice(0, 1_000);
      await this.append(loaded, { type: 'workspace.create-refused', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, workspaceId: lease.workspaceId, reason } });
      if (snapshot.id === lease.workspaceId) await this.closeWorkspace(loaded, assignmentId, { discardUncommitted: false, reason: 'The worktree failed its proof; no Peer was ever placed in it.' }).catch(() => undefined);
      return refuse('workspace_refused', `The worktree Paseo created failed its proof and was closed without a Peer: ${reason}`);
    }
    const branch = proof.branch ?? lease.branch;
    await this.append(loaded, {
      type: 'workspace.create-succeeded', payloadVersion: 1, assignmentId, actor: { source: 'paseo' },
      data: { intentId, workspaceId: lease.workspaceId, worktreePath: proof.root, branch, headCommit: proof.head },
    });
    return done({ path: proof.root, branch });
  }

  /**
   * Requests a workspace close and records its evidence. Paseo's close runs teardown and removes
   * the directory with `git worktree remove --force`, so callers decide readiness first.
   */
  async closeWorkspace(loaded: LoadedProject, assignmentId: string, decision: { readonly discardUncommitted: boolean; readonly reason?: string }, actor: RuntimeEventV1['actor'] = this.plugin): Promise<ControllerResult<{ readonly directoryRemoved: boolean }>> {
    const record = loaded.state.workspaces.get(assignmentId);
    if (record === undefined) return refuse('workspace_missing', `Assignment ${assignmentId} has no runtime worktree.`);
    const intentId = token('wsx');
    await this.append(loaded, {
      type: 'workspace.close-requested', payloadVersion: 1, assignmentId, actor, idempotencyKey: intentId,
      data: { intentId, workspaceId: record.workspaceId, discardUncommitted: decision.discardUncommitted, ...(decision.reason === undefined ? {} : { reason: decision.reason.slice(0, 1_000) }) },
    });
    let archivedAt: string;
    try {
      archivedAt = (await this.deps.paseo.archiveWorkspace(record.workspaceId)).archivedAt;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown';
      await this.append(loaded, { type: 'workspace.close-uncertain', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, workspaceId: record.workspaceId, reason } });
      return refuse('workspace_close_uncertain', 'Paseo did not confirm the worktree close; recovery will check the live workspace and its directory.', true);
    }
    const directoryRemoved = record.worktreePath === undefined ? !await this.directoryOf(record.workspaceId) : !await this.deps.git.directoryPresent(record.worktreePath);
    await this.append(loaded, { type: 'workspace.close-succeeded', payloadVersion: 1, assignmentId, actor: { source: 'paseo' }, data: { intentId, workspaceId: record.workspaceId, archivedAt, directoryRemoved } });
    return done({ directoryRemoved });
  }

  /** A refused worktree never recorded a path; Paseo's own record is gone once it is archived. */
  private async directoryOf(workspaceId: string): Promise<boolean> {
    const live = await this.deps.paseo.getWorkspace(workspaceId).catch(() => undefined);
    return live?.directory !== undefined && live.directory !== null && await this.deps.git.directoryPresent(live.directory);
  }

  /**
   * Creates the Peer with no prompt, proves its binding from a fresh snapshot, holds writer
   * ownership, and sends the brief as its first turn. Shared by both dispatch modes and reclaim.
   */
  async launchPeer(loaded: LoadedProject, assignmentId: string, request: {
    readonly caller: Caller;
    readonly provider: string;
    readonly launch: PeerLaunch;
    readonly placement:
      | { readonly kind: 'lead-workspace'; readonly cwd: string; readonly workspaceId: string | null }
      | { readonly kind: 'worktree'; readonly workspaceId: string; readonly path: string; readonly branch: string };
    readonly preface?: string;
  }): Promise<ControllerResult<{ readonly agentId: string; readonly generation: number }>> {
    const view = loaded.state.assignments.get(assignmentId);
    if (view === undefined) return refuse('assignment_unknown', `No assignment ${assignmentId}.`);
    const { caller, provider, launch, placement } = request;
    const writable = view.input.mode === 'writable';
    const workspaceId = placement.kind === 'worktree' ? placement.workspaceId : placement.workspaceId ?? 'unknown';
    const title = peerTitle(view.id);
    const intentId = token('create');
    // Identities are chosen and recorded before the call (delta P2-D3, Q-P2-04).
    const identity = { agentId: randomUUID(), idempotencyKey: `${view.id}-g${String(view.reportingGeneration + 1)}-create` };
    this.deps.correlations.expectPeerCreate({ assignmentId: view.id, providerId: provider, title, workKind: view.input.kind });
    await this.append(loaded, {
      type: 'agent.create-requested', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, idempotencyKey: intentId,
      data: { intentId, peerProviderId: provider, workspaceId, parentAgentId: caller.agentId, label: view.id, ...identity },
    });
    const create = { ...launch, provider, parentAgentId: caller.agentId, title, labels: { [ASSIGNMENT_LABEL]: view.id }, ...identity };
    let agentId: string;
    try {
      agentId = placement.kind === 'worktree'
        ? (await this.deps.paseo.createAgentInWorkspace(placement.workspaceId, create)).agentId
        : (await this.deps.paseo.createAgent({ ...create, cwd: placement.cwd })).agentId;
    } catch (error) {
      this.deps.correlations.forgetPeerCreate(provider, title);
      await this.append(loaded, { type: 'agent.create-uncertain', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { intentId, reason: error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown' } });
      return refuse('create_uncertain', 'Paseo did not confirm the Peer; recovery will look for it by its exact id before anything else happens.', true);
    }
    await this.append(loaded, { type: 'agent.create-succeeded', payloadVersion: 1, assignmentId: view.id, actor: { source: 'paseo' }, data: { intentId, agentId } });

    // The session must open (associating the bridge) before the snapshot can prove idleness;
    // an agent still initializing gets a bounded moment to settle, never an adoption.
    let snapshot: AgentSnapshot | undefined;
    let correlationId: string | undefined;
    let problem: string | undefined;
    try {
      correlationId = await this.waitForAssociation(view.id, agentId);
      snapshot = await this.settledSnapshot(agentId);
      // A leased Peer must sit in the lease's workspace, never in Lead's (P2-D8).
      problem = this.bindingProblem(snapshot, { providerId: provider, leadAgentId: caller.agentId, workspaceId: placement.workspaceId, assignmentId: view.id })
        ?? (correlationId === undefined ? 'The Peer\'s reporting bridge never associated with this agent.' : undefined);
    } catch (error) {
      problem = `The created Peer could not be read back from Paseo: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem !== undefined || snapshot === undefined || correlationId === undefined) {
      const reason = (problem ?? 'unknown').slice(0, 1_000);
      await this.append(loaded, { type: 'binding.refused', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { agentId, reason } });
      await this.archiveUnbound(loaded, view.id, agentId).catch(() => undefined);
      return refuse('binding_refused', `The created Peer could not be bound and was archived rather than prompted: ${reason}`);
    }

    await this.append(loaded, {
      type: 'binding.published', payloadVersion: 1, assignmentId: view.id, actor: this.plugin,
      data: { agentId, providerId: snapshot.provider, model: snapshot.model ?? 'provider-default', parentAgentId: caller.agentId, workspaceId, roomGeneration: this.roomGeneration() },
    });
    if (writable) await this.append(loaded, { type: 'ownership.held', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: { agentId } });
    const current = loaded.state.assignments.get(view.id) ?? view;
    const lease = loaded.state.ownership.get(view.id)?.lease;
    const brief = renderBrief(view.id, view.input, placement.kind === 'worktree' ? { path: placement.path, branch: placement.branch, serialOnly: lease?.serialOnly ?? [] } : undefined);
    const turn = await this.beginTurn(loaded, current, correlationId, 'initial', request.preface === undefined ? brief : `${request.preface}\n\n${brief}`);
    return turn.ok ? done({ agentId, generation: turn.value.generation }) : turn;
  }

  /**
   * Before any later prompt: the bound Peer must still be the exact provider and model observed
   * at dispatch, alive, and between turns. Drift blocks the prompt; nothing is substituted.
   */
  async peerReadyForTurn(view: AssignmentView): Promise<ControllerResult<string>> {
    const agentId = view.peerAgentId;
    if (agentId === undefined) return refuse('peer_missing', 'The assignment has no bound Peer.');
    const snapshot = await this.deps.paseo.getAgent(agentId);
    if (snapshot === undefined || snapshot.archivedAt !== null || snapshot.status === 'closed') return refuse('peer_gone', `Peer ${agentId} is no longer available.`);
    if (snapshot.provider !== view.observedProviderId || (snapshot.model ?? 'provider-default') !== view.observedModel) {
      return refuse('peer_drift', `Peer ${agentId} now runs ${snapshot.provider}/${snapshot.model ?? 'provider-default'}, not the dispatched ${String(view.observedProviderId)}/${String(view.observedModel)}.`);
    }
    if (snapshot.activeTurn || snapshot.status === 'running') return refuse('peer_busy', `Peer ${agentId} is still in a turn.`, true);
    const association = await this.deps.correlations.findByAssignment(view.id);
    if (association?.agentId !== agentId) return refuse('peer_unbound', 'The Peer\'s reporting bridge is not associated with this assignment.');
    return done(association.correlationId);
  }

  private lead(caller: Caller): { source: 'seat'; role: 'lead'; agentId: string; providerId: string } {
    return { source: 'seat', role: 'lead', agentId: caller.agentId, providerId: caller.providerId };
  }

  /** Lead answers a question, or follows up on a blocked handback, with a new turn. */
  async answer(caller: Caller, input: { readonly assignmentId: string; readonly answer: string }): Promise<ControllerResult<{ readonly generation: number }>> {
    return await this.continueTurn(caller, input.assignmentId, ['questioned', 'blocked'], async (loaded, view) => {
      await this.append(loaded, { type: 'assignment.answered', payloadVersion: 1, assignmentId: view.id, actor: this.lead(caller), data: { answer: input.answer } });
      return { turn: view.state === 'questioned' ? 'answer' : 'follow-up', prompt: renderContinuation(view.state === 'questioned' ? 'answer' : 'follow-up', input.answer) };
    });
  }

  /** Lead sends a handed-back candidate back for rework with a new turn. */
  async rework(caller: Caller, input: { readonly assignmentId: string; readonly instructions: string }): Promise<ControllerResult<{ readonly generation: number }>> {
    return await this.continueTurn(caller, input.assignmentId, ['handed-back'], async (loaded, view) => {
      await this.append(loaded, { type: 'assignment.rework-requested', payloadVersion: 1, assignmentId: view.id, actor: this.lead(caller), data: { instructions: input.instructions } });
      return { turn: 'rework', prompt: renderContinuation('rework', input.instructions) };
    });
  }

  private async continueTurn(
    caller: Caller,
    assignmentId: string,
    from: readonly AssignmentView['state'][],
    record: (loaded: LoadedProject, view: AssignmentView) => Promise<{ turn: 'answer' | 'rework' | 'follow-up'; prompt: string }>,
  ): Promise<ControllerResult<{ readonly generation: number }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, assignmentId);
      if (!found.ok) return found;
      const { loaded, view } = found.value;
      if (!from.includes(view.state)) return refuse('assignment_state', `Assignment ${view.id} is ${view.state}.`);
      const ready = await this.peerReadyForTurn(view);
      if (!ready.ok) return ready;
      const { turn, prompt } = await record(loaded, view);
      const current = loaded.state.assignments.get(view.id) ?? view;
      return await this.beginTurn(loaded, current, ready.value, turn, prompt);
    });
  }

  /** Background gate runs, keyed by gate run id, so callers and tests can await completion. */
  readonly gates = new Map<string, Promise<GateOutcome>>();
  /** Gates this process is still running; recovery leaves them to finish on their own. */
  readonly activeGates = new Set<string>();

  /**
   * Lead requests the independent runtime gate on the projected candidate. It starts in the
   * background and records its own evidence; it never substitutes for the Peer's gate.
   */
  async gateRun(caller: Caller, input: { readonly assignmentId: string }): Promise<ControllerResult<{ readonly gateRunId: string }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, input.assignmentId);
      if (!found.ok) return found;
      const { loaded, view } = found.value;
      if (view.state !== 'handed-back') return refuse('assignment_state', `A gate runs only on a handed-back candidate; ${view.id} is ${view.state}.`);
      const candidate = view.candidate;
      const gate = view.input.gate;
      if (view.input.mode !== 'writable' || candidate === undefined || gate === undefined) return refuse('candidate_missing', 'There is no writable candidate with a gate to run.');
      if (view.gates.some(run => run.status === 'running')) return refuse('gate_running', 'A gate is already running for this assignment.', true);
      // Proven and recorded inside this queue slot, so a second call sees the running gate and a
      // refused gate is refused to Lead rather than silently never started.
      const precondition = await this.deps.git.dispatchPrecondition(caller.cwd, { gitCommonDir: loaded.store.meta.gitCommonDir, baseCommit: candidate.commit });
      if (!precondition.ok) return refuse('workspace_moved', `The gate cannot run: ${precondition.message}`);
      const gateRunId = token('gate');
      const request: GateRequest = {
        gateRunId, assignmentId: view.id, candidate, command: gate.command, timeoutSeconds: gate.timeoutSeconds,
        cwd: caller.cwd, gitCommonDir: loaded.store.meta.gitCommonDir,
      };
      await this.append(loaded, { type: 'gate.requested', payloadVersion: 1, assignmentId: view.id, actor: this.plugin, data: gateRequestedData(request) });
      const publish = async (event: GateEvent): Promise<void> => {
        await this.serial(store.meta.projectId, async () => {
          const fresh = await this.load(store);
          if (!fresh.ok) throw new Error(fresh.message);
          await this.append(fresh.value, { ...event, payloadVersion: 1, assignmentId: view.id, actor: this.plugin });
        });
      };
      // The process runs after this queue slot is released, so its own appends can proceed. Any
      // failure is recorded as an uncertain gate; nothing is left as an unhandled rejection.
      const started = Promise.resolve()
        .then(() => runGate(request, { git: this.deps.git, gatesDirectory: loaded.store.gatesDirectory, publish }, { alreadyRequested: true }))
        .catch(async (error: unknown): Promise<GateOutcome> => {
          const reason = `The gate runner failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000);
          await publish({ type: 'gate.uncertain', data: { gateRunId, reason } }).catch(() => undefined);
          return { status: 'uncertain', reason };
        })
        .finally(() => { this.activeGates.delete(gateRunId); });
      this.activeGates.add(gateRunId);
      this.gates.set(gateRunId, started);
      return done({ gateRunId });
    });
  }

  /** Lead's technical decision, bound to the exact candidate and its evidence. */
  async accept(caller: Caller, input: { readonly assignmentId: string; readonly reason: string; readonly override?: { readonly reason: string; readonly residualRiskAcknowledged: true } }): Promise<ControllerResult<{ readonly red: boolean }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, input.assignmentId);
      if (!found.ok) return found;
      const { loaded, view } = found.value;
      let observedHead: string | undefined;
      if (view.input.mode === 'writable') {
        const identity = await this.deps.git.identity(caller.cwd);
        observedHead = await this.deps.git.head(identity.canonicalRoot);
      }
      const decision = evaluateAcceptance(view, { reason: input.reason, ...(input.override === undefined ? {} : { override: input.override }), ...(observedHead === undefined ? {} : { observedHead }) });
      if (!decision.ok) return refuse(decision.code, decision.message);
      await this.append(loaded, {
        type: 'assignment.accepted', payloadVersion: 1, assignmentId: view.id, actor: this.lead(caller),
        data: {
          reason: input.reason,
          ...(view.candidate === undefined ? {} : { candidate: view.candidate }),
          ...(view.inspectedCommit === undefined ? {} : { inspectedCommit: view.inspectedCommit }),
          ...(decision.red && input.override !== undefined ? { override: input.override } : {}),
          ...(decision.gate === undefined ? {} : { gateResultId: decision.gate.gateRunId }),
        },
      });
      return done({ red: decision.red });
    });
  }

  async reject(caller: Caller, input: { readonly assignmentId: string; readonly reason: string }): Promise<ControllerResult<{ readonly state: 'rejected' }>> {
    return await this.decide(caller, input.assignmentId, 'assignment.rejected', input.reason, 'rejected');
  }

  async abandon(caller: Caller, input: { readonly assignmentId: string; readonly reason: string }): Promise<ControllerResult<{ readonly state: 'abandoned' }>> {
    return await this.decide(caller, input.assignmentId, 'assignment.abandoned', input.reason, 'abandoned');
  }

  private async decide<S extends 'rejected' | 'abandoned'>(caller: Caller, assignmentId: string, type: 'assignment.rejected' | 'assignment.abandoned', reason: string, state: S): Promise<ControllerResult<{ readonly state: S }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, assignmentId);
      if (!found.ok) return found;
      try {
        await this.append(found.value.loaded, { type, payloadVersion: 1, assignmentId, actor: this.lead(caller), data: { reason } });
      } catch (error) {
        return refuse('assignment_state', error instanceof Error ? error.message : String(error));
      }
      return done({ state });
    });
  }

  /**
   * Closes a decided assignment by archiving its managed Peer. Lead's workspace is never closed.
   * Ownership is released only on proven archive; decisions alone never release it.
   */
  async close(caller: Caller, input: { readonly assignmentId: string }): Promise<ControllerResult<{ readonly released: boolean }>> {
    const store = await this.projectFor(caller.cwd);
    return await this.serial(store.meta.projectId, async () => {
      const found = await this.leadAssignment(caller, input.assignmentId);
      if (!found.ok) return found;
      const { loaded, view } = found.value;
      const agentId = view.peerAgentId;
      if (agentId === undefined) return done({ released: false });
      if (view.closure === 'closed') return done({ released: loaded.state.ownership.get(view.id)?.state !== 'held' });
      if (view.closure === 'open') {
        try {
          await this.append(loaded, { type: 'assignment.close-requested', payloadVersion: 1, assignmentId: view.id, actor: this.lead(caller), data: {} });
        } catch (error) {
          return refuse('assignment_state', error instanceof Error ? error.message : String(error));
        }
      }
      return await this.archiveAndRelease(loaded, view.id, agentId);
    });
  }

  /** Lead closes a retained worktree of its own closed assignment (delta P2-D7). */
  async workspaceClose(caller: Caller, input: { readonly assignmentId: string; readonly discardUncommitted?: true | undefined; readonly reason?: string | undefined }): Promise<ControllerResult<{ readonly closed: boolean }>> {
    const found = await this.leadAssignment(caller, input.assignmentId);
    if (!found.ok) return found;
    return refuse('not_implemented', 'Worktree close arrives with runtime Phase 2.');
  }

  /** Lead reclaims a lease whose Peer is proven archived (delta P2-D6). */
  async leaseReclaim(caller: Caller, input: { readonly assignmentId: string; readonly reason: string }): Promise<ControllerResult<{ readonly epoch: number }>> {
    const found = await this.leadAssignment(caller, input.assignmentId);
    if (!found.ok) return found;
    return refuse('not_implemented', 'Lease reclaim arrives with runtime Phase 2.');
  }

  roomGeneration(): string {
    const state = this.deps.recognition.current;
    return state.manifest?.roomGeneration ?? 'unknown';
  }

  /** A created child that failed its proof is archived through Paseo, never adopted. */
  async archiveUnbound(loaded: LoadedProject, assignmentId: string, agentId: string): Promise<void> {
    await this.append(loaded, { type: 'assignment.close-requested', payloadVersion: 1, assignmentId, actor: this.plugin, data: {} });
    await this.archiveAndRelease(loaded, assignmentId, agentId);
  }

  /**
   * Requests archive and releases writer ownership only on proof: a successful archive whose
   * refreshed live snapshot is closed. Anything less leaves closure and ownership uncertain.
   */
  async archiveAndRelease(loaded: LoadedProject, assignmentId: string, agentId: string): Promise<ControllerResult<{ readonly released: boolean }>> {
    const intentId = token('archive');
    await this.append(loaded, { type: 'archive.requested', payloadVersion: 1, assignmentId, actor: this.plugin, idempotencyKey: intentId, data: { intentId, agentId } });
    if (loaded.state.ownership.get(assignmentId)?.state === 'held') {
      await this.append(loaded, { type: 'ownership.releasing', payloadVersion: 1, assignmentId, actor: this.plugin, data: { agentId } });
    }
    let archivedAt: string;
    try {
      archivedAt = (await this.deps.paseo.archive(agentId)).archivedAt;
    } catch (error) {
      await this.append(loaded, { type: 'archive.uncertain', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, agentId, reason: error instanceof Error ? error.message.slice(0, 1_000) || 'unknown' : 'unknown' } });
      await this.markOwnershipUncertain(loaded, assignmentId, 'Archive was not confirmed.');
      return refuse('archive_uncertain', 'Paseo did not confirm the archive; ownership stays held as uncertain until recovery proves the Peer stopped.', true);
    }
    const refreshed = await this.deps.paseo.getAgent(agentId);
    if (refreshed?.status !== 'closed' || refreshed.archivedAt === null) {
      await this.append(loaded, { type: 'archive.failed', payloadVersion: 1, assignmentId, actor: this.plugin, data: { intentId, agentId, reason: `Refreshed status is ${refreshed?.status ?? 'missing'}, not closed.` } });
      await this.markOwnershipUncertain(loaded, assignmentId, 'Archive was reported but the live status is not closed.');
      return refuse('archive_unproven', 'The archive could not be corroborated by a closed live status.', true);
    }
    await this.append(loaded, { type: 'archive.succeeded', payloadVersion: 1, assignmentId, actor: { source: 'paseo' }, data: { intentId, agentId, archivedAt, liveStatus: 'closed' } });
    const owner = loaded.state.ownership.get(assignmentId);
    if (owner !== undefined && (owner.state === 'releasing' || owner.state === 'uncertain')) {
      await this.append(loaded, { type: 'ownership.released', payloadVersion: 1, assignmentId, actor: this.plugin, data: { agentId, archivedAt } });
    }
    return done({ released: true });
  }

  private async markOwnershipUncertain(loaded: LoadedProject, assignmentId: string, reason: string): Promise<void> {
    const owner = loaded.state.ownership.get(assignmentId);
    if (owner !== undefined && owner.state !== 'released' && owner.state !== 'uncertain') {
      await this.append(loaded, { type: 'ownership.uncertain', payloadVersion: 1, assignmentId, actor: this.plugin, data: { reason } });
    }
  }
}

