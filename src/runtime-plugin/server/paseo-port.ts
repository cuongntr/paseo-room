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
  readonly title: string | null;
  /** From Paseo's own parentage label; null for a top-level agent. */
  readonly parentAgentId: string | null;
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
  /** Omitted only for a Human-started top-level seat, such as a Supervisor. */
  readonly parentAgentId?: string;
  readonly title: string;
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Chosen by the runtime and recorded before the call, so a lost response is recovered by
   * reissuing the identical request: Paseo's creation receipt replays it (delta P2-D3).
   */
  readonly agentId?: string;
  readonly idempotencyKey?: string;
}

/** A Paseo worktree workspace cut from an exact commit, with runtime-chosen identities (P2-D3, P2-D4). */
export interface WorktreeWorkspaceRequest {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly title: string;
  /** The project's canonical root: the repository the worktree is cut from. */
  readonly cwd: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly worktreeSlug: string;
}

/** The fields of a live workspace the runtime treats as evidence. Git proves the rest. */
export interface WorkspaceSnapshot {
  readonly id: string;
  readonly directory: string | null;
  readonly kind: string;
  readonly archiving: boolean;
}

/**
 * Paseo refused a creation because its receipt already records a different request under this
 * key, or this id for another key. Never retried with a new key: that would be a second creation.
 */
export class CreationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationConflictError';
  }
}

const CONFLICT = /_(?:request_key|id)_conflict\b/;

function conflictOr(error: unknown): unknown {
  return error instanceof Error && CONFLICT.test(error.message) ? new CreationConflictError(error.message) : error;
}

/**
 * How a prompt meets a turn already running. Paseo's own default is `interrupt`, which cancels the
 * running turn; a runtime notice or letter uses `steer`, which delivers it inside that turn.
 */
export type SendBehavior = 'steer' | 'interrupt';

/** One timeline entry, reduced to what the runtime reads: never tool output or file content. */
export interface TimelineEntry {
  readonly kind: 'user' | 'assistant' | 'tool' | 'error' | 'other';
  readonly text: string;
  readonly timestamp: string;
  readonly turnId?: string;
  readonly messageId?: string;
  /** For a tool call whose normalised detail edits or writes a file. */
  readonly writes?: string;
  /**
   * For a Paseo `send_agent_prompt` or `create_agent` tool call: its target and whether the caller
   * asked to be told when that agent finishes (Paseo's defaults for an agent caller: yes).
   */
  readonly prompts?: { readonly tool: 'send_agent_prompt' | 'create_agent'; readonly agentId?: string; readonly notified: boolean };
}

/** How Paseo launches a provider: its executable and the environment it sets. */
export interface ProviderCommand {
  readonly binary: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface PaseoPort {
  /**
   * How an exact room provider launches, from operator-owned configuration: the room profile's
   * model, mode and thinking option, falling back to the provider's declared default model only.
   * Undefined when no model exists anywhere — dispatch then refuses rather than choosing.
   */
  resolveLaunch(provider: string): Promise<PeerLaunch | undefined>;
  /** The provider's configured executable and string environment, or undefined when it has none. */
  providerCommand(provider: string): Promise<ProviderCommand | undefined>;
  /** Creates an agent with no initial prompt; the first turn is always a separate `run`. */
  createAgent(input: CreateAgentInput): Promise<{ readonly agentId: string }>;
  /** A fresh snapshot from Paseo, or undefined when Paseo knows no such agent. */
  getAgent(agentId: string): Promise<AgentSnapshot | undefined>;
  listAgents(): Promise<readonly AgentSnapshot[]>;
  /** Starts a turn with `text`; `messageId` ties the delivered prompt to its reporting generation. */
  run(agentId: string, text: string, messageId: string): Promise<void>;
  /** Sends `text` with an explicit behaviour toward a running turn (docs/design/runtime-coordination-attention.md A-D4). */
  send(agentId: string, text: string, messageId: string, behavior: SendBehavior): Promise<void>;
  /** The latest `limit` timeline entries, oldest first; empty when Paseo cannot answer. */
  recentTimeline(agentId: string, limit: number): Promise<readonly TimelineEntry[]>;
  archive(agentId: string): Promise<{ readonly archivedAt: string }>;
  /** Creates (or, for a replayed key, returns) a worktree workspace. Throws CreationConflictError on a receipt conflict. */
  createWorktreeWorkspace(request: WorktreeWorkspaceRequest): Promise<WorkspaceSnapshot>;
  /**
   * Opens (or finds) Paseo's workspace for a directory. A parented agent must be created through its
   * handle: given only a cwd, Paseo places a parented child in its parent's workspace (P2-D8).
   */
  openWorkspace(cwd: string): Promise<WorkspaceSnapshot>;
  /** The active workspace with this id, or undefined once Paseo no longer lists it (archived or unknown). */
  getWorkspace(workspaceId: string): Promise<WorkspaceSnapshot | undefined>;
  /** Archives a workspace; for a worktree Paseo runs teardown and removes the directory, keeping the branch. */
  archiveWorkspace(workspaceId: string): Promise<{ readonly archivedAt: string }>;
  /**
   * Creates a Peer inside an explicit workspace, with `parentAgentId` as its parent: without the
   * workspace handle Paseo would place a parented child in the caller's workspace (P2-D8).
   */
  createAgentInWorkspace(workspaceId: string, input: Omit<CreateAgentInput, 'cwd'>): Promise<{ readonly agentId: string }>;
  /**
   * Whether a prompt with this message id is in the agent's timeline. `unknown` whenever the
   * evidence is incomplete: recovery never infers delivery from a lifecycle notification.
   */
  promptDelivered(agentId: string, messageId: string): Promise<'delivered' | 'absent' | 'unknown'>;
}

/** Paseo's proof that an agent can no longer act: archived, with a closed live status. */
export function peerStopped(snapshot: AgentSnapshot | undefined): snapshot is AgentSnapshot & { readonly archivedAt: string } {
  return snapshot !== undefined && snapshot.archivedAt !== null && snapshot.status === 'closed';
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
    title: raw.title ?? null,
    parentAgentId: raw.labels[PARENT_AGENT_ID_LABEL] ?? null,
  };
}

