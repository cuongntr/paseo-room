export const ROLES = ['supervisor', 'lead', 'peer'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_IDS = ['codex', 'claude', 'pi'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Supervisor and Lead orchestrate; Peer executes one brief and gets no room tools. */
export const ROLE_PASEO_TOOLS: Record<Role, boolean> = { supervisor: true, lead: true, peer: false };

/**
 * Whether a role may be given the opt-in runtime coordinator's assignment-scoped reporting
 * pair, `ask` and `handoff`. This is deliberately not `ROLE_PASEO_TOOLS`: that field is Paseo's
 * native room-tool policy and stays off for Peer, because reporting one's own assignment is not
 * room access. Supervisor and Lead already report through room tools, so only Peer needs it.
 *
 * The flag authorizes nothing by itself. The CLI never writes a reporting server, and no
 * generated provider changes shape from this constant; an installed runtime plugin is the only
 * thing that can act on it, and only for the exact provider it manages. Keeping the two
 * policies separate is the point: a reader can see that granting a report did not grant a
 * control plane, and `verify` still fails if Peer's `paseoTools.enabled` ever flips.
 */
export const ROLE_PEER_REPORTING: Record<Role, boolean> = { supervisor: false, lead: false, peer: true };

/**
 * Reasoning effort a seat starts at: Supervisor routes, Lead judges, Peer implements.
 * Deliberately short of the top option on either agent — `ultra` and `ultracode`
 * advertise automatic task delegation, which is a second control plane.
 */
export const ROLE_THINKING: Record<Role, string> = { supervisor: 'low', lead: 'high', peer: 'high' };

/**
 * The top option on either agent, which Paseo advertises as maximum reasoning with automatic
 * task delegation. Whether it can still delegate once the room has closed the native
 * multi-agent paths is unverified, so selecting one is reported and never rejected.
 */
export const DELEGATING_THINKING = ['ultra', 'ultracode'] as const;

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
