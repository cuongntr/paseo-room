import { createPaseoClient } from '@getpaseo/client';
import { withPaseoConfig } from './gateway.js';
import { type ProbeInput, type ProbeDependencies, timeoutValue } from './cli-probe.js';
import { type TransactionClient, type TransactionClientFactory } from './transaction-gateway.js';
import { type ProviderPolicy } from './provider-policy.js';
import { assessLiveVerification } from './verification.js';

/** Snapshot only: no registry refresh, wait-for-ready activation or config patch. */
export async function observePaseo(input: ProbeInput, deps: ProbeDependencies, password: string | undefined,
  policy: ProviderPolicy, factory: TransactionClientFactory = createPaseoClient) {
  let client: TransactionClient | undefined;
  return withPaseoConfig(input, deps, password, async (gateway, admission) => {
    if (!client) throw new Error('No admitted connection.');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const [snapshot, config, inventory] = await Promise.race([
        Promise.all([client.providers.snapshot(), gateway.readConfig(), client.agents.list()]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('Read-only observation timed out.')); }, timeoutValue(input.timeoutMs)); }),
      ]);
      return { admission, providers: config.providers,
        verification: assessLiveVerification(policy, snapshot, { config }, inventory) };
    } finally { clearTimeout(timer); }
  }, config => { client = factory({ ...config, appVersion: '0.8.0-beta.1' }); return client; });
}
