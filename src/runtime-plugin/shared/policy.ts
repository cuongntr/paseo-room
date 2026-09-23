/**
 * The runtime role-policy projection: which runtime operations each room role may invoke.
 *
 * This is the single source for both the CLI, which writes it into the generated room manifest,
 * and the plugin's authorization. It is deliberately not `ROLE_PASEO_TOOLS`: Paseo's built-in
 * room tools stay off for Peer, and the only runtime surface a Peer can ever hold is the
 * assignment-scoped reporting pair (docs/design/runtime-coordination.md D4, §3.4).
 */

export const RUNTIME_ROLES = ['supervisor', 'lead', 'peer'] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export const RUNTIME_AGENTS = ['codex', 'claude', 'pi'] as const;
export type RuntimeAgent = (typeof RUNTIME_AGENTS)[number];

export const SUPERVISOR_OPERATIONS = ['room_status', 'runtime_findings', 'message_lead'] as const;
export const LEAD_OPERATIONS = [
  'assignment_create', 'assignment_dispatch', 'assignment_answer', 'assignment_rework',
  'assignment_accept', 'assignment_reject', 'assignment_abandon', 'assignment_close',
  'assignment_status', 'gate_run', 'workspace_close', 'lease_reclaim',
] as const;
/** A closed tuple. Adding a Peer operation is an authority and protocol revision, not a patch. */
export const PEER_REPORTING_TOOLS = ['ask', 'handoff'] as const;

export type SupervisorOperation = (typeof SUPERVISOR_OPERATIONS)[number];
export type LeadOperation = (typeof LEAD_OPERATIONS)[number];
export type PeerReportingTool = (typeof PEER_REPORTING_TOOLS)[number];
export type RuntimeCapability = SupervisorOperation | LeadOperation | PeerReportingTool;

export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  ...SUPERVISOR_OPERATIONS, ...LEAD_OPERATIONS, ...PEER_REPORTING_TOOLS,
];

export interface PeerReportingDeclaration {
  readonly protocol: 1;
  readonly tools: readonly ['ask', 'handoff'];
  readonly qualifiedVia: 'exact-room-provider';
}

export interface RuntimeRolePolicy {
  readonly capabilities: readonly RuntimeCapability[];
  readonly peerReporting?: PeerReportingDeclaration;
}

export const PEER_REPORTING_DECLARATION: PeerReportingDeclaration = {
  protocol: 1,
  tools: ['ask', 'handoff'],
  qualifiedVia: 'exact-room-provider',
};

/**
 * Projects one role's runtime capabilities. `peerReportingEligible` comes from the canonical
 * `ROLE_PEER_REPORTING` policy; a Peer that is not eligible holds no runtime operation at all.
 */
export function runtimeRolePolicy(role: RuntimeRole, peerReportingEligible: boolean): RuntimeRolePolicy {
  if (role === 'supervisor') return { capabilities: [...SUPERVISOR_OPERATIONS] };
  if (role === 'lead') return { capabilities: [...LEAD_OPERATIONS] };
  return peerReportingEligible
    ? { capabilities: [...PEER_REPORTING_TOOLS], peerReporting: PEER_REPORTING_DECLARATION }
    : { capabilities: [] };
}
