import type { Entry } from '../fsops.js';
import type { Check } from '../result.js';
import type { AgentId, Role } from '../roles.js';
import type { Layout } from '../layout.js';

export interface Provider {
  readonly extends: AgentId;
  readonly label: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly paseoTools: { readonly enabled: boolean };
  /** Launch parameters Paseo passes to the agent, outranking its own mode preset. */
  readonly params?: Readonly<Record<string, string>>;
  /** Native tools the seat must not receive, whatever the agent's own config says. */
  readonly disallowedTools?: readonly string[];
}
/** Provider-level pins: what the room must hold regardless of the agent's own config. */
export type ProviderPins = Pick<Provider, 'params' | 'disallowedTools'>;
export interface AgentPlan {
  readonly entries: readonly Entry[];
  readonly checks: readonly Check[];
  /** Absent when the agent cannot be seated; the checks say why. */
  readonly binary?: string;
}
export interface Agent {
  readonly id: AgentId;
  readonly label: string;
  /** The environment variable that points this agent at a role home. */
  readonly homeEnv: string;
  readonly pins: ProviderPins;
  /** Reads the operator's own config; never writes outside the room home. */
  build(layout: Layout, roles: readonly Role[]): Promise<AgentPlan>;
}
