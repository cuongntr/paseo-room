export const ROLES = ['supervisor', 'lead', 'peer'] as const;
export type Role = (typeof ROLES)[number];

export const AGENT_IDS = ['codex', 'claude'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/** Supervisor and Lead orchestrate; Peer executes one brief and gets no room tools. */
export const ROLE_PASEO_TOOLS: Record<Role, boolean> = { supervisor: true, lead: true, peer: false };

export function providerId(agent: AgentId, role: Role): string {
  return `${agent}-${role}`;
}
export function providerLabel(agent: AgentId, role: Role): string {
  const title = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);
  return `${title(agent)} ${title(role)}`;
}
