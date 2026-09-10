import type { Role } from '../roles.js';
import { CLAUSES, SHARED_IDS, type RoleContractId } from './clauses.js';
import { DEFAULT_PROTOCOL, type ProtocolId } from './workspace.js';

export type InstructionKind = Role | 'workspace';

const ROLE_IDS: Record<Role, readonly RoleContractId[]> = {
  supervisor: ['RC-101', 'RC-102', 'RC-103', 'RC-104'],
  lead: ['RC-201', 'RC-202', 'RC-203', 'RC-204', 'RC-205', 'RC-206'],
  // Peer needs the challenge protocol as well as its own numbered obligations.
  peer: ['RC-204', 'RC-301', 'RC-302', 'RC-303', 'RC-304', 'RC-305'],
};

// Topology is Lead's decision and Supervisor's to audit. RC-303 forbids Peer to
// infer room topology, so handing Peer the topology rules would contradict its
// own contract.
const PROTOCOL_IDS: Record<Role, readonly ProtocolId[]> = {
  supervisor: ['WP-01 Topology', 'WP-02 Verification', 'WP-03 Review', 'WP-04 Repository conventions'],
  lead: ['WP-01 Topology', 'WP-02 Verification', 'WP-03 Review', 'WP-04 Repository conventions'],
  peer: ['WP-02 Verification', 'WP-03 Review', 'WP-04 Repository conventions'],
};

const PREFACES: Record<Role, string> = {
  supervisor: 'You are Supervisor, the Human-facing routing seat, not the project Lead.',
  lead: 'You are Lead, the project technical owner under Human authority.',
  peer: 'You are Peer, executing one brief from Lead in writing or read-only review mode.',
};

const TITLES: Record<Role, string> = {
  supervisor: 'Supervisor role instructions',
  lead: 'Lead role instructions',
  peer: 'Peer role instructions',
};

const PROTOCOL_TITLE = 'Workspace protocol';
// Stated without a clause number, because this preface also heads the copy written
// to the room home, where no clause is present to resolve the reference.
const PROTOCOL_PREFACE = [
  'This is the room default, and it is in force now. A repository that needs different rules',
  'provides `docs/WORKSPACE_PROTOCOL.md`: read it, follow it wherever it speaks to a point,',
  'and keep what follows where it is silent.',
].join('\n');

export function instructionIds(role: Role): readonly RoleContractId[] {
  // Every role carries the shared authority contract plus its own obligations.
  return [...SHARED_IDS, ...ROLE_IDS[role]];
}

export function protocolIds(role: Role): readonly ProtocolId[] {
  return PROTOCOL_IDS[role];
}

function sections(ids: readonly string[], source: Readonly<Record<string, readonly string[]>>): string[] {
  return ids.map(id => `## ${id}\n${(source[id] ?? []).map(statement => `- ${statement}`).join('\n')}`);
}

/** The protocol travels inside every role document, so no repository has to opt in. */
function protocol(ids: readonly ProtocolId[]): string[] {
  return [`# ${PROTOCOL_TITLE}`, PROTOCOL_PREFACE, ...sections(ids, DEFAULT_PROTOCOL)];
}

export function renderInstructions(kind: InstructionKind): string {
  if (kind === 'workspace') {
    return protocol(Object.keys(DEFAULT_PROTOCOL) as ProtocolId[]).join('\n\n') + '\n';
  }
  return [
    `# ${TITLES[kind]}`,
    PREFACES[kind],
    ...sections(instructionIds(kind), CLAUSES),
    ...protocol(protocolIds(kind)),
  ].join('\n\n') + '\n';
}
