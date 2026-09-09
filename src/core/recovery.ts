import { RootBootstrap } from './bootstrap.js';
import { inspectTransactionPath } from './transaction-inspect.js';
import { basename, dirname, join } from 'node:path';
import { canonicalJson } from './hash.js';
import { loadManifest, type InstallationManifestV1 } from './manifest.js';
import { ManifestCommit } from './manifest-commit.js';
import { FilesystemTransaction, transactionDirectory, type JournalContext, type TransactionProviderRecord } from './transaction.js';
import { cleanupCommittedTransaction } from './transaction-cleanup.js';
import { type FileValue } from './transaction-fs.js';
import { guardedProviderMutation } from './provider-mutation.js';
import { type ExecutorDependencies } from './transaction-executor.js';
import { type LocalAdmission } from '../paseo/cli-probe.js';
import { validateProviderPolicy, type ProviderPolicy } from '../paseo/provider-policy.js';
import { MANAGED_PROVIDER_IDS } from '../room/roles.js';

const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
export interface RecoverInput {
  readonly apply?: boolean;
  readonly context: JournalContext;
  readonly admission: LocalAdmission;
  readonly policy: ProviderPolicy;
}
export type RecoveryResult = 'noop' | 'committed-cleanup' | 'reversible' | 'rolled-back' | 'recovered' | 'recovery-required';

/** Default classification uses inspect/read only, including linked publication
 * pairs. No lock creation, refresh, fsync, journal transition, or cleanup. */
