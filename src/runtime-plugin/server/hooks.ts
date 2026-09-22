/**
 * Creation-time hooks (docs/design/runtime-coordination.md D1, §3.3 Creation hook).
 *
 * The runtime composes only its own MCP server entry and one environment variable onto an
 * agent it recognizes, preserving every field another hook set — including the Claude
 * carrier's `systemPrompt` — so either plugin may run first. Supervisor and Lead get the action
 * bridge. A Peer gets the reporting bridge only when this runtime itself dispatched it and its
 * exact manifest entry carries `peerReporting`; a Peer Lead created some other way is left
 * exactly as it was. Nothing here grants built-in Paseo tools, which stay off for Peer.
 */
import type { PluginBeforeRequests, PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import type { CorrelationRegistry } from './correlations.js';
import type { Recognition } from './recognition.js';

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
