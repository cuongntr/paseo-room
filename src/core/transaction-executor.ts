import { RootBootstrap } from './bootstrap.js';
import { guardedProviderMutation } from './provider-mutation.js';
import { join } from 'node:path';
import { canonicalJson } from './hash.js';
import { buildManifestArtifacts, validateManifest, type InstallationManifestV1 } from './manifest.js';
import { cleanupCommittedTransaction } from './transaction-cleanup.js';
import { ManifestCommit } from './manifest-commit.js';
import { acquireDaemonLock, acquireRecoveryDaemonLock } from './lock.js';
import { FilesystemTransaction, TransactionError, type BeginTransaction, type JournalContext, type TransactionProviderRecord,
  type TransactionSignals } from './transaction.js';
import { TransactionFilesystem } from './transaction-fs.js';
import { MANAGED_PROVIDER_IDS } from '../room/roles.js';
import { validateProviderPolicy } from '../paseo/provider-policy.js';
import { type LocalAdmission, type ProbeInput, type ProbeDependencies } from '../paseo/cli-probe.js';
import { withTransactionGateway, type TransactionGateway, type TransactionClientFactory } from '../paseo/transaction-gateway.js';

const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export type ExecutionResult = 'noop' | 'committed' | 'rolled-back' | 'conflict' | 'recovery-required';
export interface ExecuteTransactionInput {
  /** Authorization is mandatory; callers must derive it from --apply/confirmation. */
  readonly apply: boolean;
  readonly admission: LocalAdmission;
  readonly context: JournalContext;
  readonly transaction: BeginTransaction;
  readonly manifest: InstallationManifestV1;
}
export interface ExecutorDependencies {
  readonly filesystem: TransactionFilesystem;
  readonly signals?: TransactionSignals;
  lock(admission: LocalAdmission): Promise<{ release(): Promise<void> }>;
  /** Recovery-only lock acquisition may conditionally reclaim exact stale evidence. */
  readonly recoveryLock?: (admission: LocalAdmission) => Promise<{ release(): Promise<void> }>;
  /** Must re-probe local admission before connecting, while the lock is held. */
  gateway<T>(operation: (gateway: TransactionGateway, admission: LocalAdmission) => Promise<T>): Promise<T>;
}
export function paseoExecutorDependencies(filesystem: TransactionFilesystem, input: ProbeInput, deps: ProbeDependencies,
  password?: string, factory?: TransactionClientFactory): ExecutorDependencies {
  return { filesystem, lock: acquireDaemonLock, recoveryLock: acquireRecoveryDaemonLock,
    gateway: operation => withTransactionGateway(input, deps, password, operation, factory) };
}
/** Explicit no-op input is a trusted read-only planner outcome, not an adoption
 * shortcut. No lock, SDK refresh, journal, manifest, or file mutation is made. */