type RawTimelineItem = { readonly type: string; readonly text?: unknown; readonly message?: unknown; readonly messageId?: unknown; readonly clientMessageId?: unknown; readonly detail?: unknown; readonly name?: unknown };

const PROMPT_TOOL = /(?:^|__)(send_agent_prompt|create_agent)$/;

/**
 * Paseo reports a prompted agent's next finish to the caller — as an envelope when the call ran in
 * the background, or as the call's own result when it waited — unless the caller opted out of both
 * with `notifyOnFinish: false` in the background (`S/agent/tools/paseo-tools.js`).
 */
function promptOf(name: unknown, detail: unknown): TimelineEntry['prompts'] {
  const tool = typeof name === 'string' ? PROMPT_TOOL.exec(name)?.[1] : undefined;
  if (tool !== 'send_agent_prompt' && tool !== 'create_agent') return undefined;
  const input = (detail as { input?: unknown } | undefined)?.input as { agentId?: unknown; notifyOnFinish?: unknown; background?: unknown } | undefined;
  const optedOut = input?.notifyOnFinish === false && input.background !== false;
  return { tool, ...(typeof input?.agentId === 'string' ? { agentId: input.agentId } : {}), notified: !optedOut };
}

/** Reduces a Paseo timeline item to a TimelineEntry; tool output and file content are dropped. */
export function toTimelineEntry(item: RawTimelineItem, timestamp: string, turnId?: string): TimelineEntry {
  const base = { timestamp, ...(turnId === undefined ? {} : { turnId }) };
  const text = typeof item.text === 'string' ? item.text : '';
  if (item.type === 'user_message') {
    const id = typeof item.messageId === 'string' ? item.messageId : typeof item.clientMessageId === 'string' ? item.clientMessageId : undefined;
    return { kind: 'user', text, ...base, ...(id === undefined ? {} : { messageId: id }) };
  }
  if (item.type === 'assistant_message') return { kind: 'assistant', text, ...base };
  if (item.type === 'error') return { kind: 'error', text: typeof item.message === 'string' ? item.message : '', ...base };
  if (item.type === 'tool_call') {
    const detail = item.detail as { type?: unknown; filePath?: unknown } | undefined;
    const writes = (detail?.type === 'edit' || detail?.type === 'write') && typeof detail.filePath === 'string' ? detail.filePath : undefined;
    const prompts = promptOf(item.name, item.detail);
    return { kind: 'tool', text: '', ...base, ...(writes === undefined ? {} : { writes }), ...(prompts === undefined ? {} : { prompts }) };
  }
  return { kind: 'other', text: '', ...base };
}

/**
 * Paseo 0.9.1 answers a read of an id it never stored (or no longer stores) with an error
 * ("Agent not found: <id>") rather than an empty record. A stored agent that is merely not loaded
 * is still read normally, so this never mistakes a sleeping Peer for a gone one.
 */
function isAgentNotFound(error: unknown): boolean {
  return error instanceof Error && /\bagent\s+not\s+found\b/i.test(error.message);
}

type RawWorkspace = NonNullable<ReturnType<ReturnType<PaseoApi['workspaces']['ref']>['current']>>;

function toWorkspace(id: string, raw: RawWorkspace | null): WorkspaceSnapshot {
  return {
    id,
    directory: raw?.workspaceDirectory ?? null,
    kind: raw?.workspaceKind ?? 'unknown',
    archiving: raw?.archivingAt !== undefined && raw.archivingAt !== null,
  };
}

