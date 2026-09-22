/** A complete in-process runtime over a real temporary Git repository and a fake Paseo. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { Controller, type Caller } from '../src/runtime-plugin/server/controller.js';
import { CorrelationRegistry } from '../src/runtime-plugin/server/correlations.js';
import { GitEvidence } from '../src/runtime-plugin/server/git.js';
import { CORRELATION_ENV, handleSessionOpen, transformAgentCreate, type HookDependencies } from '../src/runtime-plugin/server/hooks.js';
import { Recognition } from '../src/runtime-plugin/server/recognition.js';
import { FakePaseo } from './runtime-fake-paseo.js';

const exec = promisify(execFile);

export interface Harness {
  readonly root: string;
  readonly repo: string;
  readonly base: string;
  readonly runtimeRoot: string;
  readonly paseo: FakePaseo;
  readonly controller: Controller;
  readonly hooks: HookDependencies;
  readonly lead: Caller;
  git(...args: string[]): Promise<string>;
  cleanup(): Promise<void>;
}

export const writableBrief = (base: string, change: Record<string, unknown> = {}): Record<string, unknown> => ({
  mode: 'writable', kind: 'engineer', outcome: 'Add the feature', prerequisites: [], writeScope: ['src/'],
  exclusions: ['No docs change'], invariants: [], acceptanceEvidence: ['tests pass'], expectedHandoff: ['a commit'],
  reopenConditions: [], baseCommit: base,
  gate: { command: 'npm run verify', timeoutSeconds: 600, runtimeRerun: 'optional', processContractVersion: 1 }, ...change,
});

export const readOnlyBrief = (base: string): Record<string, unknown> => ({
  ...writableBrief(base), mode: 'read-only', kind: 'reviewer', writeScope: [], gate: undefined,
});

export async function harness(options: { readonly associationWaitMs?: number } = {}): Promise<Harness> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-controller-')));
  const repo = join(root, 'repo');
  await mkdir(repo);
  const git = async (...args: string[]): Promise<string> =>
    (await exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo })).stdout.trim();
  await git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'base');
  const base = await git('rev-parse', 'HEAD');

  const pluginDirectory = join(root, 'room', 'runtime-plugin');
  const runtimeRoot = join(root, 'room', 'runtime', 'v1');
  await mkdir(join(pluginDirectory, 'generated'), { recursive: true });
  await writeFile(join(pluginDirectory, 'generated', 'room-manifest.json'), renderRuntimeManifestFile(['codex', 'claude'], ROLES));
  const recognition = new Recognition(pluginDirectory);
  await recognition.load();
  const correlations = new CorrelationRegistry(join(runtimeRoot, 'correlations'));
  const hooks: HookDependencies = { recognition, correlations, nodePath: process.execPath, bridgeScript: join(pluginDirectory, 'server', 'bridge', 'bridge.mjs'), runtimeRoot };

  const paseo = new FakePaseo();
  paseo.workspaceFor = () => 'ws-1';
  // Paseo runs every plugin's before-hooks and opens the session while it creates the agent.
  paseo.onCreate = async (input, agentId) => {
    const decorated = transformAgentCreate({ config: { provider: input.provider, cwd: input.cwd, title: input.title } }, hooks);
    const id = decorated?.env?.[CORRELATION_ENV];
    if (id === undefined) return;
    await handleSessionOpen({ agentId, workspaceId: 'ws-1', provider: input.provider, cwd: input.cwd, reason: 'create', purpose: 'interactive', env: { [CORRELATION_ENV]: id } }, hooks);
  };
  paseo.addAgent({ id: 'lead-1', provider: 'codex-lead', cwd: repo, workspaceId: 'ws-1' });

  const controller = new Controller({ runtimeRoot, paseo, git: new GitEvidence(), recognition, correlations, associationWaitMs: options.associationWaitMs ?? 200 });
  const lead: Caller = { agentId: 'lead-1', providerId: 'codex-lead', role: 'lead', workspaceId: 'ws-1', cwd: repo };
  return { root, repo, base, runtimeRoot, paseo, controller, hooks, lead, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}
