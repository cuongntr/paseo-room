/**
 * The only module that calls Paseo's agent SDK (docs/design/runtime-coordination.md D3, §3.3).
 *
 * Paseo stays the lifecycle control plane: the runtime asks it to create, prompt and archive
 * agents and reads fresh snapshots back as evidence. Paseo `0.8.0` builds one `PaseoApi` per
 * plugin subprocess but hands it out only through hook, event and RPC contexts, never to the
 * contribution function, so the port keeps the most recently supplied handle and drops it on
 * cleanup. Work that needs live corroboration waits for a handle; it never proceeds on local
 * evidence alone and never opens a second client connection.
 */
import type { PluginHookContext } from '@getpaseo/plugin/server';

export type PaseoApi = PluginHookContext['paseo'];

/** Paseo's reserved parentage label, set by Paseo itself when an agent is created with a parent. */
export const PARENT_AGENT_ID_LABEL = 'paseo.parent-agent-id';
/** The room's own label binding a created Peer to the assignment that reserved it. */
export const ASSIGNMENT_LABEL = 'paseo-room.assignment';

export interface PermissionSnapshot {
  readonly id: string;
  readonly name: string;
}

/** The fields of a live agent the runtime treats as evidence. */
export interface AgentSnapshot {
  readonly id: string;
  readonly provider: string;
  readonly model: string | null;
  readonly cwd: string;
  readonly workspaceId: string | null;
  readonly status: 'initializing' | 'idle' | 'running' | 'error' | 'closed';
  readonly activeTurn: boolean;
  readonly lastUserMessageAt: string | null;
  /** When Paseo last changed this agent's record; compared with `lastUserMessageAt` only. */
  readonly updatedAt: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly archivedAt: string | null;
  readonly pendingPermissions: readonly PermissionSnapshot[];
}

/**
 * How the operator configured this seat to launch. Every field is theirs: the runtime reads them
 * and never chooses one. `modeId` matters as much as the model for a seat nobody is sitting
 * beside — a Peer launched into a mode that asks before each tool stalls on its first call.
 */
export interface PeerLaunch {
  readonly model: string;
  readonly modeId?: string;
  readonly thinkingOptionId?: string;
}

export interface CreateAgentInput extends PeerLaunch {
  readonly provider: string;
  readonly cwd: string;
  readonly parentAgentId: string;
  readonly title: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface PaseoPort {
  /**
   * How an exact room provider launches, from operator-owned configuration: the room profile's
   * model, mode and thinking option, falling back to the provider's declared default model only.
   * Undefined when no model exists anywhere — dispatch then refuses rather than choosing.
   */
  resolveLaunch(provider: string): Promise<PeerLaunch | undefined>;
  /** Creates an agent with no initial prompt; the first turn is always a separate `run`. */
  createAgent(input: CreateAgentInput): Promise<{ readonly agentId: string }>;
  /** A fresh snapshot from Paseo, or undefined when Paseo knows no such agent. */
  getAgent(agentId: string): Promise<AgentSnapshot | undefined>;
  listAgents(): Promise<readonly AgentSnapshot[]>;
  /** Starts a turn with `text`; `messageId` ties the delivered prompt to its reporting generation. */
  run(agentId: string, text: string, messageId: string): Promise<void>;
  archive(agentId: string): Promise<{ readonly archivedAt: string }>;
  /**
   * Whether a prompt with this message id is in the agent's timeline. `unknown` whenever the
   * evidence is incomplete: recovery never infers delivery from a lifecycle notification.
   */
  promptDelivered(agentId: string, messageId: string): Promise<'delivered' | 'absent' | 'unknown'>;
}

export class PaseoUnavailableError extends Error {
  constructor(message = 'Paseo has not supplied an API handle to this plugin process yet.') {
    super(message);
    this.name = 'PaseoUnavailableError';
  }
}

/** Holds the subprocess's PaseoApi between contexts. */
export class PaseoHandle {
  private api: PaseoApi | undefined;
  private waiters: ((api: PaseoApi) => void)[] = [];

  /** Called from every hook, event and RPC context before any other work. */
  supply(api: PaseoApi): void {
    this.api = api;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve(api);
  }

  clear(): void {
    this.api = undefined;
  }

  get available(): boolean {
    return this.api !== undefined;
  }

