import type { NormalizedIntent } from './intent.js';
import type { InstallationManifestV1, ManifestArtifact } from './manifest.js';
import type { OwnedStateObservation, OwnershipState } from './observation.js';
import { canonicalJson } from './hash.js';
import { commandResultSchema, type CheckResult, type CommandResult, type PlannedOperation } from './result.js';
import { providerEntriesEqual, type ProviderOverrideV1 } from '../paseo/provider-policy.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';

export interface PlannerDesiredState {
  /** Validated adapter declarations reduced to metadata/digests, never credentials. */
  readonly artifacts: readonly ManifestArtifact[];
  readonly providers: Readonly<Partial<Record<ManagedProviderId, ProviderOverrideV1>>>;
}
export interface PlannerPathFact {
  readonly path: string;
  /** Absence must include safe-parent admission; an IO failure is not absence. */
  readonly occupancy: 'absent' | 'occupied' | 'unsafe' | 'not-checked';
  /** Optional safe, no-follow comparison metadata; never read a link target. */
  readonly current?: ManifestArtifact;
}
export type PlannerPaseoFacts = { readonly mode: 'offline' } | {
  readonly mode: 'live';
  readonly admission: 'pass' | 'fail';
  readonly providers: Readonly<Record<string, unknown>>;
  readonly activeSessions: readonly { readonly providerId: string }[] | 'not-checked';
  readonly readiness: Readonly<Record<string, 'ready' | 'not-ready'>> | 'not-checked';
};
export interface PlannerInput {
  readonly intent: Pick<NormalizedIntent, 'command' | 'apply'>;
  readonly desired: PlannerDesiredState;
  readonly current: {
    readonly paths: readonly PlannerPathFact[];
    /** Already validated at the manifest boundary. Observation is from the same snapshot. */
    readonly owned?: { readonly manifest: InstallationManifestV1; readonly observation: OwnedStateObservation };
    readonly paseo: PlannerPaseoFacts;
    readonly unfinishedJournal: boolean;
  };
}
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const sameArtifact = (a: ManifestArtifact, b: ManifestArtifact): boolean => canonicalJson(a) === canonicalJson(b);
const targetKey = (target: PlannedOperation['target']): string => target.kind === 'provider' ? target.id : target.path;

/** Provider operations describe ONE conceptual patch, in fixed role order.
 * Publish directories (shallow first), leaves, then providers. Uninstall reverses
 * dependencies: providers, leaves, deepest directories. Directory removal means
 * rmdir-if-empty, NEVER recursive deletion or ownership of mutable children.
 */
function operationOrder(a: PlannedOperation, b: PlannedOperation): number {
  const rank = (op: PlannedOperation): number => op.action === 'remove'
    ? op.target.kind === 'provider' ? 0 : op.target.kind === 'directory' ? 2 : 1
    : op.target.kind === 'directory' ? 3 : op.target.kind === 'provider' ? 5 : 4;
  const difference = rank(a) - rank(b);
  if (difference) return difference;
  if (a.target.kind === 'provider' && b.target.kind === 'provider') return MANAGED_PROVIDER_IDS.indexOf(a.target.id) - MANAGED_PROVIDER_IDS.indexOf(b.target.id);
  if (a.target.kind === 'directory' && b.target.kind === 'directory') {
    const depth = a.target.path.split('/').length - b.target.path.split('/').length;
    if (depth) return a.action === 'remove' ? -depth : depth;
  }
  return compare(a.target.kind, b.target.kind) || compare(targetKey(a.target), targetKey(b.target));
}

/** Pure lifecycle planning. Noops are omitted consistently (including discharge).
 * Failed install/update plans contain no mutation operations. Partial uninstall
 * keeps only safe removals when ownership conflicts exist; global blockers still
 * suppress all removals. Offline plans intentionally omit unverified providers
 * and return failed, never an apply-ready success. Execution must re-probe under lock.
 */
