import type { Role } from '../roles.js';
import { CLAUSES, SHARED_IDS, type RoleContractId } from './clauses.js';
import { DEFAULT_PROTOCOL } from './workspace.js';

export type InstructionKind = Role | 'workspace';

const ROLE_IDS: Record<Role, readonly RoleContractId[]> = {
  supervisor: ['RC-101', 'RC-102', 'RC-103', 'RC-104'],
  lead: ['RC-201', 'RC-202', 'RC-203', 'RC-204', 'RC-205', 'RC-206'],
  // Peer needs the challenge protocol as well as its own numbered obligations.
  peer: ['RC-204', 'RC-301', 'RC-302', 'RC-303', 'RC-304', 'RC-305'],
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
const PROTOCOL_PREFACE = [
  'This is the room default, and it is in force now. A repository that needs different rules',
  'provides `docs/WORKSPACE_PROTOCOL.md`; read that instead when it exists, per RC-002. It',
  'replaces what follows rather than adding to it.',
].join('\n');

export function instructionIds(role: Role): readonly RoleContractId[] {
  // Every role carries the shared authority contract plus its own obligations.
  return [...SHARED_IDS, ...ROLE_IDS[role]];
}

function sections(entries: Readonly<Record<string, readonly string[]>>): string[] {
  return Object.entries(entries).map(
    ([id, statements]) => `## ${id}\n${statements.map(statement => `- ${statement}`).join('\n')}`,
  );
}

/** The protocol travels inside every role document, so no repository has to opt in. */
function protocol(): string[] {
  return [`# ${PROTOCOL_TITLE}`, PROTOCOL_PREFACE, ...sections(DEFAULT_PROTOCOL)];
}

export function renderInstructions(kind: InstructionKind): string {
  if (kind === 'workspace') return protocol().join('\n\n') + '\n';
  const contract = Object.fromEntries(instructionIds(kind).map(id => [id, CLAUSES[id]]));
  return [`# ${TITLES[kind]}`, PREFACES[kind], ...sections(contract), ...protocol()].join('\n\n') + '\n';
}
