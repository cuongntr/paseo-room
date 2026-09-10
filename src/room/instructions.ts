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
  workspace: 'Workspace protocol — template for a repository docs/WORKSPACE_PROTOCOL.md',
  supervisor: 'Supervisor role instructions',
  lead: 'Lead role instructions',
  peer: 'Peer role instructions',
};

const PREFACES: Record<InstructionKind, string> = {
  workspace: [
    'This file is a template, and nothing reads it where it sits. Copy it into a repository as',
    '`docs/WORKSPACE_PROTOCOL.md` — the exact path RC-002 names — and cut it down to that project.',
    'paseo-room never writes that file.',
    '',
    'Precedence: Human authority and the role contract reproduced below come first. A repository may',
    'add project-local detail — conventions, validation commands, narrower write scopes, escalation',
    'routes — and RC-002 states exactly what such detail may not weaken. Keep your copy to that detail;',
    'the clauses below are already delivered to every seat, so repeating them in the repository broadcasts',
    'the whole contract to seats that were deliberately given only part of it.',
  ].join('\n'),
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
