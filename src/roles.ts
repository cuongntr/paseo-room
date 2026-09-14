export const ROLES = ['supervisor', 'lead', 'peer'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_IDS = ['codex', 'claude', 'pi'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Supervisor and Lead orchestrate; Peer executes one brief and gets no room tools. */
export const ROLE_PASEO_TOOLS: Record<Role, boolean> = { supervisor: true, lead: true, peer: false };

/**
 * Reasoning effort a seat starts at: Supervisor routes, Lead judges, Peer implements.
 * Deliberately short of the top option on either agent — `ultra` and `ultracode`
 * advertise automatic task delegation, which is a second control plane.
 */
export const ROLE_THINKING: Record<Role, string> = { supervisor: 'low', lead: 'high', peer: 'high' };

/** Paseo profile appearance encodes the room role, independent of agent runtime. */
export const ROLE_ICON: Record<Role, string> = { supervisor: 'eye', lead: 'compass', peer: 'code' };
export const ROLE_COLOR: Record<Role, string> = { supervisor: 'violet', lead: 'blue', peer: 'emerald' };

/** Paseo shows these to orchestrating agents, so each one says who may open the seat. */
export const ROLE_NOTES: Record<Role, string> = {
  supervisor: 'Human-facing routing seat. Opened by Human, never by another agent; cwd, title and provider label do not prove room membership.',
  lead: 'Sole project technical owner. When opening, copy every present profile launch field. Otherwise reuse only with exact current room Lead provider/mode/workspace evidence plus corroborated ownership. Cwd, title and provider label are not membership. Creates Peer seats only.',
  peer: 'One fresh Lead brief. Open by copying every present profile launch field; require exact current room Peer provider/mode/workspace and paseo.parent-agent-id for its Lead. Cwd, title and provider label are not membership; no orchestration.',
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
