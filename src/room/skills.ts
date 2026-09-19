import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from '../fsops.js';
import type { Layout } from '../layout.js';
import { sharedRoom } from '../layout.js';
import type { AgentId } from '../roles.js';

/**
 * The one room-owned Agent Skill. The name is also the child name inside a Lead role home, so
 * an operator skill of the same name is not linked there: the room-owned copy owns that name
 * inside the room, and the operator's own directory is never touched.
 */
export const ROOM_SKILL_NAME = 'paseo-project-onboarding';

/**
 * The skill's exact shape: directories the room creates and files it writes, and nothing else.
 * Ownership is declared here rather than inferred from a recursive copy, so a stray file in the
 * package cannot become a managed path.
 */
const SKILL_DIRECTORIES = ['references'] as const;
const SKILL_FILES = ['SKILL.md', 'references/workspace-protocol-template.md'] as const;

export class SkillAssetError extends Error {
  readonly logicalAsset: string;
  readonly assetUrl: URL;

  constructor(logicalAsset: string, assetUrl: URL, detail: string, options?: ErrorOptions) {
    super(`Skill asset ${logicalAsset} at ${assetUrl.pathname} ${detail} Reinstall paseo-room and try again.`, options);
    this.name = 'SkillAssetError';
    this.logicalAsset = logicalAsset;
    this.assetUrl = assetUrl;
  }
}

const cache = new Map<string, string>();

function validateSkillAsset(path: string, source: string): string {
  if (source.includes('\uFFFD')) throw new Error('is not valid UTF-8 text.');
  if (!source.trim()) throw new Error('is empty.');
  if (path === 'SKILL.md') {
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
    if (frontmatter === undefined) throw new Error('must begin with YAML frontmatter.');
    const declaredName = /^name: (.+)$/m.exec(frontmatter)?.[1];
    if (declaredName !== ROOM_SKILL_NAME) {
      throw new Error(`frontmatter name must be ${ROOM_SKILL_NAME}.`);
    }
    if (!/^description: \S.+$/m.test(frontmatter)) {
      throw new Error('frontmatter must contain a non-empty single-line description.');
    }
  }
  if (path === 'references/workspace-protocol-template.md'
    && !source.startsWith('# Workspace protocol template (scaffold)\n')) {
    throw new Error('must begin with the workspace protocol scaffold heading.');
  }
  return source;
}

function loadSkillAsset(path: string): string {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const logicalAsset = `${ROOM_SKILL_NAME}/${path}`;
  const assetUrl = new URL(`./skills/${ROOM_SKILL_NAME}/${path}`, import.meta.url);
  try {
    const validated = validateSkillAsset(path, readFileSync(assetUrl, 'utf8'));
    cache.set(path, validated);
    return validated;
  } catch (error) {
    if (error instanceof SkillAssetError) throw error;
    const detail = error instanceof Error ? error.message : 'could not be read.';
    throw new SkillAssetError(logicalAsset, assetUrl, detail, { cause: error });
  }
}

/** Where every Lead projection's room-owned skill link points: one shared source copy. */
export function roomSkillSource(layout: Layout): string {
  return join(sharedRoom(layout), 'skills', ROOM_SKILL_NAME);
}

/** A room-owned aggregate that lets the role path remain a rollback-compatible symlink. */
export function leadSkillProjection(layout: Layout, agent: AgentId): string {
  return join(sharedRoom(layout), 'skill-projections', agent, 'lead');
}

/**
 * The shared skill source, by exact file and directory shape. Added once from the command that
 * builds the desired state rather than per adapter, so three seated agents do not declare the
 * same managed paths three times.
 */
export function roomSkillEntries(layout: Layout): Entry[] {
  const root = roomSkillSource(layout);
  return [
    { kind: 'dir', path: join(sharedRoom(layout), 'skills') },
    { kind: 'managed-dir', path: root, children: ['SKILL.md', ...SKILL_DIRECTORIES] },
    {
      kind: 'managed-dir', path: join(root, 'references'),
      children: SKILL_FILES.filter(path => path.startsWith('references/')).map(path => path.slice('references/'.length)),
    },
    ...SKILL_FILES.map(path => ({
      kind: 'file' as const, path: join(root, path), content: loadSkillAsset(path),
    })),
  ];
}
