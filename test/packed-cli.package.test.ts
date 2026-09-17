import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  markdownInventory, parsePackFilePaths, promptContents, registeredPromptPaths,
} from './package-inventory.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(import.meta.dirname, '..');
const sourcePrompts = join(repositoryRoot, 'src', 'room', 'prompts');
const temporaryRoots: string[] = [];

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function executable(path: string, output: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`);
  await chmod(path, 0o755);
}

async function reserveClosedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Could not reserve a loopback port.');
  await new Promise<void>((resolve, reject) => server.close(error => {
    if (error) reject(error);
    else resolve();
  }));
  return address.port;
}

async function runCli(entry: string, cwd: string, env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, 'setup', '--agent', 'codex'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => { resolve({ code, stdout, stderr }); });
  });
}

async function newestSourceMtime(): Promise<number> {
  const roots = [join(repositoryRoot, 'src'), join(repositoryRoot, 'package.json'), join(repositoryRoot, 'tsup.config.json')];
  let newest = 0;
  for (const root of roots) {
    const rootStat = await stat(root);
    if (rootStat.isFile()) {
      newest = Math.max(newest, rootStat.mtimeMs);
      continue;
    }
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      newest = Math.max(newest, (await stat(join(entry.parentPath, entry.name))).mtimeMs);
    }
  }
  return newest;
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map(path => rm(path, { force: true, recursive: true })));
});

describe('packed CLI prompt rendering', { concurrent: false }, () => {
  it('renders from a complete offline package and names a missing installed asset before connecting', async () => {
    const builtEntry = join(repositoryRoot, 'dist', 'index.js');
    const builtStat = await stat(builtEntry);
    expect(builtStat.isFile()).toBe(true);
    expect(builtStat.mtimeMs).toBeGreaterThanOrEqual(await newestSourceMtime());

    const packageRoot = await mkdtemp(join(tmpdir(), 'paseo-room-package-'));
    temporaryRoots.push(packageRoot);
    expect(relative(repositoryRoot, packageRoot).startsWith('..')).toBe(true);

    const packRoot = join(packageRoot, 'pack');
    const extractRoot = join(packageRoot, 'extract');
    await mkdir(packRoot);
    await mkdir(extractRoot);
    const { stdout: packOutput } = await execFileAsync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packRoot],
      {
        cwd: repositoryRoot,
        env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_offline: 'true' },
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const packPaths = parsePackFilePaths(packOutput);
    expect(packPaths.filter(path => path.startsWith('dist/prompts/'))).toEqual(
      registeredPromptPaths('dist/prompts/'),
    );

    const archives = (await readdir(packRoot)).filter(path => path.endsWith('.tgz'));
    expect(archives).toHaveLength(1);
    await execFileAsync('tar', ['-xzf', join(packRoot, archives[0] ?? ''), '-C', extractRoot]);

    const installedRoot = join(extractRoot, 'package');
    const installedEntry = join(installedRoot, 'dist', 'index.js');
    expect(await markdownInventory(join(installedRoot, 'dist', 'prompts'))).toEqual(registeredPromptPaths());
    expect(await promptContents(join(installedRoot, 'dist', 'prompts'))).toEqual(await promptContents(sourcePrompts));
    await symlink(join(repositoryRoot, 'node_modules'), join(installedRoot, 'node_modules'), 'dir');

    const home = join(packageRoot, 'home');
    const bin = join(home, 'bin');
    const codexHome = join(home, '.codex');
    await mkdir(bin, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5.6-sol"\napproval_policy = "on-request"\n');
    await executable(join(bin, 'codex'), JSON.stringify({ models: [{ id: 'gpt-5.6-sol', multi_agent_version: 2 }] }));

    const port = await reserveClosedLoopbackPort();
    await executable(join(bin, 'paseo'), JSON.stringify({
      listen: `127.0.0.1:${String(port)}`,
      localDaemon: 'running',
      cliVersion: '0.8.1',
      daemonVersion: '0.8.1',
    }));
    const env = {
      HOME: home,
      PATH: bin,
      PASEO_HOME: join(home, '.paseo'),
      PASEO_ROOM_HOME: join(home, '.paseo-room'),
    };

    const complete = await runCli(installedEntry, installedRoot, env);
    expect(complete.code).not.toBe(0);
    expect(complete.stdout).toContain('Transport closed (code 1006)');
    expect(complete.stdout).toContain('Check that Paseo is running and reachable, then try again.');
    expect(complete.stdout).not.toContain('prompt-asset');
    expect(complete.stdout).not.toContain('Reinstall paseo-room');
    expect(complete.stderr).toBe('');

    const missingAsset = join(installedRoot, 'dist', 'prompts', 'contract', 'lead', 'technical-acceptance.md');
    await rm(missingAsset);
    const incomplete = await runCli(installedEntry, installedRoot, env);
    expect(incomplete.code).not.toBe(0);
    expect(incomplete.stdout).toContain('contract.technicalAcceptance');
    expect(incomplete.stdout).toContain('Reinstall paseo-room');
    expect(incomplete.stdout).not.toContain('Transport closed');
    expect(incomplete.stdout).not.toContain('Check that Paseo is running and reachable');
    expect(incomplete.stderr).toBe('');
  }, 60_000);
});
