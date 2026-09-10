import type { Role } from '../roles.js';
import { CLAUSES, SHARED_IDS, type RoleContractId } from './clauses.js';

export type InstructionKind = Role | 'workspace';

const ROLE_IDS: Record<Role, readonly RoleContractId[]> = {
  supervisor: ['RC-101', 'RC-102', 'RC-103', 'RC-104'],
  lead: ['RC-201', 'RC-202', 'RC-203', 'RC-204', 'RC-205', 'RC-206'],
  // Peer needs the challenge protocol as well as its own numbered obligations.
  peer: ['RC-204', 'RC-301', 'RC-302', 'RC-303', 'RC-304', 'RC-305'],
};

const TITLES: Record<InstructionKind, string> = {
  workspace: 'Paseo Room workspace protocol — operator reference/template',
  supervisor: 'Supervisor role instructions',
  lead: 'Lead role instructions',
  peer: 'Peer role instructions',
};

const PREFACES: Record<InstructionKind, string> = {
  workspace: 'Operator reference: copy what you need into a workspace-local docs/WORKSPACE_PROTOCOL.md. Installation never creates or replaces that workspace file.',
  supervisor: 'You are Supervisor, the Human-facing routing seat, not the project Lead.',
  lead: 'You are Lead, the project technical owner under Human authority.',
  peer: 'You are Peer, executing one brief from Lead in writing or read-only review mode.',
};

export function instructionIds(kind: InstructionKind): readonly RoleContractId[] {
  if (kind === 'workspace') return Object.keys(CLAUSES) as RoleContractId[];
  // Every role carries the shared authority contract plus its own obligations.
  return [...SHARED_IDS, ...ROLE_IDS[kind]];
}

export function renderInstructions(kind: InstructionKind): string {
  const sections = instructionIds(kind).map(
    id => `## ${id}\n${CLAUSES[id].map(statement => `- ${statement}`).join('\n')}`,
  );
  return [`# ${TITLES[kind]}`, PREFACES[kind], ...sections].join('\n\n') + '\n';
}
