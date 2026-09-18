import { createHash } from 'node:crypto';
import { ROLES, type Role } from '../roles.js';
import {
  loadPromptAsset,
  type ContractKey,
  type WorkspaceKey,
} from './prompts.js';

export type InstructionKind = Role | 'workspace';

const SHARED_KEYS = [
  'humanAuthority',
  'workspaceProtocolPrecedence',
  'evidenceAndEventWaiting',
  'scopeAndUnrelatedWork',
] as const satisfies readonly ContractKey[];

const ROLE_KEYS = {
  supervisor: [
    'directiveIntegrity',
    'technicalNonInterference',
    'leadDiscoveryAndRecovery',
    'observationAndAdvice',
    'escalationBoundaries',
  ],
  lead: [
    'projectTechnicalOwnership',
    'movingWriteOwnership',
    'completePeerBrief',
    'challengeSignals',
    'technicalAcceptance',
    'independentReview',
    'peerSeatLifecycle',
  ],
  // Peer needs Challenge Signals as well as its own obligations.
  peer: [
    'challengeSignals',
    'boundedOutcome',
    'independentJudgment',
    'writingAndReviewScope',
    'noOrchestration',
    'reproducibleHandoff',
    'noSelfAcceptance',
  ],
} as const satisfies Record<Role, readonly ContractKey[]>;

const ALL_PROTOCOL_KEYS = [
  'topology',
  'verification',
  'review',
  'repositoryConventions',
] as const satisfies readonly WorkspaceKey[];

// Topology is Lead's decision and Supervisor's to audit. No Orchestration forbids Peer to
// infer room topology, so handing Peer the topology rules would contradict its own contract.
const PROTOCOL_KEYS = {
  supervisor: ALL_PROTOCOL_KEYS,
  lead: ALL_PROTOCOL_KEYS,
  peer: ['verification', 'review', 'repositoryConventions'],
} as const satisfies Record<Role, readonly WorkspaceKey[]>;

export function instructionKeys(role: Role): readonly ContractKey[] {
  // Every role carries the shared authority contract plus its own obligations.
  return [...SHARED_KEYS, ...ROLE_KEYS[role]];
}

export function protocolKeys(role: Role): readonly WorkspaceKey[] {
  return PROTOCOL_KEYS[role];
}

function protocol(keys: readonly WorkspaceKey[]): string[] {
  return [
    loadPromptAsset('documents', 'workspace'),
    ...keys.map(key => loadPromptAsset('workspace', key)),
  ];
}

export function renderInstructions(kind: InstructionKind): string {
  if (kind === 'workspace') return protocol(ALL_PROTOCOL_KEYS).join('\n\n') + '\n';
  return [
    loadPromptAsset('documents', kind),
    ...instructionKeys(kind).map(key => loadPromptAsset('contract', key)),
    ...protocol(protocolKeys(kind)),
  ].join('\n\n') + '\n';
}

/** Every document the room composes, in one fixed order, so a digest over them is stable. */
export const INSTRUCTION_KINDS = [...ROLES, 'workspace'] as const satisfies readonly InstructionKind[];

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
