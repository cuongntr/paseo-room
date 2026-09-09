import { RootBootstrap } from './bootstrap.js';
import { inspectTransactionPath } from './transaction-inspect.js';
import { basename, dirname, join } from 'node:path';
import { canonicalJson } from './hash.js';
import { loadManifest, validateManifest, type InstallationManifestV1, type ManifestArtifact } from './manifest.js';
import { ManifestCommit } from './manifest-commit.js';
import { FilesystemTransaction, absentTransactionProviders, type JournalContext } from './transaction.js';
import { cleanupCommittedTransaction } from './transaction-cleanup.js';
import { guardedProviderMutation } from './provider-mutation.js';
import { type ExecutorDependencies } from './transaction-executor.js';
import { type LocalAdmission } from '../paseo/cli-probe.js';
import { validateProviderPolicy, type ProviderPolicy } from '../paseo/provider-policy.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';

const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export interface UninstallInput {
  readonly apply?: boolean;
  readonly context: JournalContext;
  readonly admission: LocalAdmission;
  readonly manifest: InstallationManifestV1;
  /** Full adapter policy supplies session inventory validation, not ownership. */
  readonly policy: ProviderPolicy;
}
export interface UninstallResult {
  readonly outcome: 'planned' | 'committed' | 'conflict' | 'recovery-required';
  readonly changed: boolean;
  readonly unresolvedArtifacts: readonly string[];
  readonly unresolvedProviders: readonly ManagedProviderId[];
}
/** Provider-first removal; arbitrary customized provider values never enter the
 * journal. Equal before/after slots are not mutation authority. Any remaining
 * namespace provider may reference any owned file, so file retention is broad. */
