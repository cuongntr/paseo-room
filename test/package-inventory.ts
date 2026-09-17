import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { PROMPT_ASSETS } from '../src/room/prompts.js';

interface PackFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackFile[];
}

export function registeredPromptPaths(prefix = ''): string[] {
  const groups: readonly Readonly<Record<string, { readonly path: string }>>[] = [
    PROMPT_ASSETS.documents,
    PROMPT_ASSETS.contract,
    PROMPT_ASSETS.workspace,
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
