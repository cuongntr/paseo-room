import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PROMPT_ASSETS } from '../src/room/prompts.js';
import { ROOM_SKILL_NAME } from '../src/room/skills.js';

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackFile[];
}

export const PLUGIN_ASSET_PATHS = [
  'index.server.ts',
  'package.json',
  'paseo-plugin.json',
  'server/carrier.ts',
  'server/contract.ts',
  'tsconfig.json',
] as const;

/** Every file of the runtime plugin source tree, relative to its root; the build ships all of them. */
export async function runtimePluginInventory(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(root, `${entry.parentPath}${sep}${entry.name}`).split(sep).join('/'))
    .sort();
}

/** The exact files the room-owned skill ships, relative to its own directory. */
export const SKILL_ASSET_PATHS = [
  'SKILL.md',
  'references/workspace-protocol-template.md',
] as const;

export function registeredSkillPaths(prefix = ''): string[] {
  return SKILL_ASSET_PATHS.map(path => `${prefix}${ROOM_SKILL_NAME}/${path}`).sort();
}

export function registeredPromptPaths(prefix = ''): string[] {
  const groups: readonly Readonly<Record<string, { readonly path: string }>>[] = [
    PROMPT_ASSETS.documents,
    PROMPT_ASSETS.contract,
    PROMPT_ASSETS.pi,
  ];
  return groups.flatMap(group => Object.values(group).map(asset => `${prefix}${asset.path}`)).sort();
}

export async function markdownInventory(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => relative(root, `${entry.parentPath}${sep}${entry.name}`).split(sep).join('/'))
    .sort();
}

export async function promptContents(root: string): Promise<Readonly<Record<string, Buffer>>> {
  const entries = await Promise.all(registeredPromptPaths().map(async path =>
    [path, await readFile(join(root, path))] as const,
  ));
  return Object.fromEntries(entries);
}

export async function skillContents(root: string): Promise<Readonly<Record<string, Buffer>>> {
  const entries = await Promise.all(registeredSkillPaths().map(async path =>
    [path, await readFile(join(root, path))] as const,
  ));
  return Object.fromEntries(entries);
}

export function parsePackFilePaths(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  const candidate: unknown = Array.isArray(parsed)
    ? parsed[0]
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed as Record<string, unknown>)[0]
      : undefined;
  if (!isPackResult(candidate)) throw new Error('npm pack returned an unexpected JSON inventory.');
  return candidate.files.map(file => file.path).sort();
}

function isPackResult(value: unknown): value is PackResult {
  if (typeof value !== 'object' || value === null || !('files' in value)) return false;
  const { files } = value as { readonly files?: unknown };
  return Array.isArray(files) && files.every(file =>
    typeof file === 'object' && file !== null && 'path' in file
      && typeof (file as { readonly path?: unknown }).path === 'string',
  );
}