function agentConfig(input: PeerLaunch & { readonly provider: string }) {
  return {
    provider: `${input.provider}/${input.model}`,
    ...(input.modeId === undefined ? {} : { modeId: input.modeId }),
    ...(input.thinkingOptionId === undefined ? {} : { thinkingOptionId: input.thinkingOptionId }),
  };
}

function identities(input: { readonly agentId?: string; readonly idempotencyKey?: string }) {
  return {
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
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
    async providerCommand(provider) {
      const paseo = await api();
      const config = await paseo.config.get();
      const providers = (config.config as { providers?: Readonly<Record<string, unknown>> }).providers ?? {};
      const entry = (Object.hasOwn(providers, provider) ? providers[provider] : undefined) as { command?: unknown; env?: unknown } | undefined;
      const binary = Array.isArray(entry?.command) ? (entry.command as unknown[])[0] : undefined;
      if (typeof binary !== 'string' || binary === '') return undefined;
      const env = typeof entry?.env === 'object' && entry.env !== null ? entry.env as Record<string, unknown> : {};
      return { binary, env: Object.fromEntries(Object.entries(env).filter((pair): pair is [string, string] => typeof pair[1] === 'string')) };
    },
    async createAgent(input) {
      const paseo = await api();
      try {
        const created = await paseo.agents.create({
          config: agentConfig(input), cwd: input.cwd, ...(input.parentAgentId === undefined ? {} : { parent: input.parentAgentId }),
          title: input.title, labels: { ...input.labels }, ...identities(input),
        });
        return { agentId: created.id };
      } catch (error) {
        throw conflictOr(error);
      }
    },
    async createAgentInWorkspace(workspaceId, input) {
      const paseo = await api();
      try {
        const created = await paseo.workspaces.ref(workspaceId).agents.create({
          config: agentConfig(input), ...(input.parentAgentId === undefined ? {} : { parent: input.parentAgentId }),
          title: input.title, labels: { ...input.labels }, ...identities(input),
        });
        return { agentId: created.id };
      } catch (error) {
        throw conflictOr(error);
      }
    },
    async createWorktreeWorkspace(request) {
      const paseo = await api();
      try {
        const created = await paseo.workspaces.create({
          workspaceId: request.workspaceId, idempotencyKey: request.idempotencyKey, title: request.title,
          source: {
            kind: 'worktree', cwd: request.cwd, action: 'branch-off', refName: request.baseCommit,
            branchName: request.branchName, worktreeSlug: request.worktreeSlug,
          },
        });
        return toWorkspace(created.id, created.current() ?? await created.refresh());
      } catch (error) {
        throw conflictOr(error);
      }
    },
    async openWorkspace(cwd) {
      const paseo = await api();
      const handle = await paseo.workspaces.open({ cwd });
      return { id: handle.id, directory: handle.directory, kind: handle.current()?.workspaceKind ?? 'unknown', archiving: false };
    },
    async getWorkspace(workspaceId) {
      const paseo = await api();
      const current = await paseo.workspaces.ref(workspaceId).refresh();
      return current === null ? undefined : toWorkspace(workspaceId, current);
    },
    async archiveWorkspace(workspaceId) {
      const paseo = await api();
      const result = await paseo.workspaces.archive(workspaceId);
      if (result.error !== null || result.archivedAt === null) throw new Error(result.error ?? 'Paseo returned no archive time for the workspace.');
      return { archivedAt: result.archivedAt };
    },
    async getAgent(agentId) {
      const paseo = await api();
      const ref = paseo.agents.ref(agentId);
      try {
        await ref.refresh();
      } catch (error) {
        if (isAgentNotFound(error)) return undefined;
        throw error;
      }
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
        try {
          await ref.refresh();
        } catch (error) {
          // Deleted between the list and this read: it is simply no longer there.
          if (isAgentNotFound(error)) continue;
          throw error;
        }
        const current = ref.current();
        if (current !== null) snapshots.push(toSnapshot(current));
      }
      return snapshots;
    },
    async run(agentId, text, messageId) {
      const paseo = await api();
      await paseo.agents.ref(agentId).send(text, { messageId });
    },
    async send(agentId, text, messageId, behavior) {
      const paseo = await api();
      // Paseo's typed send options omit `activeTurnBehavior`, but the client forwards its options to
      // the daemon client's sendAgentMessage unchanged, whose options carry it (attention delta §7.4).
      const options = { messageId, activeTurnBehavior: behavior } as Parameters<ReturnType<PaseoApi['agents']['ref']>['send']>[1];
      await paseo.agents.ref(agentId).send(text, options);
    },
    async recentTimeline(agentId, limit) {
      const paseo = await api();
      try {
        const page = await paseo.agents.ref(agentId).timeline.refetch({ limit });
        if (page.error !== null) return [];
        return page.entries.map(entry => toTimelineEntry(entry.item as RawTimelineItem, entry.timestamp, entry.turnId));
      } catch {
        return [];
      }
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
