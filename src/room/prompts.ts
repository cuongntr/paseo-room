import { readFileSync } from 'node:fs';

export const PROMPT_ASSETS = {
  documents: {
    supervisor: { path: 'documents/supervisor.md', kind: 'head' },
    lead: { path: 'documents/lead.md', kind: 'head' },
    peer: { path: 'documents/peer.md', kind: 'head' },
  },
  contract: {
    sharedAuthority: { path: 'contract/shared-authority.md', kind: 'body' },
    sharedSeatIdentity: { path: 'contract/shared-seat-identity.md', kind: 'section' },
    challengeSignals: { path: 'contract/challenge-signals.md', kind: 'section' },
    supervisor: { path: 'contract/supervisor.md', kind: 'body' },
    lead: { path: 'contract/lead.md', kind: 'body' },
    peer: { path: 'contract/peer.md', kind: 'body' },
  },
  pi: {
    communicationStyle: { path: 'pi/communication-style.md', kind: 'capsule' },
    runtime: { path: 'pi/runtime.md', kind: 'capsule' },
  },
} as const;

export type PromptAssetGroup = keyof typeof PROMPT_ASSETS;
export type PromptAssetKey<Group extends PromptAssetGroup> = keyof (typeof PROMPT_ASSETS)[Group];
export type ContractKey = PromptAssetKey<'contract'>;
export type DocumentKey = PromptAssetKey<'documents'>;
export type PiPromptKey = PromptAssetKey<'pi'>;

type PromptAssetKind = 'head' | 'section' | 'body' | 'capsule';
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

/**
 * Renders one H2 section: the heading verbatim, then each blank-line-delimited statement
 * collapsed onto a single bullet, so authoring line wrapping never reaches a model.
 */
function renderSection(heading: string, bodyLines: readonly string[]): string {
  if (bodyLines.some(line => /^#{1,6}\s/.test(line))) {
    throw new Error('section must not contain additional Markdown headings.');
  }
  const body = bodyLines.join('\n').trim();
  if (!body) throw new Error('section must contain at least one non-empty statement.');
  const statements = body.split(/\n\s*\n/).map(statement =>
    statement.split('\n').map(line => line.trim()).join(' '),
  );
  if (statements.some(statement => !statement)) {
    throw new Error('section must contain only non-empty statements.');
  }
  return `${heading}\n${statements.map(statement => `- ${statement}`).join('\n')}`;
}

function validateSection(source: string): string {
  const trimmed = source.trimEnd();
  if (!trimmed.trim()) throw new Error('is empty.');
  const lines = trimmed.split('\n');
  const heading = lines.shift() ?? '';
  if (!/^## \S.*$/.test(heading) || headingCount(trimmed, 2) !== 1) {
    throw new Error('section must begin with exactly one H2 heading.');
  }
  return renderSection(heading, lines);
}

interface SplitSections {
  readonly preface: readonly string[];
  readonly sections: readonly { readonly heading: string; readonly lines: readonly string[] }[];
}

/** Splits a multi-section asset at its H2 headings, keeping anything before the first one. */
function splitSections(lines: readonly string[]): SplitSections {
  const preface: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of lines) {
    if (/^## \S.*$/.test(line)) {
      sections.push({ heading: line, lines: [] });
      continue;
    }
    const current = sections.at(-1);
    if (current === undefined) preface.push(line);
    else current.lines.push(line);
  }
  return { preface, sections };
}

/** A role body: one or more H2 sections and nothing above the first of them. */
function validateBody(source: string): string {
  const trimmed = source.trimEnd();
  if (!trimmed.trim()) throw new Error('is empty.');
  const { preface, sections } = splitSections(trimmed.split('\n'));
  if (sections.length === 0) throw new Error('role body must contain at least one H2 section.');
  if (preface.some(line => line.trim())) {
    throw new Error('role body must not contain content above its first H2 heading.');
  }
  return sections.map(section => renderSection(section.heading, section.lines)).join('\n\n');
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
    const validated = validate(source, asset.kind);
    cache.set(logicalAsset, validated);
    return validated;
  } catch (error) {
    if (error instanceof PromptAssetError) throw error;
    const detail = error instanceof Error ? error.message : 'could not be read.';
    throw new PromptAssetError(logicalAsset, assetUrl, detail, { cause: error });
  }
}

function validate(source: string, kind: PromptAssetKind): string {
  switch (kind) {
    case 'section': return validateSection(source);
    case 'body': return validateBody(source);
    default: return validateHeadOrCapsule(source, kind);
  }
}
