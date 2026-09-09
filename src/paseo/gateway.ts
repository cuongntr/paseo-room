import { createPaseoClient, type PaseoClient, type PaseoClientConfig } from '@getpaseo/client';
import { fail, PaseoAdmissionError, probePaseo, timeoutValue, type LocalAdmission, type ProbeDependencies, type ProbeInput } from './cli-probe.js';
import { z } from 'zod';
import { MANAGED_PROVIDER_IDS } from '../room/roles.js';
import { validateProviderPolicy, type ProviderPolicy } from './provider-policy.js';
import { assessLiveVerification, type LiveVerificationResult } from './verification.js';
import type { CheckResult } from '../core/result.js';

export type ConnectionClient = Pick<PaseoClient, 'connect' | 'close' | 'getConnectionState'>;
export type ClientFactory = (config: PaseoClientConfig) => ConnectionClient;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('Connection timed out')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function withClient<T, Client extends ConnectionClient>(
  input: ProbeInput,
  deps: ProbeDependencies,
  password: string | undefined,
  factory: (config: PaseoClientConfig) => Client,
  operation: (client: Client, admission: LocalAdmission) => Promise<T>,
): Promise<T> {
  const admission = await probePaseo(input, deps, password);
  const timeoutMs = timeoutValue(input.timeoutMs);
  let client: Client | undefined;
  try {
    client = factory({ url: `${admission.listen}/ws`, ...(password === undefined ? {} : { password }),
      connectTimeoutMs: timeoutMs, reconnect: { enabled: false }, logger: quiet });
    await bounded(client.connect(), timeoutMs);
    if (client.getConnectionState().status !== 'connected') fail('unreachable', 'Check that the local Paseo daemon accepts SDK connections.');
    return await operation(client, admission);
  } catch (error) {
    if (error instanceof PaseoAdmissionError) throw error;
    // Never return raw SDK error text, URLs, logger data, or password content.
    const message = error instanceof Error ? error.message : '';
    if (message === 'Password required') fail('auth_required', 'Set PASEO_PASSWORD in memory and retry.');
    if (message === 'Incorrect password') fail('auth_failed', 'Check PASEO_PASSWORD and retry.');
    return fail('unreachable', 'SDK connection failed; check local reachability and PASEO_PASSWORD.');
  } finally {
    if (client) {
      try { await bounded(client.close(), timeoutMs); }
      catch { fail('cleanup', 'SDK connection cleanup failed; retry after checking the local daemon.'); }
    }
  }
}

/** Read-only admission and public SDK handshake. No peer identity claim. */
export async function connectPaseo(
  input: ProbeInput, deps: ProbeDependencies, password: string | undefined,
  factory: ClientFactory = createPaseoClient,
): Promise<LocalAdmission> {
  return withClient(input, deps, password, factory, (_client, admission) => Promise.resolve(admission));
}

/** Keep SDK request typing, but deliberately distrust response typing. */
export type ConfigClient = ConnectionClient & { readonly config: {
  get(): Promise<unknown>;
  patch(patch: Parameters<PaseoClient['config']['patch']>[0]): Promise<unknown>;
} };
export type ConfigClientFactory = (config: PaseoClientConfig) => ConfigClient;
/** Read-only RPCs plus explicit registry refresh; response types remain untrusted. */
export type VerificationClient = ConnectionClient & {
  readonly providers: {
    refresh(options: Parameters<PaseoClient['providers']['refresh']>[0]): Promise<unknown>;
    waitForReady(options: Parameters<PaseoClient['providers']['waitForReady']>[0]): Promise<unknown>;
  };
  readonly config: { get(): Promise<unknown> };
  readonly agents: { list(): Promise<unknown> };
};
export type VerificationClientFactory = (config: PaseoClientConfig) => VerificationClient;

/** One admitted connection; one refresh, bounded wait, config read and inventory read.
 * No config writes, agent actions, or automatic retries. Caller owns the transaction
 * lock and must require every check to pass before treating these facts as safe.
 * Admission/connection/cleanup failures throw a sanitized PaseoAdmissionError.
 */