export function planLifecycle(input: PlannerInput): CommandResult {
  const { command } = input.intent;
  const { owned, paseo, unfinishedJournal } = input.current;
  const uninstall = command === 'uninstall';
  const inspect = command === 'verify' || command === 'doctor';
  const checks: CheckResult[] = [];
  let operations: PlannedOperation[] = [];
  const conflicts = new Set<string>();
  let blocked = false;
  const check = (id: string, status: CheckResult['status'], message: string): void => {
    checks.push({ id, status, message });
  };
  const fail = (id: string, message: string): void => { blocked = true; check(id, 'fail', message); };
  const mismatch = (id: string, state: string): void => {
    if (!inspect) conflicts.add(id);
    check(id, 'fail', `${state}; preserve current state and reconcile ownership explicitly.`);
  };
  const operation = (action: 'create' | 'update' | 'remove', target: PlannedOperation['target']): void => {
    if (inspect) return;
    operations.push({ action, target, description: target.kind === 'directory' && action === 'remove'
      ? 'Remove owned directory only if empty; preserve mutable children.'
      : `${action === 'create' ? 'Create' : action === 'update' ? 'Update' : 'Remove'} managed ${target.kind}.` });
  };
  if (unfinishedJournal) check('journal.unfinished', inspect ? 'warn' : 'fail', 'Unfinished journal; normal mutation is blocked. Use recover explicitly.');
  if (command === 'recover') fail('recovery.execution', 'Recovery execution is not a lifecycle planning operation.');
  if ((inspect || uninstall) && !owned) fail('manifest.required', 'No validated ownership manifest; no owned state can be verified or removed.');
  if (owned?.manifest.status === 'uninstall-incomplete') {
    if (inspect) fail('manifest.residual', 'Uninstall is incomplete; the complete installed room cannot be verified.');
    else if (!uninstall) fail('manifest.residual', 'Uninstall is incomplete; discharge residual ownership before installing.');
  }

  // Field identifiers only: never echo arbitrary live/source values in diagnostics.
  for (const field of [...new Set(owned?.observation.drift ?? [])].sort(compare)) {
    const safeField = /^[a-zA-Z][a-zA-Z0-9.]*$/.test(field) ? field : 'unknown';
    // Source content/package changes are expected on explicit regeneration. Identity
    // changes are not authorization to retarget existing ownership, even on uninstall.
    const compatible = ['packageVersion', 'source.canonicalConfigSha256', 'source.codexVersion', 'source.codexLaunchArgv'].includes(field);
    if (compatible && !inspect) check(`drift.${safeField}`, 'warn', 'Recorded source/package differs; explicit regeneration uses validated desired declarations.');
    else fail(`drift.${safeField}`, 'Recorded binding differs; inspect and reconcile before mutation.');
  }
  if (paseo.mode === 'offline') {
    blocked = true;
    check('paseo.admission', 'not-checked', 'Live admission unavailable; this plan is informative, not apply-ready.');
    check('paseo.sessions', 'not-checked', 'Active managed sessions have not been checked.');
  } else {
    if (paseo.admission === 'fail') fail('paseo.admission', 'Local daemon admission failed; no mutation is safe.');
    else check('paseo.admission', 'pass', 'Local daemon admission passed; execution must re-probe under lock.');
    if (!inspect) {
      if (paseo.activeSessions === 'not-checked') {
        blocked = true;
        check('paseo.sessions', 'not-checked', 'Active managed sessions have not been checked; mutation is blocked.');
      } else if (paseo.activeSessions.some(session => MANAGED_PROVIDER_IDS.some(id => id === session.providerId))) {
        fail('paseo.sessions', 'Active managed sessions block mutation; stop them explicitly before applying.');
      } else check('paseo.sessions', 'pass', 'No active managed sessions.');
    }
  }

  const artifacts = owned ? owned.manifest.artifacts : inspect || uninstall ? [] : input.desired.artifacts;
  const seen = new Set<string>();
  for (const prior of [...artifacts].sort((a, b) => compare(a.path, b.path))) {
    const id = `artifact.${prior.kind}:${prior.path}`;
    if (seen.has(prior.path)) { fail('input.artifacts', 'Duplicate managed artifact declarations.'); continue; }
    seen.add(prior.path);
    const target = { kind: prior.kind, path: prior.path };
    const facts = input.current.paths.filter(fact => fact.path === prior.path);
    const fact = facts.length === 1 ? facts[0] : undefined;
    if (!owned) {
      if (fact?.occupancy === 'absent') { check(id, 'pass', 'Managed destination is absent.'); operation('create', target); }
      else mismatch(id, fact?.occupancy ?? 'not-checked');
      continue;
    }
    const observed = owned.observation.artifacts.filter(item => item.path === prior.path);
    const state: OwnershipState | 'not-checked' = observed.length === 1 ? observed[0]?.state ?? 'not-checked' : 'not-checked';
    if (inspect) {
      if (state === 'unchanged') check(id, 'pass', 'Owned artifact matches last applied metadata.');
      else mismatch(id, state);
    } else if (uninstall) {
      if (state === 'missing') check(id, 'pass', 'Owned artifact missing; ownership discharged.');
      else if (state === 'unchanged') { check(id, 'pass', 'Owned artifact unchanged.'); operation('remove', target); }
      else mismatch(id, state);
    } else {
      const desired = input.desired.artifacts.filter(item => item.path === prior.path);
      const next = desired.length === 1 ? desired[0] : undefined;
      if (!next || next.kind !== prior.kind) { mismatch(id, 'Desired declaration missing, duplicate, or changed type'); continue; }
      if (state === 'unchanged') {
        check(id, 'pass', 'Owned artifact unchanged; ownership retained.');
        if (!sameArtifact(prior, next)) operation('update', target);
      } else if (state === 'customized' && fact?.occupancy === 'occupied' && fact.current && sameArtifact(fact.current, next)) {
        check(id, 'pass', 'Current artifact equals desired; ownership retained.');
      } else mismatch(id, state);
    }
  }

  for (const id of MANAGED_PROVIDER_IDS) {
    const prior = owned?.manifest.providers[id];
    const desired = input.desired.providers[id];
    if (owned ? !prior : inspect || uninstall) continue;
    const checkId = `provider.${id}`;
    if (paseo.mode === 'offline' || paseo.admission === 'fail') {
      check(checkId, 'not-checked', 'Live provider configuration unavailable; no provider operation is authorized.');
      if (inspect) check(`${checkId}.ready`, 'not-checked', 'Live provider readiness unavailable.');
      continue;
    }
    const exists = Object.hasOwn(paseo.providers, id);
    const current = paseo.providers[id];
    if (!owned) {
      if (exists) mismatch(checkId, 'Managed provider ID occupied');
      else if (!desired) fail(checkId, 'Required managed provider declaration missing.');
      else { check(checkId, 'pass', 'Managed provider ID absent.'); operation('create', { kind: 'provider', id }); }
      continue;
    }
    if (!inspect && !uninstall && !desired) { mismatch(checkId, 'Desired provider missing'); continue; }
    const observations = owned.observation.providers.filter(item => item.id === id);
    const state = observations.length === 1 ? observations[0]?.state : undefined;
    const unchanged = state === 'unchanged' && exists && prior && providerEntriesEqual(id, prior.applied, current);
    if (uninstall && state === 'missing' && !exists) check(checkId, 'pass', 'Owned provider missing; ownership discharged.');
    else if (unchanged) {
      check(checkId, 'pass', 'Owned provider matches last applied complete policy.');
      if (uninstall) operation('remove', { kind: 'provider', id });
      else if (!inspect && !providerEntriesEqual(id, desired, current)) operation('update', { kind: 'provider', id });
    } else if (!inspect && !uninstall && state === 'customized' && exists && desired && providerEntriesEqual(id, desired, current)) {
      check(checkId, 'pass', 'Current provider equals desired; ownership retained.');
    } else mismatch(checkId, state ?? 'not-checked');
    if (inspect) {
      const ready = paseo.readiness === 'not-checked' ? undefined : paseo.readiness[id];
      if (ready === undefined) { blocked = true; check(`${checkId}.ready`, 'not-checked', 'Live provider readiness unavailable.'); }
      else check(`${checkId}.ready`, ready === 'ready' ? 'pass' : 'fail', ready === 'ready' ? 'Managed provider ready.' : 'Managed provider not ready.');
    }
  }
  const recovery = unfinishedJournal && !inspect;
  const conflict = conflicts.size > 0;
  if (blocked || recovery || conflict && !uninstall || inspect) operations = [];
  const outcome: CommandResult['outcome'] = recovery ? 'recovery-required' : conflict ? 'conflict'
    : blocked || checks.some(item => item.status === 'fail') ? 'failed' : operations.length ? 'changes-planned' : 'ok';
  // Duplicate generic diagnostics can arise from multiple malformed declarations.
  const canonicalChecks = [...new Map(checks.map(item => [canonicalJson(item), item])).values()]
    .sort((a, b) => compare(a.id, b.id) || compare(a.message, b.message));
  return commandResultSchema.parse({ schemaVersion: 1, command, outcome, changed: false,
    checks: canonicalChecks, operations: operations.sort(operationOrder) });
}

/** Compatibility for the foundation CLI/package tests; discovery wiring is a later Bead. */
export function placeholderPlan(): CommandResult {
  return {
    schemaVersion: 1, command: 'plan', outcome: 'ok', changed: false,
    checks: [{
      id: 'planner.unavailable', status: 'not-checked',
      message: 'Placeholder plan only; prerequisites and desired changes have not been checked.',
      remediation: 'Use a future release with lifecycle planning before installing a room.',
    }],
    operations: [],
  };
}