export async function executeTransaction(input: ExecuteTransactionInput | { readonly noop: true }, deps: ExecutorDependencies): Promise<ExecutionResult> {
  if ('noop' in input) return Object.is(input.noop, true) ? 'noop' : 'conflict';
  if (!Object.is(input.apply, true)) return 'conflict';
  const { validateArtifacts } = input.transaction;
  const request = structuredClone({ ...input, transaction: { ...input.transaction, validateArtifacts: undefined } });
  const context = request.context;
  const fs = deps.filesystem;
  const desired = validateProviderPolicy(request.transaction.providerAfter);
  const manifest = validateManifest(request.manifest, context);
  if (request.transaction.operation === 'uninstall' || context.roomHome !== fs.context.roomHome ||
      manifest.lastTransactionId !== context.transactionId || manifest.status !== 'committed' ||
      !equal(manifest.paseo, { ...request.admission, minimumVersion: '0.8.0-beta.1' }) ||
      MANAGED_PROVIDER_IDS.some(id => !equal(manifest.providers[id]?.applied, desired[id]))) return 'conflict';
  const prior = request.transaction.previousManifest === null ? null : validateManifest(request.transaction.previousManifest, context);
  if (prior && (prior.status !== 'committed' || prior.installationId !== manifest.installationId ||
      prior.paseo.endpointIdentitySha256 !== manifest.paseo.endpointIdentitySha256 || prior.lastTransactionId === context.transactionId)) return 'conflict';
  const artifacts = new Map(prior?.artifacts.map(artifact => [artifact.path, artifact]) ?? []);
  const changed = new Set<string>();
  for (const change of request.transaction.changes) {
    const path = change.after?.path ?? change.before?.path;
    if (!path || changed.has(path) || !equal(artifacts.get(path) ?? null, change.before)) return 'conflict';
    changed.add(path);
    if (change.after) {
      const after = buildManifestArtifacts([change.after], context)[0];
      if (!after || change.before && change.before.path !== after.path) return 'conflict';
      artifacts.set(path, after);
    } else artifacts.delete(path);
  }
  // Root ownership is separately declared by the durable bootstrap sidecar.
  if (!prior && manifest.artifacts.some(artifact => artifact.path === context.roomHome && artifact.kind === 'directory')) {
    artifacts.set(context.roomHome, { kind: 'directory', mode: 0o700, path: context.roomHome });
  }
  if (!equal([...artifacts.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), manifest.artifacts)) return 'conflict';
  const lock = await deps.lock(request.admission);
  const bootstrap = new RootBootstrap(fs, request.admission.endpointIdentitySha256);
  let bootstrapStarted = false;
  let tx: FilesystemTransaction | undefined;
  let commit: ManifestCommit | undefined;
  let patchAttempted = false;
  let patchResolved = false;
  let committed = false;
  let interrupted = false;
  const signals = deps.signals ?? process;
  const interrupt = (): void => { interrupted = true; };
  const checkSignal = (): void => { if (interrupted) throw new TransactionError(); };
  signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
  const recovery = async (): Promise<ExecutionResult> => {
    try { if (tx && !['committed', 'rolled-back', 'recovery-required'].includes(tx.snapshot.state)) await tx.transition('recovery-required'); }
    catch { /* Durable prior journal/commit evidence remains authoritative. */ }
    return 'recovery-required';
  };
  try {
    return await deps.gateway(async (gateway, admission) => {
      if (!equal(admission, request.admission)) return 'conflict';
      if ((await bootstrap.inspect(context)).state !== 'absent') return 'recovery-required';
      const root = await fs.inspect(context.roomHome);
      const transactions = join(context.roomHome, 'transactions');
      if (root.kind !== 'absent' && (await fs.inspect(transactions)).kind !== 'absent' && (await fs.entries(transactions)).length) return 'recovery-required';
      if (!prior && root.kind !== 'absent') return 'conflict';
      const current = await gateway.readConfig();
      if (MANAGED_PROVIDER_IDS.some(id => !equal(Object.hasOwn(current.providers, id) ? current.providers[id] : null,
        request.transaction.providerBefore[id])) || !await gateway.sessionsSafe(desired)) return 'conflict';
      // Ownership comes from an admitted prior manifest, never from equality alone.
      const previous = request.transaction.previousManifest;
      if (request.transaction.operation === 'install' ? previous !== null || MANAGED_PROVIDER_IDS.some(id => request.transaction.providerBefore[id] !== null)
        : previous === null || MANAGED_PROVIDER_IDS.some(id => !equal(previous.providers[id]?.applied, request.transaction.providerBefore[id]))) return 'conflict';
      try {
        checkSignal();
        if (!prior) {
          bootstrapStarted = true;
          await bootstrap.begin(context);
        }
        tx = await FilesystemTransaction.begin(context, { ...request.transaction, validateArtifacts,
          bootstrapEndpointIdentitySha256: prior ? null : admission.endpointIdentitySha256 }, fs);
        if (bootstrapStarted) await bootstrap.retire(context);
        commit = await ManifestCommit.prepare(context, fs, previous, manifest);
        await tx.publish(() => interrupted);
        checkSignal();
        await tx.transition('patching-paseo');
        // Recheck immediately before activation as file publication may be slow.
        if (!await gateway.sessionsSafe(desired)) throw new TransactionError();
        const beforePatch = await gateway.readConfig();
        if (MANAGED_PROVIDER_IDS.some(id => !equal(Object.hasOwn(beforePatch.providers, id) ? beforePatch.providers[id] : null,
          request.transaction.providerBefore[id]))) throw new TransactionError();
        checkSignal();
        patchAttempted = true;
        await guardedProviderMutation(context, fs, () => gateway.patchProviders(desired)); // exactly one complete three-entry mutation
        patchResolved = true;
        const readback = await gateway.readConfig();
        if (MANAGED_PROVIDER_IDS.some(id => !equal(readback.providers[id], desired[id]))) throw new TransactionError();
        await tx.transition('verifying');
        checkSignal();
        if (!(await gateway.verify(desired)).ok) throw new TransactionError();
        for (const artifact of manifest.artifacts) {
          const { path, ...expected } = artifact;
          if (!equal(await fs.inspect(path), expected)) throw new TransactionError();
        }
        checkSignal();
        await commit.publish();
        committed = await commit.committed();
        if (!committed) throw new TransactionError();
        await tx.transition('committed');
        await commit.cleanup();
        await cleanupCommittedTransaction(tx);
        return 'committed';
      } catch {
        if (!tx || !commit) return await recovery();
        try {
          // Matching durable manifest is THE commit point, even if publication
          // threw or a signal arrived before the committed journal was written.
          if (committed || await commit.committed()) {
            committed = true;
            return await recovery(); // explicit committed cleanup; never compensate
          }
          await commit.restore();
          await commit.retireTemporaries();
          // A timed-out/rejected mutation promise is still running at the transport
          // boundary. An immediate read cannot order against its late completion.
          if (patchAttempted && !patchResolved) return await recovery();
          {
            // Reconcile even if activation never started: a newly active session
            // or external writer observed during file publication blocks undo.
            // An ambiguous forward or reverse RPC is reconciled, never retried.
            const live = await gateway.readConfig();
            const restore: Partial<TransactionProviderRecord> = {};
            let diverged = false;
            for (const id of MANAGED_PROVIDER_IDS) {
              const value = Object.hasOwn(live.providers, id) ? live.providers[id] : null;
              if (equal(value, request.transaction.providerBefore[id])) continue;
              if (patchAttempted && equal(value, desired[id])) restore[id] = request.transaction.providerBefore[id];
              else diverged = true;
            }
            if (!await gateway.sessionsSafe(desired)) return await recovery();
            if (Object.keys(restore).length) {
              try { await guardedProviderMutation(context, fs, () => gateway.restoreProviders(restore)); }
              catch { return await recovery(); } // unresolved reverse RPC can complete late
            }
            const restored = await gateway.readConfig();
            if (diverged || MANAGED_PROVIDER_IDS.some(id => !equal(Object.hasOwn(restored.providers, id) ? restored.providers[id] : null,
              request.transaction.providerBefore[id])) ||
              !await gateway.verifyRestored(request.transaction.providerBefore, desired)) return await recovery();
            // Preserve role files while divergent/active providers can reference
            // them. Only proven provider restoration permits file compensation.
          }
          const result = await tx.compensate();
          if (result !== 'rolled-back') return await recovery();
          const dischargeRoot = tx.snapshot.bootstrapEndpointIdentitySha256 !== null;
          if (dischargeRoot) await bootstrap.armDischarge(context);
          await commit.cleanup();
          await tx.cleanup();
          if (dischargeRoot) await bootstrap.discharge(context);
          return 'rolled-back';
        } catch { return await recovery(); }
      }
    });
  } catch { return tx ? await recovery() : 'conflict'; }
  finally {
    signals.removeListener('SIGINT', interrupt); signals.removeListener('SIGTERM', interrupt);
    await lock.release();
  }
}
