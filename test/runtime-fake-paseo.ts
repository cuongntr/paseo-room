/** An in-memory Paseo for runtime controller tests. Deterministic; every call is logged. */
import {
  ASSIGNMENT_LABEL, PARENT_AGENT_ID_LABEL, type AgentSnapshot, type CreateAgentInput, type PaseoPort, type PeerLaunch,
} from '../src/runtime-plugin/server/paseo-port.js';

type Operation = 'createAgent' | 'getAgent' | 'listAgents' | 'run' | 'archive';

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
      const id = `agent-${String(++this.counter)}`;
      this.addAgent({
        id, provider: input.provider, model: input.model, cwd: input.cwd, workspaceId: this.workspaceFor(input.cwd),
        labels: { ...input.labels, [PARENT_AGENT_ID_LABEL]: input.parentAgentId },
      });
      return { agentId: id };
    });
    await this.onCreate?.(input, created.agentId);
    return created;
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