export async function recoverTransaction(input: RecoverInput, deps: ExecutorDependencies): Promise<RecoveryResult> {
  const request = structuredClone(input);
  let lock: Awaited<ReturnType<ExecutorDependencies['lock']>> | undefined;
  try {
    validateProviderPolicy(request.policy);
    if (request.context.roomHome !== deps.filesystem.context.roomHome) return 'recovery-required';
    if (Object.is(request.apply, true)) lock = await (deps.recoveryLock ?? deps.lock)(request.admission);
    return await deps.gateway(async (gateway, admission) => {
      if (!equal(admission, request.admission) || !await gateway.sessionsSafe(request.policy)) return 'recovery-required';
      const live = await gateway.readConfig();
      const fs = deps.filesystem;
      const bootstrap = new RootBootstrap(fs, admission.endpointIdentitySha256);
      const boot = await bootstrap.inspect(request.context);
      if (boot.state === 'recovery-required' || boot.transactionId !== undefined && boot.transactionId !== request.context.transactionId) return 'recovery-required';
      if (boot.state === 'reversible') {
        if (request.apply !== true) return 'reversible';
        return await bootstrap.recover(request.context, true) === 'absent' ? 'recovered' : 'recovery-required';
      }
      if (boot.state === 'transferred' && request.apply === true) await bootstrap.retire(request.context);
      if ((await fs.inspect(request.context.roomHome)).kind === 'absent') return 'noop';
      const directory = transactionDirectory(request.context);
      if ((await fs.inspect(join(request.context.roomHome, 'transactions'))).kind === 'absent') return 'noop';
      const directories = await fs.entries(dirname(directory));
      if (!directories.length) return 'noop';
      if (directories.length !== 1 || directories[0] !== basename(directory)) return 'recovery-required';
      // Journal-last cleanup can leave only an empty private transaction directory.
      if (!(await fs.entries(directory)).length) {
        if (request.apply === true) await fs.perform(directory, { action: 'remove', expected: { kind: 'directory', mode: 0o700 } });
        return request.apply === true ? 'recovered' : 'committed-cleanup';
      }
      const tx = await FilesystemTransaction.open(request.context, fs);
      const journal = tx.snapshot;
      if (journal.previousManifest === null && journal.bootstrapEndpointIdentitySha256 !== admission.endpointIdentitySha256 ||
          journal.previousManifest !== null && journal.bootstrapEndpointIdentitySha256 !== null) return 'recovery-required';
      const terminalRollback = journal.state === 'rolled-back' && journal.fileMutations.every(record =>
        ['planned', 'compensated'].includes(record.progress) && record.pending === null);
      if (!await tx.successorSafe()) return 'recovery-required';
      if ((await fs.entries(directory)).some(name => !['journal.json', 'journal.next', 'before', 'staging', 'manifest-publication.json'].includes(name))) return 'recovery-required';
      // Unknown or changed bundle leaves make cleanup/rollback ambiguous. Inspect
      // the complete bundle before performing even a journal-only transition.
      for (const name of ['before', 'staging'] as const) {
        const path = join(directory, name);
        const expected = new Map<string, FileValue>();
        for (const record of journal.fileMutations) {
          if (name === 'before' && record.before.kind === 'file') expected.set(record.before.backup,
            { kind: 'file', mode: record.before.mode, sha256: record.before.sha256 });
          if (name === 'staging' && record.stagedFile) expected.set(record.stagedFile, record.after);
        }
        if ((await fs.inspect(path)).kind === 'absent') continue;
        for (const entry of await fs.entries(path)) {
          if (!expected.has(entry) || !equal(await fs.inspect(join(path, entry)), expected.get(entry))) return 'recovery-required';
        }
      }
      const publication = await ManifestCommit.open(request.context, fs);
      const manifestPath = join(request.context.roomHome, 'manifest.json');
      let current: FileValue;
      let manifest: InstallationManifestV1 | null = null;
      try {
        current = await fs.inspect(manifestPath);
        if (current.kind !== 'absent') manifest = loadManifest(await fs.read(manifestPath, current), request.context);
      } catch {
        if (!publication) return 'recovery-required';
        let pair;
        try { pair = await fs.perform(manifestPath, { action: 'inspect-publication', source: basename(publication.prepared), sourceExpected: publication.after }); }
        catch { pair = await fs.perform(manifestPath, { action: 'inspect-publication', source: basename(publication.capture), sourceExpected: publication.before }); }
        if (!pair.content) return 'recovery-required';
        current = pair.value;
        manifest = loadManifest(Buffer.from(pair.content, 'base64'), request.context);
      }
      if (publication) {
        try {
          const prepared = await fs.inspect(publication.prepared);
          if (prepared.kind !== 'absent' && !equal(prepared, publication.after)) return 'recovery-required';
        } catch {
          await fs.perform(manifestPath, { action: 'inspect-publication', source: basename(publication.prepared), sourceExpected: publication.after });
        }
      }
      const previous = journal.previousManifest;
      // Journals describe mutations of admitted ownership, never adoption.
      if (journal.operation === 'install' ? previous !== null : previous === null) return 'recovery-required';
      for (const record of journal.fileMutations) {
        const owned = previous?.artifacts.find(artifact => artifact.path === record.destination);
        const before = record.before.kind === 'file' ? { kind: 'file', mode: record.before.mode, sha256: record.before.sha256 } : record.before;
        const expected = owned ? Object.fromEntries(Object.entries(owned).filter(([key]) => key !== 'path')) : { kind: 'absent' };
        if (!equal(before, expected) || journal.operation === 'uninstall' && record.after.kind !== 'absent') return 'recovery-required';
      }
      for (const id of MANAGED_PROVIDER_IDS) {
        if (journal.operation === 'install' ? journal.providerBefore[id] !== null
          : journal.providerBefore[id] !== null && !equal(journal.providerBefore[id], previous?.providers[id]?.applied)) return 'recovery-required';
      }
      if (publication) {
        if (previous === null && publication.before.kind !== 'absent' || previous !== null && publication.before.kind !== 'file') return 'recovery-required';
        for (const path of [manifestPath, publication.capture]) {
          let value: FileValue;
          let priorBytes: Buffer | undefined;
          try {
            value = path === manifestPath ? current : await fs.inspect(path);
            if (equal(value, publication.before) && value.kind === 'file') priorBytes = await fs.read(path, value);
          } catch {
            const pair = await fs.perform(manifestPath, { action: 'inspect-publication', source: basename(publication.capture), sourceExpected: publication.before });
            if (!pair.content) return 'recovery-required';
            value = pair.value; priorBytes = Buffer.from(pair.content, 'base64');
          }
          if (priorBytes && !equal(loadManifest(priorBytes, request.context), previous)) return 'recovery-required';
          if (path === publication.capture && value.kind !== 'absent' && !equal(value, publication.before)) return 'recovery-required';
        }
      }
      const bound = manifest ?? previous;
      if (bound && !equal(bound.paseo, { ...admission, minimumVersion: '0.8.0-beta.1' })) return 'recovery-required';
      if (previous && manifest && previous.installationId !== manifest.installationId) return 'recovery-required';
      const matching = manifest?.lastTransactionId === journal.transactionId;
      if (matching && manifest) {
        if (journal.operation === 'uninstall') {
          if (manifest.status !== 'uninstall-incomplete' || manifest.artifacts.some(artifact =>
            !previous?.artifacts.some(owned => equal(owned, artifact)) || journal.fileMutations.some(record => record.destination === artifact.path)) ||
            MANAGED_PROVIDER_IDS.some(id => manifest.providers[id] && (!equal(manifest.providers[id], previous?.providers[id]) || journal.providerAfter[id] === null))) return 'recovery-required';
        } else {
          const expected = new Map(previous?.artifacts.map(artifact => [artifact.path, artifact]) ?? []);
          for (const record of journal.fileMutations) {
            if (record.after.kind === 'absent') expected.delete(record.destination);
            else expected.set(record.destination, { ...record.after, path: record.destination });
          }
          if (!previous && manifest.artifacts.some(artifact => artifact.path === request.context.roomHome && artifact.kind === 'directory'))
            expected.set(request.context.roomHome, { kind: 'directory', mode: 0o700, path: request.context.roomHome });
          if (manifest.status !== 'committed' || manifest.artifacts.length !== expected.size || manifest.artifacts.some(artifact => !equal(expected.get(artifact.path), artifact)) ||
              MANAGED_PROVIDER_IDS.some(id => !equal(manifest.providers[id]?.applied, journal.providerAfter[id]))) return 'recovery-required';
        }
      }
      const fullUninstall = journal.operation === 'uninstall' && journal.state === 'committed' &&
        MANAGED_PROVIDER_IDS.every(id => journal.providerAfter[id] === null) && (!publication || publication.after.kind === 'absent');
      if (fullUninstall && !publication && current.kind !== 'absent') return 'recovery-required';
      if (matching || fullUninstall) {
        if (matching && publication && !equal(current, publication.after)) return 'recovery-required';
        if (fullUninstall && (manifest && !equal(manifest, previous) || !previous || publication && publication.after.kind !== 'absent')) return 'recovery-required';
        if (journal.fileMutations.some(record => record.progress !== 'completed' || record.pending !== null)) return 'recovery-required';
        for (const record of journal.fileMutations) for (const entry of record.privatePaths) {
          if ((await inspectTransactionPath(fs, join(dirname(record.destination), entry.name), entry.expected.kind !== 'file')).kind !== 'absent') return 'recovery-required';
        }
        if (request.apply !== true) return 'committed-cleanup';
        if (matching && publication && !await publication.committed()) return 'recovery-required';
        await tx.reconcileCommitted();
        if (fullUninstall && current.kind !== 'absent') {
          if (!publication) return 'recovery-required';
          await publication.publish();
        }
        if (publication) await publication.cleanup();
        await cleanupCommittedTransaction(tx);
        return 'recovered';
      }
      if (journal.state === 'committed') return 'recovery-required';
      if (manifest && !equal(manifest, previous) || !manifest && previous && !publication) return 'recovery-required';
      if (publication) {
        if (current.kind !== 'absent' && !equal(current, publication.before)) return 'recovery-required';
        for (const [path, expected] of [[publication.capture, publication.before], [publication.prepared, publication.after]] as const) {
          let value: FileValue;
          try { value = await fs.inspect(path); }
          catch {
            if (path !== publication.capture) return 'recovery-required';
            value = (await fs.perform(manifestPath, { action: 'inspect-publication', source: basename(publication.capture), sourceExpected: publication.before })).value;
          }
          if (value.kind !== 'absent' && !equal(value, expected)) return 'recovery-required';
          if (path === publication.capture && current.kind === 'absent' && previous && !equal(value, publication.before)) return 'recovery-required';
        }
      }
      const restore: Partial<TransactionProviderRecord> = {};
      const changed = MANAGED_PROVIDER_IDS.filter(id => !equal(journal.providerBefore[id], journal.providerAfter[id]));
      for (const id of journal.operation === 'uninstall' ? changed : MANAGED_PROVIDER_IDS) {
        const value = Object.hasOwn(live.providers, id) ? live.providers[id] : null;
        if (equal(value, journal.providerBefore[id])) continue;
        if (!equal(value, journal.providerAfter[id])) return 'recovery-required';
        restore[id] = journal.providerBefore[id];
      }
      // Preflight every destination; divergence leaves even independently safe
      // entries untouched. Captured/published values remain exact-value authority.
      for (const record of journal.fileMutations) {
        const before: FileValue = record.before.kind === 'file'
          ? { kind: 'file', mode: record.before.mode, sha256: record.before.sha256 } : record.before;
        let value: FileValue;
        try { value = await inspectTransactionPath(fs, record.destination, record.before.kind !== 'file' && record.after.kind !== 'file'); }
        catch {
          const prepared = record.privatePaths.find(entry => entry.role === (record.progress === 'compensating' ? 'rollback-prepared' : 'prepared'));
          if (!prepared || record.pending?.action !== 'publish') return 'recovery-required';
          value = (await fs.perform(record.destination, { action: 'inspect-publication', source: prepared.name, sourceExpected: prepared.expected })).value;
        }
        if ((record.progress === 'planned' || terminalRollback) && !equal(value, before)) return 'recovery-required';
        if (record.parent && value.kind !== 'absent') {
          const parent = await fs.parent(record.destination);
          if (!equal({ ...parent, links: record.parent.links }, record.parent)) return 'recovery-required';
        }
        for (const entry of record.privatePaths) {
          const path = join(dirname(record.destination), entry.name);
          try {
            const privateValue = await inspectTransactionPath(fs, path, entry.expected.kind !== 'file');
            if (privateValue.kind !== 'absent' && !equal(privateValue, entry.expected)) return 'recovery-required';
          } catch {
            if (!['prepared', 'rollback-prepared'].includes(entry.role)) return 'recovery-required';
            await fs.perform(record.destination, { action: 'inspect-publication', source: entry.name, sourceExpected: entry.expected });
          }
        }
        if (!equal(value, before) && !equal(value, record.after)) {
          if (value.kind !== 'absent') return 'recovery-required';
          const capture = record.privatePaths.find(entry => entry.role === 'capture');
          const rollbackCapture = record.privatePaths.find(entry => entry.role === 'rollback-capture');
          const forwardInterrupted = capture && equal(await fs.inspect(join(dirname(record.destination), capture.name)), before);
          const reverseInterrupted = record.progress === 'compensating' && rollbackCapture &&
            equal(await fs.inspect(join(dirname(record.destination), rollbackCapture.name)), record.after);
          if (!forwardInterrupted && !reverseInterrupted) return 'recovery-required';
        }
      }
      // Validate all existing private leaves before touching the manifest/providers.
      for (const record of journal.fileMutations) {
        if (!terminalRollback && record.before.kind === 'file' && record.progress !== 'planned') {
          const backup = await fs.inspect(join(directory, 'before', record.before.backup));
          if (!equal(backup, { kind: 'file', mode: record.before.mode, sha256: record.before.sha256 })) return 'recovery-required';
        }
      }
      if (request.apply !== true) return 'reversible';
      const liveStillStable = async (): Promise<boolean> => {
        const now = await gateway.readConfig();
        return MANAGED_PROVIDER_IDS.every(id => equal(Object.hasOwn(now.providers, id) ? now.providers[id] : null,
          Object.hasOwn(live.providers, id) ? live.providers[id] : null)) && await gateway.sessionsSafe(request.policy);
      };
      if (!await liveStillStable()) return 'recovery-required';
      if (publication) { await publication.restore(); await publication.retireTemporaries(); }
      // Uninstall compensation only recreates files. Restore those before making
      // providers runnable again; a failed recreation preserves provider absence.
      if (journal.operation === 'uninstall' && await tx.compensate() !== 'rolled-back') return 'recovery-required';
      // Manifest/filesystem restoration can be lengthy. Do not overwrite a provider
      // or disturb a newly active session based on the earlier classification read.
      if (!await liveStillStable()) return 'recovery-required';
      if (Object.keys(restore).length) await guardedProviderMutation(request.context, fs, () => gateway.restoreProviders(restore));
      const restored = await gateway.readConfig();
      // For install/update, all namespace entries must be back to before, even
      // entries that were not patched. Never remove potentially referenced files.
      const verifyIds = journal.operation === 'uninstall' ? changed : MANAGED_PROVIDER_IDS;
      if (verifyIds.some(id => !equal(Object.hasOwn(restored.providers, id) ? restored.providers[id] : null, journal.providerBefore[id])) ||
          !await gateway.verifyRestored(journal.providerBefore, request.policy, verifyIds)) return 'recovery-required';
      if (await tx.compensate() !== 'rolled-back') return 'recovery-required';
      const dischargeRoot = journal.bootstrapEndpointIdentitySha256 !== null;
      if (dischargeRoot) await bootstrap.armDischarge(request.context);
      if (publication) await publication.cleanup();
      await tx.cleanup();
      if (dischargeRoot) await bootstrap.discharge(request.context);
      return 'rolled-back';
    });
  } catch { return 'recovery-required'; }
  finally { if (lock) await lock.release(); }
}
