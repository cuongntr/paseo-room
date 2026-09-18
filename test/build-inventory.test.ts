import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  markdownInventory, parsePackFilePaths, PLUGIN_ASSET_PATHS, promptContents, registeredPromptPaths,
} from './package-inventory.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, '..');
const distRoot = join(repositoryRoot, 'dist');
const distPrompts = join(distRoot, 'prompts');
const sourcePrompts = join(repositoryRoot, 'src', 'room', 'prompts');
const sourcePluginAssets = join(repositoryRoot, 'src', 'plugin-assets');
const distPluginAssets = join(distRoot, 'plugin-assets');

async function npm(...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('npm', [...args], {
    cwd: repositoryRoot,
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

describe('build and package prompt inventory', { concurrent: false }, () => {
  it('ships the registered assets at the root bundle layout across repeated clean builds', async () => {
    await rm(distRoot, { force: true, recursive: true });
    await npm('run', 'build');

    expect(await markdownInventory(distPrompts)).toEqual(registeredPromptPaths());
    expect(await promptContents(distPrompts)).toEqual(await promptContents(sourcePrompts));
    await expect(readFile(join(distRoot, 'index.js'), 'utf8')).resolves.toContain(
      'new URL(`./prompts/${asset.path}`, import.meta.url)',
    );
    for (const path of PLUGIN_ASSET_PATHS) {
      expect(await readFile(join(distPluginAssets, path))).toEqual(await readFile(join(sourcePluginAssets, path)));
    }

    await mkdir(join(distPrompts, 'prompts'), { recursive: true });
    await writeFile(join(distPrompts, 'stale.md'), '# stale\n');
    await writeFile(join(distPrompts, 'prompts', 'nested.md'), '# nested\n');
    await npm('run', 'build');

    expect(await markdownInventory(distPrompts)).toEqual(registeredPromptPaths());
    expect(await promptContents(distPrompts)).toEqual(await promptContents(sourcePrompts));
    await expect(stat(join(distPrompts, 'prompts'))).rejects.toThrow();
    await expect(stat(join(distPrompts, 'stale.md'))).rejects.toThrow();
  }, 60_000);

  it('includes every registered prompt and no source prompt tree in a lifecycle-disabled pack', async () => {
    const packPaths = parsePackFilePaths(await npm('pack', '--ignore-scripts', '--dry-run', '--json'));
    const packedPrompts = packPaths.filter(path => path.startsWith('dist/prompts/'));

    expect(packedPrompts).toEqual(registeredPromptPaths('dist/prompts/'));
    expect(packPaths).toContain('dist/index.js');
    expect(packPaths.some(path => path.startsWith('src/room/prompts'))).toBe(false);
    expect(packPaths.filter(path => path.startsWith('dist/plugin-assets/'))).toEqual(
      PLUGIN_ASSET_PATHS.map(path => `dist/plugin-assets/${path}`).sort(),
    );
    expect(packPaths.some(path => path.startsWith('src/plugin-assets'))).toBe(false);
  }, 30_000);
});
