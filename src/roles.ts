export const ROLES = ['supervisor', 'lead', 'peer'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_IDS = ['codex', 'claude'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Supervisor and Lead orchestrate; Peer executes one brief and gets no room tools. */
export const ROLE_PASEO_TOOLS: Record<Role, boolean> = { supervisor: true, lead: true, peer: false };

/**
 * Reasoning effort a seat starts at: Supervisor routes, Lead judges, Peer implements.
 * Deliberately short of the top option on either agent — `ultra` and `ultracode`
 * advertise automatic task delegation, which is a second control plane.
 */
export const ROLE_THINKING: Record<Role, string> = { supervisor: 'low', lead: 'high', peer: 'high' };

/** Paseo shows these to orchestrating agents, so each one says who may open the seat. */
export const ROLE_NOTES: Record<Role, string> = {
  supervisor: 'Human-facing routing seat. Opened by Human, never by another agent.',
  lead: 'Project technical owner. Opened by Human or Supervisor. Creates Peer seats only.',
  peer: 'Runs one Lead brief, writing or read-only. Created by Lead, one per brief, closed with it.',
};

export function providerId(agent: AgentId, role: Role): string {
  return `${agent}-${role}`;
}
/** Distinct from the provider id: a host may already have a profile by that name. */
export function profileId(agent: AgentId, role: Role): string {
  return `room-${agent}-${role}`;
}
export function providerLabel(agent: AgentId, role: Role): string {
  const title = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
  return `${title(agent)} ${title(role)}`;
}
