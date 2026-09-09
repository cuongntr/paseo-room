import { createPaseoClient, type PaseoClientConfig } from '@getpaseo/client';
import { z } from 'zod';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';
import { type TransactionProviderRecord } from '../core/transaction.js';
import { type LocalAdmission, type ProbeInput, type ProbeDependencies, timeoutValue, fail } from './cli-probe.js';
import { withPaseoConfig, verifyPaseo, type ConfigClient, type VerificationClient, type ProviderConfigGateway } from './gateway.js';
import { providerEntriesEqual, validateProviderEntry, type ProviderPolicy } from './provider-policy.js';
import { assessLiveVerification, type LiveVerificationResult } from './verification.js';

const refreshResponse = z.object({ acknowledged: z.literal(true) });
const providerSnapshot = z.object({ entries: z.array(z.object({ provider: z.string().min(1),
  status: z.enum(['ready', 'loading', 'error', 'unavailable']), enabled: z.boolean().optional() })) });
const configResponse = z.object({ config: z.object({ providers: z.record(z.string(), z.unknown()) }) });

export interface TransactionGateway extends ProviderConfigGateway {
  sessionsSafe(desired: ProviderPolicy): Promise<boolean>;
  restoreProviders(values: Partial<TransactionProviderRecord>): Promise<void>;
  verify(desired: ProviderPolicy): Promise<LiveVerificationResult>;
  verifyRestored(before: TransactionProviderRecord, desired: ProviderPolicy, ids?: readonly ManagedProviderId[]): Promise<boolean>;
}
export type TransactionClient = ConfigClient & VerificationClient & { readonly providers: VerificationClient['providers'] & { snapshot(): Promise<unknown> } };
export type TransactionClientFactory = (config: PaseoClientConfig) => TransactionClient;
/** Public-root SDK only. Extra transaction operations share the admitted config
 * connection; complete all-provider appVersion makes session inventory visible. */
export async function withTransactionGateway<T>(input: ProbeInput, deps: ProbeDependencies, password: string | undefined,
  operation: (gateway: TransactionGateway, admission: LocalAdmission) => Promise<T>,
  factory: TransactionClientFactory = createPaseoClient): Promise<T> {
  let client: TransactionClient | undefined;
  const bounded = async <R>(action: Promise<R>): Promise<R> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([action, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('Transaction RPC failed.')); }, timeoutValue(input.timeoutMs));
    })]); } catch { return fail('config', 'Transaction RPC failed; reconcile current state. No mutation was retried.'); }
    finally { clearTimeout(timer); }
  };
  return withPaseoConfig(input, deps, password, async (gateway, admission) => {
    const connected = client;
    if (!connected) throw new Error('Transaction connection unavailable.');
    return operation({ ...gateway,
      async sessionsSafe(desired) {
        const result = assessLiveVerification(desired, undefined, undefined, await bounded(connected.agents.list()));
        return result.checks.filter(check => check.id.startsWith('paseo.agents.')).every(check => check.status === 'pass');
      },
      async restoreProviders(values) {
        const providers: Partial<Record<ManagedProviderId, ReturnType<typeof validateProviderEntry>>> = {};
        const removeProviders: ManagedProviderId[] = [];
        if (Object.keys(values).some(id => !MANAGED_PROVIDER_IDS.some(managed => managed === id))) throw new Error('Invalid restoration.');
        for (const id of MANAGED_PROVIDER_IDS) {
          if (!Object.hasOwn(values, id)) continue;
          if (values[id] === null) removeProviders.push(id);
          else providers[id] = validateProviderEntry(id, values[id]);
        }
        if (Object.keys(providers).length || removeProviders.length) {
          await bounded(connected.config.patch({ ...(Object.keys(providers).length ? { providers } : {}),
            ...(removeProviders.length ? { removeProviders } : {}) }));
        }
      },
      verify: desired => verifyPaseo(input, deps, password, desired, config => {
        // A fresh status probe must not silently move verification outside the
        // namespace currently locked by the transaction.
        if (config.url !== `${admission.listen}/ws`) return fail('config', 'Local endpoint changed during the transaction; preserve recovery evidence.');
        return factory(config);
      }),
      async verifyRestored(before, desired, ids = MANAGED_PROVIDER_IDS) {
        const refresh = refreshResponse.safeParse(await bounded(connected.providers.refresh({ providers: [...MANAGED_PROVIDER_IDS] })));
        if (!refresh.success) return false;
        const snapshot = providerSnapshot.safeParse(await bounded(connected.providers.snapshot()));
        const config = configResponse.safeParse(await bounded(connected.config.get()));
        const inventory = await bounded(connected.agents.list());
        if (!snapshot.success || !config.success) return false;
        const agentChecks = assessLiveVerification(desired, snapshot.data, config.data, inventory).checks
          .filter(check => check.id.startsWith('paseo.agents.'));
        if (!agentChecks.every(check => check.status === 'pass')) return false;
        return ids.every(id => {
          const expected = before[id];
          const liveConfig = config.data.config.providers;
          const entries = snapshot.data.entries.filter(entry => entry.provider === id);
          if (expected === null) return !Object.hasOwn(liveConfig, id) && entries.length === 0;
          return Object.hasOwn(liveConfig, id) && providerEntriesEqual(id, liveConfig[id], expected) && entries.length === 1 &&
            entries[0]?.status === 'ready' && entries[0].enabled !== false;
        });
      },
    }, admission);
  }, config => { client = factory({ ...config, appVersion: '0.8.0-beta.1' }); return client; });
}
