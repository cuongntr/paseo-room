import { createHash } from 'node:crypto';
import { ROLES, type Role } from '../roles.js';
import {
  loadPromptAsset,
  type ContractKey,
  type WorkspaceKey,
} from './prompts.js';

export type InstructionKind = Role | 'workspace';

// Every role carries the same authority contract; Workspace Protocol Precedence is not part
// of it. That layer reaches only the seats that read a repository's protocol: the model gives
// it to Lead, and to Supervisor when auditing, while Peer receives the constraints that bear
// on its brief quoted into the brief. Telling Peer about the file is the broadcast the model
// exists to avoid.
const AUTHORITY_KEYS = [
  'humanAuthority',
  'evidenceAndEventWaiting',
  'scopeAndUnrelatedWork',
] as const satisfies readonly ContractKey[];

const PROTOCOL_READER_KEYS = [
  'humanAuthority',
  'workspaceProtocolPrecedence',
  'evidenceAndEventWaiting',
  'scopeAndUnrelatedWork',
] as const satisfies readonly ContractKey[];

const SHARED_KEYS = {
  supervisor: PROTOCOL_READER_KEYS,
  lead: PROTOCOL_READER_KEYS,
  peer: AUTHORITY_KEYS,
} as const satisfies Record<Role, readonly ContractKey[]>;

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
    'assignmentScope',
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

// The workspace layer belongs to the seats that own workflow: Lead decides it and
// Supervisor audits it. Peer receives none of it, so its attention stays on one brief and
// the brief remains the only channel for repository-local constraints.
const PROTOCOL_KEYS = {
  supervisor: ALL_PROTOCOL_KEYS,
  lead: ALL_PROTOCOL_KEYS,
  peer: [],
} as const satisfies Record<Role, readonly WorkspaceKey[]>;

export function instructionKeys(role: Role): readonly ContractKey[] {
  // Every role carries the shared authority contract plus its own obligations.
  return [...SHARED_KEYS[role], ...ROLE_KEYS[role]];
}

export function protocolKeys(role: Role): readonly WorkspaceKey[] {
  return PROTOCOL_KEYS[role];
}

function protocol(keys: readonly WorkspaceKey[]): string[] {
  // A preface introducing sections that follow is noise when none of them do.
  if (keys.length === 0) return [];
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