export async function verifyPaseo(
  input: ProbeInput, deps: ProbeDependencies, password: string | undefined, desired: unknown,
  factory: VerificationClientFactory = createPaseoClient,
): Promise<LiveVerificationResult> {
  let policy: ProviderPolicy;
  try { policy = validateProviderPolicy(desired); }
  catch { return fail('verification_policy', 'Supply a valid complete fixed three-provider desired policy.'); }
  // The pinned daemon hides derived providers AND their agents from clients
  // without an all-provider compatibility declaration. Public appVersion is the
  // supported SDK knob: this declares our pinned client protocol baseline, not
  // paseo-room's package version or evidence of connected daemon identity.
  return withClient(input, deps, password, config => factory({ ...config, appVersion: '0.8.0-beta.1' }), async client => {
    const checks: CheckResult[] = [];
    const invoke = async (name: string, operation: () => Promise<unknown>): Promise<unknown> => {
      try { return await bounded(operation(), timeoutValue(input.timeoutMs)); }
      catch {
        checks.push({ id: `paseo.verification.${name}`, status: 'fail', message: `Live ${name} operation failed or timed out.`,
          remediation: 'Check local daemon compatibility and reachability; reconcile live state before another explicit verification. No operation was retried.' });
        return undefined;
      }
    };
    await invoke('refresh', async () => {
      const response = await client.providers.refresh({ providers: [...MANAGED_PROVIDER_IDS] });
      return z.object({ acknowledged: z.literal(true) }).parse(response);
    });
    const snapshot = await invoke('wait', () => client.providers.waitForReady({ timeoutMs: timeoutValue(input.timeoutMs) }));
    const config = await invoke('config', () => client.config.get());
    const inventory = await invoke('agents', () => client.agents.list());
    const result = assessLiveVerification(policy, snapshot, config, inventory);
    return { ...result, ok: checks.length === 0 && result.ok,
      readyProviderIds: checks.some(check => check.id === 'paseo.verification.refresh') ? [] : result.readyProviderIds,
      checks: [...checks, ...result.checks] };
  });
}
const configResponse = z.object({ config: z.object({ providers: z.record(z.string(), z.unknown()) }) });
export interface ProviderConfig {
  /** Raw whole entries, NOT ownership evidence. Validate/compare before claiming. */
  readonly providers: Readonly<Record<string, unknown>>;
}
function normalizeConfig(response: unknown): ProviderConfig {
  const parsed = configResponse.safeParse(response);
  if (!parsed.success) fail('config', 'Invalid SDK config response; verify the local daemon before continuing.');
  // Do not expose unrelated config (which can contain credentials) to lifecycle artifacts.
  return parsed.data.config;
}
export interface ProviderConfigGateway {
  readConfig(): Promise<ProviderConfig>;
  patchProviders(providers: unknown): Promise<ProviderConfig>;
  removeProviders(): Promise<ProviderConfig>;
}

/** Caller owns confirmation, lock, journal, and before/after ownership comparisons.
 * Each mutation is ONE RPC, never retried or converted into remove/add migration.
 * A failure may have committed; reconcile live state before any further mutation.
 * The callback must await its operations; the connection closes on every exit.
 */
export async function withPaseoConfig<T>(
  input: ProbeInput, deps: ProbeDependencies, password: string | undefined,
  operation: (gateway: ProviderConfigGateway, admission: LocalAdmission) => Promise<T>,
  factory: ConfigClientFactory = createPaseoClient,
): Promise<T> {
  return withClient(input, deps, password, factory, async (client, admission) => {
    const invoke = async (action: () => Promise<unknown>): Promise<ProviderConfig> => {
      try { return normalizeConfig(await bounded(action(), timeoutValue(input.timeoutMs))); }
      catch { return fail('config', 'SDK config operation failed; reconcile live state before retrying any mutation.'); }
    };
    try {
      return await operation({
        readConfig: () => invoke(() => client.config.get()),
        patchProviders: providers => {
          const policy = validateProviderPolicy(providers);
          return invoke(() => client.config.patch({ providers: policy }));
        },
        removeProviders: () => invoke(() => client.config.patch({ removeProviders: [...MANAGED_PROVIDER_IDS] })),
      }, admission);
    } catch {
      // Callback and validation errors are also untrusted; never include their text.
      return fail('config', 'SDK config operation failed; reconcile live state before retrying any mutation.');
    }
  });
}