export async function uninstallRoom(input: UninstallInput, deps: ExecutorDependencies): Promise<UninstallResult> {
  const request = structuredClone(input);
  const fs = deps.filesystem;
  let lock: Awaited<ReturnType<ExecutorDependencies['lock']>> | undefined;
  let tx: FilesystemTransaction | undefined;
  let changed = false;
  const artifacts: string[] = [];
  const providers: ManagedProviderId[] = [];
  const result = (outcome: UninstallResult['outcome']): UninstallResult => ({ outcome, changed,
    unresolvedArtifacts: artifacts, unresolvedProviders: providers });
  try {
    const previous = validateManifest(request.manifest, request.context);
    const policy = validateProviderPolicy(request.policy);
    if (request.context.roomHome !== fs.context.roomHome || previous.lastTransactionId === request.context.transactionId ||
        !equal(previous.paseo, { ...request.admission, minimumVersion: '0.8.0-beta.1' })) return result('conflict');
    if (request.apply === true) lock = await deps.lock(request.admission);
    return await deps.gateway(async (gateway, admission) => {
      if (!equal(admission, request.admission) || !await gateway.sessionsSafe(policy)) return result('conflict');
      if ((await new RootBootstrap(fs, admission.endpointIdentitySha256).inspect(request.context)).state !== 'absent') return result('recovery-required');
      const transactions = join(request.context.roomHome, 'transactions');
      if ((await fs.inspect(transactions)).kind !== 'absent' && (await fs.entries(transactions)).length) return result('recovery-required');
      const manifestPath = join(request.context.roomHome, 'manifest.json');
      if (!equal(loadManifest(await fs.read(manifestPath, await fs.inspect(manifestPath)), request.context), previous)) return result('conflict');
      const live = await gateway.readConfig();
      const before = absentTransactionProviders();
      const after = absentTransactionProviders();
      const remove: Partial<typeof before> = {};
      for (const id of MANAGED_PROVIDER_IDS) {
        const owned = previous.providers[id];
        if (!owned) continue;
        if (!Object.hasOwn(live.providers, id)) continue;
        before[id] = owned.applied;
        if (equal(live.providers[id], owned.applied)) remove[id] = null;
        else { after[id] = owned.applied; providers.push(id); }
      }
      const retainedProvider = MANAGED_PROVIDER_IDS.some(id => Object.hasOwn(live.providers, id) && !Object.hasOwn(remove, id));
      const selected: ManifestArtifact[] = [];
      const residual: ManifestArtifact[] = [];
      // Descendants first; a directory is removable only if every remaining
      // entry is a selected immediate child. Mutable children are never traversed.
      for (const artifact of [...previous.artifacts].sort((a, b) => b.path.split('/').length - a.path.split('/').length || a.path.localeCompare(b.path))) {
        try {
          const value = await inspectTransactionPath(fs, artifact.path, artifact.kind !== 'file');
          if (value.kind === 'absent') continue;
          const { path, ...expected } = artifact;
          if (!equal(value, expected) || retainedProvider) { residual.push(artifact); continue; }
          if (artifact.kind === 'directory') {
            const entries = await fs.entries(path);
            const removable = new Set(selected.filter(child => dirname(child.path) === path).map(child => basename(child.path)));
            if (path === request.context.roomHome) { removable.add('manifest.json'); removable.add('transactions'); }
            if (entries.some(name => !removable.has(name))) { residual.push(artifact); continue; }
          }
          selected.push(artifact);
        } catch { residual.push(artifact); }
      }
      artifacts.push(...residual.map(artifact => artifact.path).sort());
      const partial = artifacts.length > 0 || providers.length > 0;
      const next = partial ? validateManifest({ ...previous, status: 'uninstall-incomplete', lastTransactionId: request.context.transactionId,
        artifacts: residual, providers: Object.fromEntries(providers.map(id => [id, previous.providers[id]])) }, request.context) : null;
      if (request.apply !== true) return result(partial ? 'conflict' : 'planned');
      // Recheck all namespace entries, including customized/unowned entries, before
      // creating durable mutation authority. Never adopt their raw values.
      const stable = async (): Promise<boolean> => {
        const now = await gateway.readConfig();
        return MANAGED_PROVIDER_IDS.every(id => equal(Object.hasOwn(now.providers, id) ? now.providers[id] : null,
          Object.hasOwn(live.providers, id) ? live.providers[id] : null));
      };
      if (!await stable() || !await gateway.sessionsSafe(policy)) return result('conflict');
      tx = await FilesystemTransaction.begin(request.context, { operation: 'uninstall', previousManifest: previous,
        changes: selected.filter(artifact => artifact.path !== request.context.roomHome).map(artifact => ({ before: artifact, after: null })),
        providerBefore: before, providerAfter: after, validateArtifacts: () => {} }, fs);
      const publication = await ManifestCommit.prepare(request.context, fs, previous, next);
      if (!await stable() || !await gateway.sessionsSafe(policy)) return result('recovery-required');
      if (Object.keys(remove).length) {
        changed = true;
        await guardedProviderMutation(request.context, fs, () => gateway.restoreProviders(remove));
      }
      const removedIds = MANAGED_PROVIDER_IDS.filter(id => Object.hasOwn(remove, id));
      // Refresh registry + readback before removing a single file. For a partial
      // provider uninstall only the removed subset can be verified as absent.
      if (!await gateway.verifyRestored(after, policy, removedIds)) return result('recovery-required');
      const removed = await gateway.readConfig();
      if (MANAGED_PROVIDER_IDS.some(id => !equal(Object.hasOwn(removed.providers, id) ? removed.providers[id] : null,
        Object.hasOwn(remove, id) ? null : Object.hasOwn(live.providers, id) ? live.providers[id] : null)) || !await gateway.sessionsSafe(policy)) return result('recovery-required');
      changed = true;
      await tx.publish();
      await tx.transition('patching-paseo');
      await tx.transition('verifying');
      const final = await gateway.readConfig();
      if (MANAGED_PROVIDER_IDS.some(id => !equal(Object.hasOwn(final.providers, id) ? final.providers[id] : null,
        Object.hasOwn(remove, id) ? null : Object.hasOwn(live.providers, id) ? live.providers[id] : null)) || !await gateway.sessionsSafe(policy)) return result('recovery-required');
      if (next) await publication.publish(); // residual replacement is its commit point
      await tx.transition('committed'); // full deletion is authorized ONLY here
      if (!next) await publication.publish();
      await publication.cleanup();
      await cleanupCommittedTransaction(tx);
      // Root and transaction container are infrastructure: empty-only, no force.
      if (!next && selected.some(artifact => artifact.path === request.context.roomHome)) {
        await fs.perform(transactions, { action: 'remove', expected: { kind: 'directory', mode: 0o700 } });
        await fs.perform(request.context.roomHome, { action: 'remove', expected: { kind: 'directory', mode: 0o700 } });
      }
      return result(partial ? 'conflict' : 'committed');
    });
  } catch { return result(tx ? 'recovery-required' : 'conflict'); }
  finally { if (lock) await lock.release(); }
}
