/**
 * Creation-time hooks (docs/design/runtime-coordination.md D1, §3.3 Creation hook).
 *
 * The runtime composes only its own MCP server entry and one environment variable onto an
 * agent it recognizes, preserving every field another hook set — including the Claude
 * carrier's `systemPrompt` — so either plugin may run first. Supervisor and Lead get the action
 * bridge. A Peer gets the reporting bridge only when this runtime itself dispatched it and its
 * exact manifest entry carries `peerReporting`; a Peer Lead created some other way is left
 * exactly as it was. Nothing here grants built-in Paseo tools, which stay off for Peer.
 *
 * The runtime may add one more variable, Claude's compact window, to a room Claude seat whose role
 * has a compact mark (seat context delta K-D3): at creation, from the model the agent is created
 * with, and at every session open, which may change only the environment and also reaches a resumed
 * session, which the creation hook never sees.
 */
import type { PluginBeforeRequests, PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { COMPACT_WINDOW_ENV, compactMarkFor, markTokens, type SeatContextSettings } from '../shared/seat-context.js';
import type { CorrelationRegistry } from './correlations.js';
import type { PaseoPort } from './paseo-port.js';
import type { Recognition } from './recognition.js';
import { withTimeout } from './timeout.js';

export const BRIDGE_SERVER_NAME = 'paseo_room';
export const CORRELATION_ENV = 'PASEO_ROOM_CORRELATION';

export type AgentCreateRequest = PluginBeforeRequests['agent.create'];

export interface HookDependencies {
  readonly recognition: Recognition;
  readonly correlations: CorrelationRegistry;
  readonly nodePath: string;
  readonly bridgeScript: string;
  readonly runtimeRoot: string;
}

export function transformAgentCreate(request: AgentCreateRequest, deps: HookDependencies): AgentCreateRequest | undefined {
  const { config } = request;
  // Paseo's internal agents are ephemeral system tasks, never room seats.
  if (config.internal === true) return undefined;
  const seat = deps.recognition.recognize(config.provider);
  if (seat === undefined) return undefined;
  // Already composed (or a foreign server of that name): never overwrite it.
  if (config.mcpServers !== undefined && Object.hasOwn(config.mcpServers, BRIDGE_SERVER_NAME)) return undefined;

  let correlation;
  if (seat.role === 'peer') {
    if (seat.peerReporting === undefined) return undefined;
    const expected = deps.correlations.takeExpectedPeerCreate(seat.providerId, config.title ?? '');
    if (expected === undefined) return undefined;
    correlation = deps.correlations.mint('peer', 'peer', seat.providerId, { assignmentId: expected.assignmentId, workKind: expected.workKind });
  } else {
    correlation = deps.correlations.mint('action', seat.role, seat.providerId);
  }

  const bridgeEnv: Record<string, string> = {
    PASEO_ROOM_RUNTIME_ROOT: deps.runtimeRoot,
    [CORRELATION_ENV]: correlation.id,
    PASEO_ROOM_ROLE: seat.role,
    ...(correlation.workKind === undefined ? {} : { PASEO_ROOM_WORK_KIND: correlation.workKind }),
  };
  return {
    ...request,
    config: {
      ...config,
      mcpServers: {
        ...(config.mcpServers ?? {}),
        [BRIDGE_SERVER_NAME]: { type: 'stdio', command: deps.nodePath, args: [deps.bridgeScript], env: bridgeEnv },
      },
    },
    env: { ...(request.env ?? {}), [CORRELATION_ENV]: correlation.id },
  };
}

export type SessionOpenOutcome = Awaited<ReturnType<CorrelationRegistry['associate']>> | 'not-runtime';

/** Associates the correlation this session carries. It never activates a binding by itself. */
export async function handleSessionOpen(request: PluginSessionOpenRequest, deps: HookDependencies): Promise<SessionOpenOutcome> {
  const id = request.env[CORRELATION_ENV];
  if (id === undefined || deps.recognition.recognize(request.provider) === undefined) return 'not-runtime';
  return await deps.correlations.associate(id, request.agentId, request.workspaceId, request.provider);
}

export interface CompactMarkDependencies {
  readonly recognition: Pick<Recognition, 'recognize'>;
  readonly paseo: Pick<PaseoPort, 'getAgent' | 'resolveLaunch' | 'modelWindow'>;
  readonly settings: () => SeatContextSettings;
  /** Settles once the budgets were first read from the settings store; until then the defaults would apply. */
  readonly settingsRead?: () => Promise<unknown>;
  readonly log?: (message: string) => void;
  /** How long the lookup may take before the seat starts without a mark; 5 s by default. */
  readonly lookupMs?: number;
  /** Whether a seat is a Lead asked for its handoff, which resumes without a mark (seat context K2 plan §2). */
  readonly exempt?: (agentId: string) => Promise<boolean>;
}

/**
 * Paseo gives a plugin's before hook 30 s and fails the agent's creation or session open when it
 * runs out, and a model list can wait for a provider's warm-up at daemon start. A lookup that runs
 * longer than this bound leaves the seat without a mark; finishing late, it still fills the cache.
 */
const LOOKUP_MS = 5_000;

/**
 * `env` with Claude's compact window for this seat, or undefined to leave it as it is: only an exact
 * room seat whose compact mark reaches it and fits the window of `model` (the room profile's model
 * when that is unknown) receives it, and a value already set, by another plugin, is kept. Any failure
 * or a lookup past its bound leaves the environment unchanged: a seat never fails to start over a
 * budget.
 */
async function markedEnv(provider: string, env: Readonly<Record<string, string>>, model: () => Promise<string | undefined>, who: string, deps: CompactMarkDependencies): Promise<Record<string, string> | undefined> {
  const seat = deps.recognition.recognize(provider);
  if (seat === undefined || Object.hasOwn(env, COMPACT_WINDOW_ENV)) return undefined;
  const lookup = async (): Promise<number | undefined> => {
    await deps.settingsRead?.();
    const percent = compactMarkFor(deps.settings(), seat);
    if (percent === null) return undefined;
    const chosen = (await model()) ?? (await deps.paseo.resolveLaunch(provider))?.model;
    return chosen === undefined ? undefined : markTokens(percent, await deps.paseo.modelWindow(provider, chosen));
  };
  const limit = deps.lookupMs ?? LOOKUP_MS;
  try {
    const tokens = await withTimeout(lookup(), limit, `the lookup took longer than ${String(limit)} ms`);
    return tokens === undefined ? undefined : { ...env, [COMPACT_WINDOW_ENV]: String(tokens) };
  } catch (error) {
    deps.log?.(`No compact mark for ${who}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * A new agent's request with Claude's compact window set from the model it is created with
 * (docs/design/runtime-coordination-seat-context.md K-D3), or undefined to leave it as it is. Paseo
 * passes this environment on to the session it opens next.
 */
export async function compactMarkOnCreate(request: AgentCreateRequest, deps: CompactMarkDependencies): Promise<AgentCreateRequest | undefined> {
  const { config } = request;
  if (config.internal === true) return undefined;
  const env = await markedEnv(config.provider, request.env ?? {}, () => Promise.resolve(config.model), `a new ${config.provider} agent`, deps);
  return env === undefined ? undefined : { ...request, env };
}

/**
 * A resumed session's request with Claude's compact window set from the agent's own model (K-D3),
 * or undefined to leave it as it is. A session opened for creation is the creation hook's: a seat
 * whose mark it could not set opens without one rather than wait on a second lookup. A Lead asked
 * for its handoff opens without one too: past its mark, it would compact before writing it.
 */
export async function compactMarkEnv(request: PluginSessionOpenRequest, deps: CompactMarkDependencies): Promise<PluginSessionOpenRequest | undefined> {
  if (request.purpose !== 'interactive' || request.reason === 'create') return undefined;
  if (await deps.exempt?.(request.agentId).catch(() => false) === true) return undefined;
  const own = async (): Promise<string | undefined> => (await deps.paseo.getAgent(request.agentId))?.model ?? undefined;
  const env = await markedEnv(request.provider, request.env, own, `agent ${request.agentId}`, deps);
  return env === undefined ? undefined : { ...request, env };
}
