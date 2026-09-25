/** A complete in-process runtime over a real temporary Git repository and a fake Paseo. */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ROLES } from '../src/roles.js';
import { renderRuntimeManifestFile } from '../src/runtime.js';
import { Controller, type Caller } from '../src/runtime-plugin/server/controller.js';
import { actionFingerprint } from '../src/runtime-plugin/server/domain/receipts.js';
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

/** Worktree dispatch is qualified per daemon version; tests that exercise it qualify a fake one. */
export const QUALIFIED_TEST_DAEMON = '0.0.0-test';

export async function harness(options: { readonly associationWaitMs?: number; readonly worktrees?: boolean } = {}): Promise<Harness> {
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
  paseo.worktreeRoot = join(root, 'worktrees');
  // Paseo runs every plugin's before-hooks and opens the session while it creates the agent.
  paseo.onCreate = async (input, agentId) => {
    const decorated = transformAgentCreate({ config: { provider: input.provider, cwd: input.cwd, title: input.title } }, hooks);
    const id = decorated?.env?.[CORRELATION_ENV];
    if (id === undefined) return;
    const workspaceId = paseo.agents.get(agentId)?.workspaceId ?? null;
    await handleSessionOpen({ agentId, workspaceId, provider: input.provider, cwd: input.cwd, reason: 'create', purpose: 'interactive', env: { [CORRELATION_ENV]: id } }, hooks);
  };
  paseo.addAgent({ id: 'lead-1', provider: 'codex-lead', cwd: repo, workspaceId: 'ws-1' });

  const controller = new Controller({
    runtimeRoot, paseo, git: new GitEvidence(), recognition, correlations, associationWaitMs: options.associationWaitMs ?? 200,
    ...(options.worktrees === true ? { daemonVersion: () => QUALIFIED_TEST_DAEMON, qualifiedDaemons: [QUALIFIED_TEST_DAEMON] } : {}),
  });
  const lead: Caller = { agentId: 'lead-1', providerId: 'codex-lead', role: 'lead', workspaceId: 'ws-1', cwd: repo };
  return { root, repo, base, runtimeRoot, paseo, controller, hooks, lead, git, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Creates and dispatches `brief`, then records an accepted complete handoff on a committed candidate. */
export async function dispatchAndHandBack(h: Harness, brief: Record<string, unknown>): Promise<{ id: string; peer: string }> {
  const created = await h.controller.createAssignment(h.lead, brief);
  if (!created.ok) throw new Error(created.message);
  const dispatched = await h.controller.dispatch(h.lead, { assignmentId: created.value.assignmentId, peerProvider: 'codex-peer' });
  if (!dispatched.ok) throw new Error(dispatched.message);
  await writeFile(join(h.repo, 'work.ts'), 'x');
  await h.git('add', '.');
  await h.git('commit', '-q', '-m', 'work');
  const project = await h.controller.load(await h.controller.projectFor(h.repo));
  if (!project.ok) throw new Error(project.message);
  const derived = await h.controller.deps.git.deriveCandidate(h.repo, { gitCommonDir: project.value.store.meta.gitCommonDir, baseCommit: h.base, workspaceId: 'ws-1' });
  if (!derived.ok) throw new Error(derived.message);
  const payload = { completion: 'complete', verification: [{ command: 'sleep 1', outcome: 'passed' }] };
  await h.controller.append(project.value, {
    type: 'report.accepted', payloadVersion: 1, assignmentId: created.value.assignmentId, actor: { source: 'seat', role: 'peer' },
    data: { generation: 1, tool: 'handoff', requestId: 'req_handback1', fingerprint: actionFingerprint(1, 'handoff', payload), receipt: { schema: 1, receipt: 'r', tool: 'handoff', status: 'accepted', assignmentState: 'handed-back' }, report: payload, candidate: derived.candidate },
  });
  h.paseo.endTurn(dispatched.value.agentId);
  return { id: created.value.assignmentId, peer: dispatched.value.agentId };
}