  /** The handle, or a bounded wait for one; never a fallback. */
  async acquire(timeoutMs: number): Promise<PaseoApi> {
    if (this.api !== undefined) return this.api;
    return await new Promise<PaseoApi>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter !== accept);
        reject(new PaseoUnavailableError());
      }, timeoutMs);
      const accept = (api: PaseoApi): void => { clearTimeout(timer); resolve(api); };
      this.waiters.push(accept);
    });
  }
}

type RawSnapshot = NonNullable<ReturnType<ReturnType<PaseoApi['agents']['ref']>['current']>>;

export function toSnapshot(raw: RawSnapshot): AgentSnapshot {
  return {
    id: raw.id,
    provider: raw.provider,
    model: raw.model,
    cwd: raw.cwd,
    workspaceId: raw.workspaceId ?? null,
    status: raw.status,
    activeTurn: raw.activeTurn !== undefined && raw.activeTurn !== null,
    lastUserMessageAt: raw.lastUserMessageAt,
    updatedAt: raw.updatedAt,
    labels: { ...raw.labels },
    archivedAt: raw.archivedAt ?? null,
    pendingPermissions: raw.pendingPermissions.map(permission => ({ id: permission.id, name: permission.name })),
  };
}

/** The production port over the subprocess PaseoApi. */
export function sdkPaseoPort(handle: PaseoHandle, waitMs = 10_000): PaseoPort {
  const api = (): Promise<PaseoApi> => handle.acquire(waitMs);
  return {
    async resolveLaunch(provider) {
      const paseo = await api();
      const config = await paseo.config.get();
      const profiles = (config.config as { agentProfiles?: readonly Record<string, unknown>[] }).agentProfiles ?? [];
      const profile = profiles.find(entry => entry.id === `room-${provider}` && entry.provider === provider);
      const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
      // Mode and thinking option come only from the room profile: a provider default for either
      // is Paseo's choice for interactive use, not the operator's choice for this seat.
      const settings = {
        ...(text(profile?.modeId) === undefined ? {} : { modeId: text(profile?.modeId) as string }),
        ...(text(profile?.thinkingOptionId) === undefined ? {} : { thinkingOptionId: text(profile?.thinkingOptionId) as string }),
      };
      const chosen = text(profile?.model);
      if (chosen !== undefined) return { model: chosen, ...settings };
      const listed = await paseo.providers.listModels(provider) as { models?: readonly { id: string; isDefault?: boolean }[] };
      const fallback = listed.models?.find(model => model.isDefault === true)?.id;
      return fallback === undefined ? undefined : { model: fallback, ...settings };
    },
    async createAgent(input) {
      const paseo = await api();
      const created = await paseo.agents.create({
        config: {
          provider: `${input.provider}/${input.model}`,
          ...(input.modeId === undefined ? {} : { modeId: input.modeId }),
          ...(input.thinkingOptionId === undefined ? {} : { thinkingOptionId: input.thinkingOptionId }),
        },
        cwd: input.cwd, parent: input.parentAgentId,
        title: input.title, labels: { ...input.labels },
      });
      return { agentId: created.id };
    },
    async getAgent(agentId) {
      const paseo = await api();
      const ref = paseo.agents.ref(agentId);
      await ref.refresh();
      const current = ref.current();
      return current === null ? undefined : toSnapshot(current);
    },
    async listAgents() {
      const paseo = await api();
      const listed = await paseo.agents.list();
      const ids = listed.entries.map(entry => entry.agent.id);
      const snapshots: AgentSnapshot[] = [];
      for (const id of ids) {
        const ref = paseo.agents.ref(id);
        await ref.refresh();
        const current = ref.current();
        if (current !== null) snapshots.push(toSnapshot(current));
      }
      return snapshots;
    },
    async run(agentId, text, messageId) {
      const paseo = await api();
      await paseo.agents.ref(agentId).send(text, { messageId });
    },
    async archive(agentId) {
      const paseo = await api();
      return await paseo.agents.ref(agentId).archive();
    },
    async promptDelivered(agentId, messageId) {
      const paseo = await api();
      try {
        const page = await paseo.agents.ref(agentId).timeline.refetch({ limit: 500 });
        if (page.error !== null) return 'unknown';
        const found = page.entries.some(entry => entry.item.type === 'user_message' && (entry.item.messageId === messageId || entry.item.clientMessageId === messageId));
        if (found) return 'delivered';
        return page.hasOlder || page.gap || page.staleCursor ? 'unknown' : 'absent';
      } catch {
        return 'unknown';
      }
    },
  };
}
