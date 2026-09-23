/**
 * An in-memory Paseo for runtime controller tests. Deterministic; every call is logged.
 *
 * Worktree workspaces are real `git worktree` checkouts of the test repository, so the runtime's
 * Git proofs run against real evidence. Creation receipts model Paseo 0.9.1 as the Phase 2 probe
 * observed it (docs/design/runtime-coordination-phase2.md §9.1): a replayed key returns the same
 * resource, a reused key with another request or a reused id conflicts, and an existing branch
 * name makes Paseo branch from that branch under a renamed branch instead of the requested base.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ASSIGNMENT_LABEL, CreationConflictError, PARENT_AGENT_ID_LABEL, type AgentSnapshot, type CreateAgentInput, type PaseoPort, type PeerLaunch,
  type WorkspaceSnapshot, type WorktreeWorkspaceRequest,
} from '../src/runtime-plugin/server/paseo-port.js';

type Operation =
  | 'createAgent' | 'getAgent' | 'listAgents' | 'run' | 'archive'
  | 'createWorktreeWorkspace' | 'getWorkspace' | 'archiveWorkspace' | 'createAgentInWorkspace';

/** Paseo fingerprints the request's content, not the order its fields were written in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
    : entry));
}

export interface FakeWorkspace {
  id: string;
  repo: string;
  directory: string;
  branch: string;
  kind: string;
  archivedAt: string | null;
}

export interface FakeAgent {
  id: string;
  provider: string;
  model: string | null;
  cwd: string;
  workspaceId: string | null;
  status: AgentSnapshot['status'];
  activeTurn: boolean;
  lastUserMessageAt: string | null;
  updatedAt: string;
  labels: Record<string, string>;
  archivedAt: string | null;
  pendingPermissions: { id: string; name: string }[];
  prompts: { text: string; messageId: string }[];
}

export class FakePaseo implements PaseoPort {
  readonly agents = new Map<string, FakeAgent>();
  readonly calls: { operation: Operation; args: unknown[] }[] = [];
  /** Throw once from the named operation, after (`after`) or before the effect takes place. */
  readonly faults = new Map<Operation, { readonly when: 'before' | 'after'; readonly error?: Error }>();
  models: Record<string, string> = {};
  /** Stands in for Paseo running plugin before-hooks and opening the session during create. */
  onCreate?: (input: CreateAgentInput, agentId: string) => Promise<void>;
  workspaceFor: (cwd: string) => string = () => 'ws-1';
  private counter = 0;
  readonly workspaces = new Map<string, FakeWorkspace>();
  /** Where worktree directories are created; set by the harness to a temporary directory. */
  worktreeRoot = '/tmp/paseo-room-fake-worktrees';
  /** Stands in for another trusted plugin rewriting a workspace request before Paseo runs it. */
  transformWorkspace?: (request: WorktreeWorkspaceRequest) => WorktreeWorkspaceRequest;
  /** When set, workspace archive keeps the record archived but leaves the directory (teardown failure). */
  teardownFails = false;
  private readonly receipts = new Map<string, { readonly fingerprint: string; readonly id: string }>();

  private receipt(kind: 'agent' | 'workspace', key: string | undefined, request: unknown, id: string | undefined): string | undefined {
    if (key === undefined) return undefined;
    const known = this.receipts.get(`${kind}:${key}`);
    const fingerprint = canonical(request);
    if (known !== undefined && known.fingerprint !== fingerprint) throw new CreationConflictError(`${kind}_request_key_conflict`);
    if (known !== undefined) return known.id;
    if (id !== undefined && [...this.receipts.entries()].some(([name, entry]) => name.startsWith(`${kind}:`) && entry.id === id)) throw new CreationConflictError(`${kind}_id_conflict`);
    return undefined;
  }

  private remember(kind: 'agent' | 'workspace', key: string | undefined, request: unknown, id: string): void {
    if (key !== undefined) this.receipts.set(`${kind}:${key}`, { fingerprint: canonical(request), id });
  }

  private git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
  }

  addAgent(agent: Partial<FakeAgent> & { id: string; provider: string }): FakeAgent {
    const full: FakeAgent = {
      model: this.models[agent.provider] ?? 'model-x', cwd: '/repo', workspaceId: 'ws-1', status: 'idle', activeTurn: false,
      lastUserMessageAt: null, updatedAt: '2026-09-22T09:00:00.000Z', labels: {}, archivedAt: null, pendingPermissions: [], prompts: [], ...agent,
    };
    this.agents.set(full.id, full);
    return full;
  }

  private async step<T>(operation: Operation, args: unknown[], effect: () => T): Promise<T> {
    this.calls.push({ operation, args });
    const fault = this.faults.get(operation);
    if (fault?.when === 'before') { this.faults.delete(operation); throw fault.error ?? new Error(`${operation} failed`); }
    const result = effect();
    if (fault?.when === 'after') { this.faults.delete(operation); throw fault.error ?? new Error(`${operation} response lost`); }
    return await Promise.resolve(result);
  }

  private snapshot(agent: FakeAgent): AgentSnapshot {
    return {
      id: agent.id, provider: agent.provider, model: agent.model, cwd: agent.cwd, workspaceId: agent.workspaceId, status: agent.status,
      activeTurn: agent.activeTurn, lastUserMessageAt: agent.lastUserMessageAt, updatedAt: agent.updatedAt, labels: { ...agent.labels },
      archivedAt: agent.archivedAt, pendingPermissions: agent.pendingPermissions.map(permission => ({ ...permission })),
    };
  }

  async createAgent(input: CreateAgentInput): Promise<{ agentId: string }> {
    const created = await this.step('createAgent', [input], () => {
      const replayed = this.receipt('agent', input.idempotencyKey, input, input.agentId);
      if (replayed !== undefined) return { agentId: replayed, fresh: false };
      const id = input.agentId ?? `agent-${String(++this.counter)}`;
      this.addAgent({
        id, provider: input.provider, model: input.model, cwd: input.cwd, workspaceId: this.workspaceFor(input.cwd),
        labels: { ...input.labels, [PARENT_AGENT_ID_LABEL]: input.parentAgentId },
      });
      this.remember('agent', input.idempotencyKey, input, id);
      return { agentId: id, fresh: true };
    });
    // A replayed receipt opens no second session.
    if (created.fresh) await this.onCreate?.(input, created.agentId);
    return { agentId: created.agentId };
  }

  async createAgentInWorkspace(workspaceId: string, input: Omit<CreateAgentInput, 'cwd'>): Promise<{ agentId: string }> {
    const created = await this.step('createAgentInWorkspace', [workspaceId, input], () => {
      const replayed = this.receipt('agent', input.idempotencyKey, { workspaceId, ...input }, input.agentId);
      if (replayed !== undefined) return { agentId: replayed, cwd: undefined };
      const workspace = this.workspaces.get(workspaceId);
      if (workspace === undefined || workspace.archivedAt !== null) throw new Error(`Workspace ${workspaceId} has no available directory`);
      const id = input.agentId ?? `agent-${String(++this.counter)}`;
      this.addAgent({
        id, provider: input.provider, model: input.model, cwd: workspace.directory, workspaceId,
        labels: { ...input.labels, [PARENT_AGENT_ID_LABEL]: input.parentAgentId },
      });
      this.remember('agent', input.idempotencyKey, { workspaceId, ...input }, id);
      return { agentId: id, cwd: workspace.directory };
    });
    if (created.cwd !== undefined) await this.onCreate?.({ ...input, cwd: created.cwd }, created.agentId);
    return { agentId: created.agentId };
  }

  private workspaceSnapshot(workspace: FakeWorkspace): WorkspaceSnapshot {
    return { id: workspace.id, directory: workspace.directory, kind: workspace.kind, archiving: false };
  }

  createWorktreeWorkspace(original: WorktreeWorkspaceRequest): Promise<WorkspaceSnapshot> {
    return this.step('createWorktreeWorkspace', [original], () => {
      const replayed = this.receipt('workspace', original.idempotencyKey, original, original.workspaceId);
      const known = replayed === undefined ? undefined : this.workspaces.get(replayed);
      if (known !== undefined) return this.workspaceSnapshot(known);
      const request = this.transformWorkspace?.(original) ?? original;
      mkdirSync(this.worktreeRoot, { recursive: true });
      const directory = join(this.worktreeRoot, request.worktreeSlug);
      const exists = (() => { try { this.git(request.cwd, 'rev-parse', '--verify', '-q', `refs/heads/${request.branchName}`); return true; } catch { return false; } })();
      // Paseo 0.9.1: an existing branch name makes it branch from that branch, renamed.
      const branch = exists ? `${request.branchName}-2` : request.branchName;
      this.git(request.cwd, 'worktree', 'add', '-q', '-b', branch, directory, exists ? request.branchName : request.baseCommit);
      const workspace: FakeWorkspace = { id: request.workspaceId, repo: request.cwd, directory, branch, kind: 'worktree', archivedAt: null };
      this.workspaces.set(workspace.id, workspace);
      this.remember('workspace', original.idempotencyKey, original, workspace.id);
      return this.workspaceSnapshot(workspace);
    });
  }

  getWorkspace(workspaceId: string): Promise<WorkspaceSnapshot | undefined> {
    return this.step('getWorkspace', [workspaceId], () => {
      const workspace = this.workspaces.get(workspaceId);
      return workspace === undefined || workspace.archivedAt !== null ? undefined : this.workspaceSnapshot(workspace);
    });
  }

  /** Paseo archives the workspace's agents, runs teardown, then removes the worktree and keeps the branch. */
  archiveWorkspace(workspaceId: string): Promise<{ archivedAt: string }> {
    return this.step('archiveWorkspace', [workspaceId], () => {
      const workspace = this.workspaces.get(workspaceId);
      if (workspace === undefined || workspace.archivedAt !== null) throw new Error(`Workspace not found: ${workspaceId}`);
      for (const agent of this.agents.values()) {
        if (agent.workspaceId === workspaceId && agent.archivedAt === null) {
          agent.archivedAt = '2026-09-22T11:30:00.000Z';
          agent.status = 'closed';
          agent.activeTurn = false;
        }
      }
      workspace.archivedAt = '2026-09-22T12:00:00.000Z';
      if (!this.teardownFails) this.git(workspace.repo, 'worktree', 'remove', '--force', workspace.directory);
      return { archivedAt: workspace.archivedAt };
    });
  }

  getAgent(agentId: string): Promise<AgentSnapshot | undefined> {
    return this.step('getAgent', [agentId], () => {
      const agent = this.agents.get(agentId);
      return agent === undefined ? undefined : this.snapshot(agent);
    });
  }

  listAgents(): Promise<readonly AgentSnapshot[]> {
    return this.step('listAgents', [], () => [...this.agents.values()].map(agent => this.snapshot(agent)));
  }

  run(agentId: string, text: string, messageId: string): Promise<void> {
    return this.step('run', [agentId, text, messageId], () => {
      const agent = this.agents.get(agentId);
      if (agent === undefined || agent.status === 'closed') throw new Error(`agent ${agentId} cannot receive a turn`);
      agent.prompts.push({ text, messageId });
      agent.lastUserMessageAt = '2026-09-22T10:00:00.000Z';
      agent.updatedAt = agent.lastUserMessageAt;
      agent.status = 'running';
      agent.activeTurn = true;
    });
  }

  archive(agentId: string): Promise<{ archivedAt: string }> {
    return this.step('archive', [agentId], () => {
      const agent = this.agents.get(agentId);
      if (agent === undefined) throw new Error(`agent ${agentId} not found`);
      agent.archivedAt = '2026-09-22T11:00:00.000Z';
      agent.status = 'closed';
      agent.activeTurn = false;
      agent.updatedAt = agent.archivedAt;
      return { archivedAt: agent.archivedAt };
    });
  }

  /** Operator-owned model per provider; `null` means the provider declares none. */
  readonly peerModels: Record<string, string | null> = {};
  /** Operator-owned launch mode per provider, as the room profile would carry it. */
  readonly peerModes: Record<string, string> = {};

  resolveLaunch(provider: string): Promise<PeerLaunch | undefined> {
    const configured = this.peerModels[provider];
    if (configured === null) return Promise.resolve(undefined);
    const model = configured ?? this.models[provider] ?? 'model-x';
    const modeId = this.peerModes[provider];
    return Promise.resolve({ model, ...(modeId === undefined ? {} : { modeId }) });
  }

  /** Set to force a timeline answer, e.g. `unknown` when history is incomplete. */
  timelineOverride?: 'delivered' | 'absent' | 'unknown';

  promptDelivered(agentId: string, messageId: string): Promise<'delivered' | 'absent' | 'unknown'> {
    return this.step('getAgent', [agentId, messageId], () => {
      if (this.timelineOverride !== undefined) return this.timelineOverride;
      const agent = this.agents.get(agentId);
      if (agent === undefined) return 'unknown';
      return agent.prompts.some(prompt => prompt.messageId === messageId) ? 'delivered' : 'absent';
    });
  }

  /** Test helper: finish the agent's turn. */
  endTurn(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) { agent.status = 'idle'; agent.activeTurn = false; agent.updatedAt = '2026-09-22T10:05:00.000Z'; }
  }
}

export { ASSIGNMENT_LABEL, PARENT_AGENT_ID_LABEL };
