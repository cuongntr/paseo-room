import type { RoomRole } from '../roles.js';
import { CLAUSES, SHARED_IDS, type RoleContractId } from './clauses.js';

export type InstructionKind = RoomRole | 'model' | 'workspace';

const ROLE_IDS = {
  supervisor: ['RC-101', 'RC-102', 'RC-103', 'RC-104'],
  lead: ['RC-201', 'RC-202', 'RC-203', 'RC-204', 'RC-205', 'RC-206'],
  // Peer needs the challenge protocol as well as its own numbered obligations.
  peer: ['RC-204', 'RC-301', 'RC-302', 'RC-303', 'RC-304', 'RC-305'],
} as const satisfies Record<RoomRole, readonly RoleContractId[]>;

const TITLES: Record<InstructionKind, string> = {
  model: 'Paseo Room shared model instructions',
  workspace: 'Paseo Room workspace protocol — operator reference/template',
  supervisor: 'Supervisor developer instructions',
  lead: 'Lead developer instructions',
  peer: 'Peer developer instructions',
};

const PREFACES: Record<InstructionKind, string> = {
  model: 'The authority route is Human → Supervisor → Lead → Peer. Apply the shared rules together with your assigned role instructions; never assume another role.',
  workspace: 'Operator: this installer-owned room/workspace-protocol.md is a reference/template, not a link in any role home. You may use it to author workspace-local docs/WORKSPACE_PROTOCOL.md; installation does not create or replace that workspace file. The clauses below are the authority matrix in agent-readable form.',
  supervisor: 'You are Supervisor, the Human-facing routing seat, not the project Lead.',
  lead: 'You are Lead, the project technical owner under Human authority.',
  peer: 'You are Peer, executing one brief from Lead in writing or read-only review mode.',
};

export function instructionIds(kind: InstructionKind): readonly RoleContractId[] {
  if (kind === 'model') return [...SHARED_IDS];
  if (kind === 'workspace') return Object.keys(CLAUSES) as RoleContractId[];
  return [...SHARED_IDS, ...ROLE_IDS[kind]];
}

export function renderInstructions(kind: InstructionKind): string {
  const sections = instructionIds(kind).map(id =>
    `## ${id}\n${CLAUSES[id].map(statement => `- ${statement}`).join('\n')}`,
  );
  return [`# ${TITLES[kind]}`, PREFACES[kind], ...sections].join('\n\n') + '\n';
}

export function renderModelInstructions(): string {
  return renderInstructions('model');
}

export function renderDeveloperInstructions(role: RoomRole): string {
  return renderInstructions(role);
}

export function renderWorkspaceProtocol(): string {
  return renderInstructions('workspace');
}

export interface InstructionViolation {
  readonly id: RoleContractId | 'document';
  readonly reason: string;
}

/**
 * Fail-closed validator for repository-generated assets, NOT an NLP checker for
 * arbitrary workspace prose. Only reviewed statements are admitted, so retaining
 * required words while adding a contradictory grant cannot pass. No user content
 * is echoed in diagnostics. Harmless statement/section reordering is accepted.
 */
export function validateInstructions(kind: InstructionKind, text: string): InstructionViolation[] {
  const violations: InstructionViolation[] = [];
  const sections = text.trim().split(/\n\s*\n/);
  if (sections.shift() !== `# ${TITLES[kind]}` || sections.shift() !== PREFACES[kind]) {
    violations.push({ id: 'document', reason: 'Unrecognized title or authority preface.' });
  }
  const required = instructionIds(kind);
  const seen = new Set<RoleContractId>();
  for (const section of sections) {
    const [heading, ...lines] = section.split('\n');
    const id = required.find(candidate => heading === `## ${candidate}`);
    if (id === undefined) {
      violations.push({ id: 'document', reason: 'Unapproved instruction section.' });
      continue;
    }
    if (seen.has(id)) violations.push({ id, reason: 'Duplicate contract section.' });
    seen.add(id);
    const approved: readonly string[] = CLAUSES[id].map(statement => `- ${statement}`);
    if (lines.length !== approved.length || new Set(lines).size !== lines.length ||
        lines.some(line => !approved.includes(line)) || approved.some(line => !lines.includes(line))) {
      violations.push({ id, reason: 'Missing or unapproved semantic statement.' });
    }
  }
  for (const id of required) {
    if (!seen.has(id)) violations.push({ id, reason: 'Missing required contract section.' });
  }
  return violations;
}
