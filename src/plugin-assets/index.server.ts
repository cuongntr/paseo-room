/**
 * Room contract carrier for Claude seats, as a Paseo v0.8 server plugin.
 *
 * Paseo launches Claude through the Claude Agent SDK, so no provider-owned argv can carry an
 * additive system prompt (see docs/design.md §6). `AgentSessionConfig.systemPrompt` is the one
 * strong additive channel, and it exists only at creation time — which is exactly what the
 * `agent.create` before-hook can change. Paseo's Claude provider maps that value to the SDK's
 * `{ type: "preset", preset: "claude_code", append }`, so the vendor prompt is kept and the
 * room contract is appended to it.
 *
 * Deliberately dependency-free: the daemon compiles this directory as-is, so it imports no SDK
 * and no package. The types below describe only the fields this hook reads or writes.
 */
import { composeSystemPrompt, hasExactContract } from './server/carrier.js';
import { CONTRACT, GENERATION } from './server/contract.js';

export interface RoomAgentCreateRequest {
  readonly config: {
    readonly provider: string;
    readonly systemPrompt?: string;
    readonly internal?: boolean;
  };
}

interface RoomServerContext {
  before(
    name: 'agent.create',
    handler: (input: { readonly request: RoomAgentCreateRequest }) => RoomAgentCreateRequest | undefined,
  ): () => void;
}

export function transformAgentCreate(
  request: RoomAgentCreateRequest,
  contracts: Readonly<Record<string, string>> = CONTRACT,
  generation = GENERATION,
): RoomAgentCreateRequest | undefined {
  // Internal agents are Paseo's own ephemeral system tasks: they are not room seats.
  if (request.config.internal === true) return undefined;
  // Exact room provider ids only. An operator's own Claude provider is never touched.
  const contract = Object.entries(contracts).find(([id]) => id === request.config.provider)?.[1];
  if (contract === undefined) return undefined;
  if (hasExactContract(request.config.systemPrompt, contract, generation)) return undefined;
  const systemPrompt = composeSystemPrompt(request.config.systemPrompt, contract, generation);
  return { ...request, config: { ...request.config, systemPrompt } };
}

export default function contribute(server: RoomServerContext): () => void {
  const dispose = server.before('agent.create', ({ request }) => transformAgentCreate(request));
  return () => { dispose(); };
}
