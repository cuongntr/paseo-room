import { readFileSync } from 'node:fs';

export const PROMPT_ASSETS = {
  documents: {
    supervisor: { path: 'documents/supervisor.md', kind: 'head' },
    lead: { path: 'documents/lead.md', kind: 'head' },
    peer: { path: 'documents/peer.md', kind: 'head' },
    workspace: { path: 'documents/workspace.md', kind: 'head' },
  },
  contract: {
    humanAuthority: { path: 'contract/shared/human-authority.md', kind: 'section' },
    workspaceProtocolPrecedence: { path: 'contract/shared/workspace-protocol-precedence.md', kind: 'section' },
    evidenceAndEventWaiting: { path: 'contract/shared/evidence-and-event-waiting.md', kind: 'section' },
    scopeAndUnrelatedWork: { path: 'contract/shared/scope-and-unrelated-work.md', kind: 'section' },
    directiveIntegrity: { path: 'contract/supervisor/directive-integrity.md', kind: 'section' },
    technicalNonInterference: { path: 'contract/supervisor/technical-non-interference.md', kind: 'section' },
    leadDiscoveryAndRecovery: { path: 'contract/supervisor/lead-discovery-and-recovery.md', kind: 'section' },
    observationAndAdvice: { path: 'contract/supervisor/observation-and-advice.md', kind: 'section' },
    escalationBoundaries: { path: 'contract/supervisor/escalation-boundaries.md', kind: 'section' },
    projectTechnicalOwnership: { path: 'contract/lead/project-technical-ownership.md', kind: 'section' },
    movingWriteOwnership: { path: 'contract/lead/moving-write-ownership.md', kind: 'section' },
    completePeerBrief: { path: 'contract/lead/complete-peer-brief.md', kind: 'section' },
    challengeSignals: { path: 'contract/shared-lead-peer/challenge-signals.md', kind: 'section' },
    technicalAcceptance: { path: 'contract/lead/technical-acceptance.md', kind: 'section' },
    independentReview: { path: 'contract/lead/independent-review.md', kind: 'section' },
    peerSeatLifecycle: { path: 'contract/lead/peer-seat-lifecycle.md', kind: 'section' },
    boundedOutcome: { path: 'contract/peer/bounded-outcome.md', kind: 'section' },
    independentJudgment: { path: 'contract/peer/independent-judgment.md', kind: 'section' },
    writingAndReviewScope: { path: 'contract/peer/writing-and-review-scope.md', kind: 'section' },
    noOrchestration: { path: 'contract/peer/no-orchestration.md', kind: 'section' },
    reproducibleHandoff: { path: 'contract/peer/reproducible-handoff.md', kind: 'section' },
    noSelfAcceptance: { path: 'contract/peer/no-self-acceptance.md', kind: 'section' },
  },
  workspace: {
    topology: { path: 'workspace/topology.md', kind: 'section' },
    verification: { path: 'workspace/verification.md', kind: 'section' },
    review: { path: 'workspace/review.md', kind: 'section' },
    repositoryConventions: { path: 'workspace/repository-conventions.md', kind: 'section' },
  },
  pi: {
    communicationStyle: { path: 'pi/communication-style.md', kind: 'capsule' },
    runtime: { path: 'pi/runtime.md', kind: 'capsule' },
  },
} as const;

export type PromptAssetGroup = keyof typeof PROMPT_ASSETS;
export type PromptAssetKey<Group extends PromptAssetGroup> = keyof (typeof PROMPT_ASSETS)[Group];
export type ContractKey = PromptAssetKey<'contract'>;
export type WorkspaceKey = PromptAssetKey<'workspace'>;
export type DocumentKey = PromptAssetKey<'documents'>;
export type PiPromptKey = PromptAssetKey<'pi'>;

type PromptAssetKind = 'head' | 'section' | 'capsule';
interface PromptAssetDefinition {
  readonly path: string;
  readonly kind: PromptAssetKind;
}

export class PromptAssetError extends Error {
  readonly logicalAsset: string;
  readonly assetUrl: URL;

  constructor(logicalAsset: string, assetUrl: URL, detail: string, options?: ErrorOptions) {
    super(`Prompt asset ${logicalAsset} at ${assetUrl.pathname} ${detail} Reinstall paseo-room and try again.`, options);
    this.name = 'PromptAssetError';
    this.logicalAsset = logicalAsset;
    this.assetUrl = assetUrl;
  }
}

const cache = new Map<string, string>();

function definition<Group extends PromptAssetGroup>(
  group: Group,
  key: PromptAssetKey<Group>,
): PromptAssetDefinition {
  const assets = PROMPT_ASSETS[group] as Readonly<Record<string, PromptAssetDefinition>>;
  const asset = assets[String(key)];
  if (asset === undefined) throw new Error(`Unknown prompt asset ${group}.${String(key)}.`);
  return asset;
}

function headingCount(source: string, level: 1 | 2): number {
  const prefix = level === 1 ? '# ' : '## ';
  return source.split('\n').filter(line => line.startsWith(prefix)).length;
}

function validateHeadOrCapsule(source: string, kind: 'head' | 'capsule'): string {
  const trimmed = source.trimEnd();
  if (!trimmed.trim()) throw new Error('is empty.');
  const firstLine = trimmed.split('\n', 1)[0] ?? '';
  if (!/^# \S.*$/.test(firstLine) || headingCount(trimmed, 1) !== 1) {
    throw new Error(`${kind === 'head' ? 'document head' : 'Pi capsule'} must begin with exactly one H1 heading.`);
  }
  return trimmed;
}

function validateSection(source: string): string {
  const trimmed = source.trimEnd();
  if (!trimmed.trim()) throw new Error('is empty.');
  const lines = trimmed.split('\n');
  const heading = lines.shift() ?? '';
  if (!/^## \S.*$/.test(heading) || headingCount(trimmed, 2) !== 1) {
    throw new Error('section must begin with exactly one H2 heading.');
  }
  if (lines.some(line => /^#{1,6}\s/.test(line))) {
    throw new Error('section must not contain additional Markdown headings.');
  }
  const body = lines.join('\n').trim();
  if (!body) throw new Error('section must contain at least one non-empty statement.');
  const statements = body.split(/\n\s*\n/).map(statement =>
    statement.split('\n').map(line => line.trim()).join(' '),
  );
  if (statements.some(statement => !statement)) {
    throw new Error('section must contain only non-empty statements.');
  }
  return `${heading}\n${statements.map(statement => `- ${statement}`).join('\n')}`;
}

export function loadPromptAsset<Group extends PromptAssetGroup>(
  group: Group,
  key: PromptAssetKey<Group>,
): string {
  const logicalAsset = `${group}.${String(key)}`;
  const cached = cache.get(logicalAsset);
  if (cached !== undefined) return cached;

  const asset = definition(group, key);
  const assetUrl = new URL(`./prompts/${asset.path}`, import.meta.url);
  try {
    const source = readFileSync(assetUrl, 'utf8');
    if (source.includes('\uFFFD')) throw new Error('is not valid UTF-8 text.');
    const validated = asset.kind === 'section'
      ? validateSection(source)
      : validateHeadOrCapsule(source, asset.kind);
    cache.set(logicalAsset, validated);
    return validated;
  } catch (error) {
    if (error instanceof PromptAssetError) throw error;
    const detail = error instanceof Error ? error.message : 'could not be read.';
    throw new PromptAssetError(logicalAsset, assetUrl, detail, { cause: error });
  }
}
