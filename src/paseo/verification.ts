import { z } from 'zod';
import type { CheckResult } from '../core/result.js';
import { MANAGED_PROVIDER_IDS, managedProviderIdSchema, type ManagedProviderId } from '../room/roles.js';
import { providerEntriesEqual, type ProviderPolicy } from './provider-policy.js';

const ids = [...MANAGED_PROVIDER_IDS].sort();
const identified = z.object({ provider: z.string().min(1) });
// Validate the safety projection without coercion/defaults. Informational SDK
// fields are not policy evidence and are neither retained nor rendered.
const providerEntry = identified.extend({ status: z.enum(['ready', 'loading', 'error', 'unavailable']),
  enabled: z.boolean().optional(), error: z.string().optional() });
const entriesResponse = z.object({ entries: z.array(z.unknown()) });
const configResponse = z.object({ config: z.object({ providers: z.record(z.string(), z.unknown()) }) });
const inventoryResponse = entriesResponse.extend({ pageInfo: z.object({
  hasMore: z.literal(false), nextCursor: z.null(), prevCursor: z.null(),
}) });
const agentWrapper = z.object({ agent: identified });
const agentState = identified.extend({ id: z.string().min(1),
  status: z.enum(['error', 'initializing', 'idle', 'running', 'closed']),
  archivedAt: z.string().min(1).nullable().optional(),
});
export interface LiveVerificationResult {
  readonly ok: boolean;
  readonly checks: readonly CheckResult[];
  readonly readyProviderIds: readonly ManagedProviderId[];
  readonly activeManagedProviderIds: readonly ManagedProviderId[];
}
function check(id: string, pass: boolean, message: string, remediation: string): CheckResult {
  return { id: `paseo.${id}`, status: pass ? 'pass' : 'fail', message, ...(pass ? {} : { remediation }) };
}

/** Only fixed IDs and locally authored diagnostics leave this untrusted boundary.
 * Empty ID arrays are NOT success: consumers must require ok/checks to pass.
 */
export function assessLiveVerification(desired: ProviderPolicy, snapshot: unknown, config: unknown, inventory: unknown): LiveVerificationResult {
  const checks: CheckResult[] = [];
  const readyProviderIds: ManagedProviderId[] = [];
  const active = new Set<ManagedProviderId>();
  const providers = entriesResponse.safeParse(snapshot);
  const identifiable = providers.success && providers.data.entries.every(value => identified.safeParse(value).success);
  checks.push(check('providers.inventory', identifiable, 'Provider inventory must identify every entry.',
    'Check local provider discovery and daemon compatibility; unidentified entries cannot be verified.'));
  const live = configResponse.safeParse(config);
  for (const id of ids) {
    const matches = providers.success ? providers.data.entries.filter(value => {
      const parsed = identified.safeParse(value); return parsed.success && parsed.data.provider === id;
    }) : [];
    const parsed = providerEntry.safeParse(matches[0]);
    const ready = identifiable && matches.length === 1 && parsed.success && parsed.data.status === 'ready' && parsed.data.enabled !== false;
    if (ready) readyProviderIds.push(id);
    checks.push(check(`providers.${id}.ready`, ready, `${id} must occur exactly once and be ready.`,
      'Check the managed executable and role home, then run verification again after discovery completes.'));
    const equal = live.success && Object.hasOwn(live.data.config.providers, id) && providerEntriesEqual(id, live.data.config.providers[id], desired[id]);
    checks.push(check(`providers.${id}.policy`, equal,
      `${id} must exactly match the desired fixed entry (paseoTools.enabled=${String(desired[id].paseoTools.enabled)}).`,
      'Reconcile the complete managed provider entry against owned desired state; missing, extra, inherited, or wrong policy is not accepted.'));
  }
  const agents = inventoryResponse.safeParse(inventory);
  let complete = agents.success;
  // Even an incomplete page may contain known blockers: retain those fixed IDs.
  const page = entriesResponse.safeParse(inventory);
  if (page.success) for (const value of page.data.entries) {
    const wrapper = agentWrapper.safeParse(value);
    if (!wrapper.success) { complete = false; continue; }
    const managed = managedProviderIdSchema.safeParse(wrapper.data.agent.provider);
    if (!managed.success) continue;
    const state = z.object({ agent: agentState }).safeParse(value);
    if (!state.success) { complete = false; active.add(managed.data); continue; }
    // Error is deliberately blocking. Only closed or explicitly archived is terminal.
    if (state.data.agent.status !== 'closed' && state.data.agent.archivedAt == null) active.add(managed.data);
  }
  checks.push(check('agents.inventory', complete, 'Agent inventory must be complete and safely interpretable.',
    'Inspect the local agent inventory; incomplete pagination or malformed managed state blocks mutation.'));
  for (const id of ids) checks.push(check(`agents.${id}.inactive`, complete && !active.has(id),
    `${id} must have no non-terminal agents.`,
    'Close or archive managed agents explicitly, then recheck under the transaction lock; error and idle agents still block mutation.'));
  return { ok: checks.every(value => value.status === 'pass'), checks, readyProviderIds,
    activeManagedProviderIds: [...active].sort() };
}
