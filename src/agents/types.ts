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
/**
 * A saved preset in Paseo's agent picker, and what its `list_profiles` tool shows an
 * orchestrating agent. Paseo keeps these in one host-wide array, so the room owns only
 * the fields below and leaves every other field on an existing entry alone.
 */
export interface Profile {
  readonly id: string;
  readonly name: string;
  /** Stable keys from Paseo's profile appearance registry. */
  readonly icon: string;
  readonly color: string;
  readonly provider: string;
  /** The no-prompt mode the seat starts in. */
  readonly modeId: string;
  /** Seeded when the profile is created; the operator's later choice is left in place. */
  readonly thinkingOptionId: string;
  readonly notes: string;
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
  /** Provider environment pins needed to close native control-plane paths. */
  readonly providerEnv?: Readonly<Record<string, string>>;
  /** Paseo mode id that implements this room's bypass-permission default. */
  readonly defaultModeId: string;
  readonly pins: ProviderPins;
  /** Reads the operator's own config; never writes outside the room home. */
  build(layout: Layout, roles: readonly Role[]): Promise<AgentPlan>;
}
