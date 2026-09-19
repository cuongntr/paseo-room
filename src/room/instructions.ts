import { createHash } from 'node:crypto';
import { ROLES, type Role } from '../roles.js';
import { loadPromptAsset, type ContractKey } from './prompts.js';

export type InstructionKind = Role;

// Every role carries the same authority floor. The layers above it reach only the seats they
// belong to: room-seat identity evidence reaches the two seats that open seats, and the
// challenge vocabulary reaches the two seats that use it. Broadcasting either one is the
// attention cost the model exists to avoid.
const SHARED_KEYS = {
  supervisor: ['sharedAuthority', 'sharedSeatIdentity'],
  lead: ['sharedAuthority', 'sharedSeatIdentity', 'challengeSignals'],
  peer: ['sharedAuthority', 'challengeSignals'],
} as const satisfies Record<Role, readonly ContractKey[]>;

// Exactly one role body per role: the body is the review unit, so the composition cannot
// silently drop or duplicate a role's own obligations.
const ROLE_KEYS = {
  supervisor: 'supervisor',
  lead: 'lead',
  peer: 'peer',
} as const satisfies Record<Role, ContractKey>;

export function instructionKeys(role: Role): readonly ContractKey[] {
  return [...SHARED_KEYS[role], ROLE_KEYS[role]];
}

/**
 * The room composes role documents only. Repository workflow policy is a repository's own
 * optional root `WORKSPACE_PROTOCOL.md`: the room ships no default copy of it, so nothing
 * here can inject a second, hidden workflow document into a seat.
 */
export function renderInstructions(kind: InstructionKind): string {
  return [
    loadPromptAsset('documents', kind),
    ...instructionKeys(kind).map(key => loadPromptAsset('contract', key)),
  ].join('\n\n') + '\n';
}

/** Every document the room composes, in one fixed order, so a digest over them is stable. */
export const INSTRUCTION_KINDS = [...ROLES] as const satisfies readonly InstructionKind[];

/**
 * Identifies the rendered contract generation a room was installed from.
 *
 * Derived from the composed documents rather than the package version: two packages that
 * render identical contracts are the same generation, and editing one prompt asset without a
 * release still changes the digest. Truncated because this is provenance an operator compares
 * by eye, not a security claim.
 */
export function contractDigest(): string {
  const hash = createHash('sha256');
  for (const kind of INSTRUCTION_KINDS) hash.update(`${kind}\u0000${renderInstructions(kind)}\u0000`);
  return `sha256:${hash.digest('hex').slice(0, 16)}`;
}
