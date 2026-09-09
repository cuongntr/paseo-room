import { randomUUID } from 'node:crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import metadata from '../../package.json' with { type: 'json' };
import { createCodexAdapter } from '../adapters/codex/index.js';
import { CodexDiscoveryError } from '../adapters/codex/discover.js';
import { canonicalJson } from '../core/hash.js';
import { type NormalizedIntent } from '../core/intent.js';
import { buildManifestArtifacts, buildManifestProviders, loadManifest, validateManifest, manifestArtifactSchema, type InstallationManifestV1 } from '../core/manifest.js';
import { observeOwnedState } from '../core/observation.js';
import { resolveManagedRoot } from '../core/paths.js';
import { planLifecycle, type PlannerPathFact } from '../core/planner.js';
import { processRunner } from '../core/process.js';
import { type CommandResult } from '../core/result.js';
import { recoverTransaction } from '../core/recovery.js';
import { RootBootstrap } from '../core/bootstrap.js';
import { absentTransactionProviders, type FileChange } from '../core/transaction.js';
import { TransactionFilesystem } from '../core/transaction-fs.js';
import { type ExecutorDependencies, executeTransaction, paseoExecutorDependencies } from '../core/transaction-executor.js';
import { uninstallRoom } from '../core/uninstall.js';
import { type TransactionClientFactory } from '../paseo/transaction-gateway.js';
import { type GuardedFileHasher, type ProcessRunner, type ReadonlyFileSystem } from '../core/seams.js';
import { PaseoAdmissionError, type ProbeDependencies, type ProbeInput } from '../paseo/cli-probe.js';
import { observePaseo } from '../paseo/observation.js';
import { validateProviderPolicy } from '../paseo/provider-policy.js';
import { localProbeDependencies, paseoFilesystem } from '../paseo/runtime.js';
import { MANAGED_PROVIDER_IDS } from '../room/roles.js';

export interface PreparedLifecycle {
  readonly result: CommandResult;
  readonly mutate?: () => Promise<CommandResult>;
}
export interface LifecycleServices {
  prepare(intent: NormalizedIntent): Promise<PreparedLifecycle>;
}
export function failure(intent: Pick<NormalizedIntent, 'command'>): CommandResult {
  return { schemaVersion: 1, command: intent.command, outcome: 'failed', changed: false, operations: [],
    checks: [{ id: 'lifecycle.prerequisites', status: 'fail', message: 'Lifecycle prerequisites could not be established.',
      remediation: 'Check existing dependency installations, safe paths and local daemon availability; nothing was automatically repaired.' }] };
}
/** Sole CLI authorization point. The read-only preparation cannot acquire locks,
 * refresh registries, or publish files. Its mutation closure is never called by default. */
export async function runLifecycle(intent: NormalizedIntent, services: LifecycleServices = { prepare: prepareLifecycle }): Promise<CommandResult> {
  const prepared = await services.prepare(intent);
  return Object.is(intent.apply, true) && ['install', 'recover', 'uninstall'].includes(intent.command) && prepared.mutate
    ? prepared.mutate() : prepared.result;
}

export interface LifecycleRuntime {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly filesystem: ReadonlyFileSystem & GuardedFileHasher;
  readonly runner: ProcessRunner;
  readonly probeDependencies: ProbeDependencies;
  readonly clientFactory?: TransactionClientFactory;
  readonly lock?: ExecutorDependencies['lock'];
}
export async function prepareLifecycle(intent: NormalizedIntent, runtime: LifecycleRuntime = {
  environment: process.env, filesystem: paseoFilesystem, runner: processRunner, probeDependencies: localProbeDependencies(),
}): Promise<PreparedLifecycle> {
  const { environment, filesystem } = runtime;
  const uid = process.getuid?.();
  if (uid === undefined || !environment.HOME) return { result: failure(intent) };
  const adapter = createCodexAdapter(filesystem);
  try {
    const discovery = await adapter.discover({ intent, filesystem, process: runtime.runner, environment,
      runtime: { pid: process.pid, now: () => new Date(), isProcessAlive: pid => {
        try { process.kill(pid, 0); return Promise.resolve(true); } catch { return Promise.resolve(false); }
      } } });
    const roomHome = discovery.roomHome;
    const input = { discovery, roomHome, roleHomes: { supervisor: join(roomHome, 'roles/codex/supervisor'),
      lead: join(roomHome, 'roles/codex/lead'), peer: join(roomHome, 'roles/codex/peer') } };
    const specs = await adapter.buildArtifacts(input);
    const policy = validateProviderPolicy({ 'codex-supervisor': adapter.buildProvider('supervisor', input),
      'codex-lead': adapter.buildProvider('lead', input), 'codex-peer': adapter.buildProvider('peer', input) });
    const forbiddenFilePaths = Object.values(discovery.sharedTargets);
    const forbiddenFileIdentities = [];
    for (const path of forbiddenFilePaths) {
      const stat = await filesystem.lstat(path);
      if (stat?.kind === 'file') forbiddenFileIdentities.push({ device: stat.device, inode: stat.inode });
    }
    const context = { roomHome, transactionId: randomUUID(), forbiddenFilePaths };
    const disk = new TransactionFilesystem({ roomHome, uid, forbiddenFilePaths, forbiddenFileIdentities });
    const desired = { artifacts: buildManifestArtifacts(specs, context), providers: policy };
    const root = await filesystem.lstat(roomHome);
    const configStat = await filesystem.lstat(discovery.configPath);
    const configParent = await filesystem.lstat(dirname(discovery.configPath));
    if (!configStat || !configParent) throw new Error();
    const source: InstallationManifestV1['source'] = { canonicalHome: discovery.canonicalHome,
      canonicalConfigSha256: await filesystem.hashFileNoFollow(discovery.configPath, configParent, configStat, forbiddenFileIdentities),
      codexLaunchArgv: [...discovery.launchPrefix], codexVersion: discovery.version };
    const paths: PlannerPathFact[] = [];
    for (const artifact of desired.artifacts) {
      try {
        await resolveManagedRoot(filesystem, dirname(artifact.path));
        const stat = await filesystem.lstat(artifact.path);
        if (!stat) { paths.push({ path: artifact.path, occupancy: 'absent' }); continue; }
        const current = await disk.inspect(artifact.path);
        paths.push({ path: artifact.path, occupancy: 'occupied', ...(current.kind === 'absent' ? {} : { current: manifestArtifactSchema.parse({ path: artifact.path, ...current }) }) });
      } catch { paths.push({ path: artifact.path, occupancy: 'unsafe' }); }
    }
    const probeDeps = runtime.probeDependencies;
    const binaryInput = intent.paseoBin ?? 'paseo';
    const candidates = isAbsolute(binaryInput) || binaryInput.includes('/') ? [resolve(binaryInput)]
      : (environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(path => join(path, binaryInput));
    let executable = '';
    for (const path of candidates) if (await filesystem.lstat(path)) { executable = await filesystem.realpath(path); break; }
    const probe: ProbeInput = { executable, home: environment.HOME,
      localHome: resolve(environment.PASEO_HOME ?? join(environment.HOME, '.paseo')),
      ...(intent.paseoUrl ? { paseoUrl: intent.paseoUrl } : {}) };
    let live;
    try { live = await observePaseo(probe, probeDeps, environment.PASEO_PASSWORD, policy, runtime.clientFactory); }
    catch (error) {
      const result = planLifecycle({ intent, desired, current: { paths, paseo: { mode: 'offline' }, unfinishedJournal: false } });
      return { result: { ...result, checks: [...result.checks, ...(error instanceof PaseoAdmissionError ? [error.check] : failure(intent).checks)] } };
    }
    const bootstrap = new RootBootstrap(disk, live.admission.endpointIdentitySha256);
    const boot = await bootstrap.inspect(context);
    let journals: string[] = [];
    if (root && (await disk.inspect(join(roomHome, 'transactions'))).kind !== 'absent') journals = await disk.entries(join(roomHome, 'transactions'));
    const deps: ExecutorDependencies = { ...paseoExecutorDependencies(disk, probe, probeDeps, environment.PASEO_PASSWORD, runtime.clientFactory),
      ...(runtime.lock ? { lock: runtime.lock, recoveryLock: runtime.lock } : {}) };
    if (intent.command === 'recover') {
      const id = boot.transactionId ?? (journals.length === 1 ? journals[0] : undefined);
      if (boot.state === 'recovery-required' || journals.length > 1 || id !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
        return { result: { ...failure(intent), outcome: 'recovery-required' } };
      }
      const request = { context: { ...context, transactionId: id ?? context.transactionId }, admission: live.admission, policy };
      const classify = (state: Awaited<ReturnType<typeof recoverTransaction>>, apply: boolean): CommandResult => ({
        schemaVersion: 1, command: 'recover', outcome: state === 'recovery-required' ? state
          : ['reversible', 'committed-cleanup'].includes(state) ? 'changes-planned' : 'ok',
        changed: apply && ['recovered', 'rolled-back', 'committed-cleanup'].includes(state), operations: [],
        checks: [{ id: 'recovery.state', status: state === 'recovery-required' ? 'fail' : 'pass', message: `Recovery classification: ${state}.` }],
      });
      const state = await recoverTransaction(request, deps);
      return { result: classify(state, false), mutate: async () => classify(await recoverTransaction({ ...request, apply: true }, deps), true) };
    }
    let manifest: InstallationManifestV1 | undefined;
    if (root) {
      const value = await disk.inspect(join(roomHome, 'manifest.json'));
      if (value.kind !== 'absent') manifest = loadManifest(await disk.read(join(roomHome, 'manifest.json'), value), context);
    }
    const owned = manifest ? { manifest, observation: await observeOwnedState(manifest, context,
      { packageVersion: metadata.version, adapter: 'codex', source, paseo: { ...live.admission, minimumVersion: '0.8.0-beta.1' }, providers: live.providers },
      { filesystem, uid, forbiddenFileIdentities }) } : undefined;
    const sessionChecks = live.verification.checks.filter(check => check.id.startsWith('paseo.agents.'));
    const result = planLifecycle({ intent, desired, current: { paths, ...(owned ? { owned } : {}),
      unfinishedJournal: boot.state !== 'absent' || journals.length > 0,
      paseo: { mode: 'live', admission: 'pass', providers: live.providers,
        activeSessions: sessionChecks.every(check => check.status === 'pass') ? live.verification.activeManagedProviderIds.map(providerId => ({ providerId })) : 'not-checked',
        readiness: Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, live.verification.readyProviderIds.includes(id) ? 'ready' : 'not-ready'])) } } });
    if (intent.command === 'verify' || intent.command === 'doctor') return { result: { ...result,
      outcome: result.outcome === 'ok' && !live.verification.ok ? 'failed' : result.outcome,
      checks: [...result.checks, ...live.verification.checks] } };
    if (intent.command === 'uninstall' && manifest && !['failed', 'recovery-required'].includes(result.outcome)) return { result, mutate: async () => {
      const removal = await uninstallRoom({ apply: true, context, admission: live.admission, manifest, policy }, deps);
      return { ...result, outcome: removal.outcome === 'committed' ? 'ok' : removal.outcome === 'planned' ? 'changes-planned' : removal.outcome,
        changed: removal.changed };
    } };
    if (intent.command !== 'install' || !['ok', 'changes-planned'].includes(result.outcome) || !result.operations.length) return { result };
    const changes: FileChange[] = result.operations.flatMap(operation => {
      if (operation.target.kind === 'provider' || operation.target.path === roomHome) return [];
      const path = operation.target.path;
      const after = specs.find(spec => spec.path === path);
      if (!after) throw new Error();
      return [{ before: manifest?.artifacts.find(artifact => artifact.path === path) ?? null, after }];
    });
    const next = validateManifest({ schemaVersion: 1, packageVersion: metadata.version, installationId: manifest?.installationId ?? randomUUID(),
      lastTransactionId: context.transactionId, status: 'committed', adapter: 'codex', paseo: { ...live.admission, minimumVersion: '0.8.0-beta.1' },
      source, artifacts: desired.artifacts, providers: buildManifestProviders(policy), committedAt: new Date().toISOString() }, context);
    return { result, mutate: async () => {
      const state = await executeTransaction({ apply: true, admission: live.admission, context, manifest: next,
        transaction: { operation: manifest ? 'update' : 'install', previousManifest: manifest ?? null, changes,
          providerBefore: manifest ? Object.fromEntries(MANAGED_PROVIDER_IDS.map(id => [id, manifest.providers[id]?.applied ?? null])) as ReturnType<typeof absentTransactionProviders> : absentTransactionProviders(),
          providerAfter: policy, validateArtifacts: async artifacts => {
            const rebuilt = await adapter.buildArtifacts(input);
            if (artifacts.some(artifact => !rebuilt.some(expected => canonicalJson(artifact) === canonicalJson(expected)))) throw new Error();
          } } }, deps);
      return { ...result, outcome: state === 'committed' || state === 'noop' ? 'ok' : state === 'rolled-back' ? 'failed' : state,
        changed: state === 'committed' || state === 'recovery-required' };
    } };
  } catch (error) {
    return { result: { ...failure(intent), ...(error instanceof CodexDiscoveryError || error instanceof PaseoAdmissionError ? { checks: [error.check] } : {}) } };
  }
}
