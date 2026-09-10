import type { PaseoClient, PaseoClientConfig } from '@getpaseo/client';
import { gte, valid } from 'semver';
import { z } from 'zod';
import type { Layout } from './layout.js';
import { fail, pass, type Check } from './result.js';
import type { Provider } from './agents/types.js';
import { probe, which } from './which.js';

export const MINIMUM_VERSION = '0.8.0-beta.1';

const statusSchema = z.object({
  listen: z.string().min(1),
  localDaemon: z.enum(['running', 'stopped', 'stale_pid', 'unresponsive']),
  cliVersion: z.string(),
  daemonVersion: z.string().nullable(),
});

export interface Daemon {
  readonly url: string;
  readonly version: string;
}
export interface DaemonResult {
  readonly checks: readonly Check[];
  readonly daemon?: Daemon;
}

export function normalizeUrl(listen: string): string | undefined {
  const match = /^(?:ws:\/\/)?([^:/]+|\[[^\]]+\]):(\d+)$/.exec(listen.trim());
  if (!match) return undefined;
  const [, host = '', port = ''] = match;
  const local = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]'].includes(host) ? '127.0.0.1' : host;
  return `ws://${local}:${port}`;
}

/** The whole compatibility story: is Paseo running, and is it new enough? */
export function assessStatus(raw: unknown): DaemonResult {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) {
    return { checks: [fail('paseo.status', 'Paseo status output was not understood.', 'Upgrade Paseo, then run: paseo daemon status --json')] };
  }
  const status = parsed.data;
  if (status.localDaemon !== 'running') {
    return { checks: [fail('paseo.daemon', `Paseo daemon is ${status.localDaemon}.`, 'Start it with: paseo daemon start')] };
  }
  const cli = valid(status.cliVersion);
  const daemon = status.daemonVersion === null ? null : valid(status.daemonVersion);
  if (!cli || !daemon) {
    return { checks: [fail('paseo.version', 'Paseo did not report a usable version.', 'Upgrade Paseo to a release that reports semver versions.')] };
  }
  if (cli !== daemon) {
    return { checks: [fail('paseo.version', `Paseo CLI is ${cli} but the running daemon is ${daemon}.`, 'Restart the daemon with: paseo daemon restart')] };
  }
  if (!gte(daemon, MINIMUM_VERSION)) {
    return { checks: [fail('paseo.version', `Paseo ${daemon} is older than the required ${MINIMUM_VERSION}.`, 'Upgrade Paseo, then run setup again.')] };
  }
  const url = normalizeUrl(status.listen);
  if (!url) {
    return { checks: [fail('paseo.listen', `Paseo listen address ${status.listen} was not understood.`, 'Use a host:port listen address in the Paseo config.')] };
  }
  return { checks: [pass('paseo.version', `Paseo ${daemon} is running on ${url} (compatible, needs >= ${MINIMUM_VERSION}).`)], daemon: { url, version: daemon } };
}

export async function checkDaemon(layout: Layout, env: NodeJS.ProcessEnv = process.env): Promise<DaemonResult> {
  const binary = await which(layout.bin.paseo, env);
  if (!binary) {
    return { checks: [fail('paseo.bin', 'Paseo executable not found.', 'Install Paseo, or pass --paseo-bin /path/to/paseo.')] };
  }
  const output = await probe(binary, ['daemon', 'status', '--json'], {
    HOME: layout.home, PASEO_HOME: layout.paseoHome, PATH: env.PATH ?? '',
    ...(env.PASEO_PASSWORD === undefined ? {} : { PASEO_PASSWORD: env.PASEO_PASSWORD }),
  });
  if (!output.ok) {
    return { checks: [fail('paseo.status', 'Could not read Paseo daemon status.', 'Run: paseo daemon status --json')] };
  }
  try { return assessStatus(JSON.parse(output.stdout)); }
  catch { return assessStatus(undefined); }
}

const configSchema = z.object({ config: z.object({ providers: z.record(z.string(), z.unknown()).optional() }) });

export interface Session {
  readProviders(): Promise<Record<string, unknown>>;
  writeProviders(providers: Readonly<Record<string, Provider>>): Promise<void>;
  removeProviders(ids: readonly string[]): Promise<void>;
  refresh(ids: readonly string[]): Promise<void>;
}
export type ClientFactory = (config: PaseoClientConfig) => PaseoClient;

/** One connection per command. No retries, no reconnects, no background state. */
export async function withSession<T>(
  daemon: Daemon,
  run: (session: Session) => Promise<T>,
  options: { readonly password?: string; readonly factory?: ClientFactory } = {},
): Promise<T> {
  const quiet = { debug() { /* silent */ }, info() { /* silent */ }, warn() { /* silent */ }, error() { /* silent */ } };
  // Loaded here so the "Paseo is not running" path never pays for the SDK.
  const factory = options.factory ?? (await import('@getpaseo/client')).createPaseoClient;
  const client = factory({
    url: `${daemon.url}/ws`,
    ...(options.password === undefined ? {} : { password: options.password }),
    appVersion: MINIMUM_VERSION,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    logger: quiet,
  });
  try {
    await client.connect();
    return await run({
      async readProviders() {
        const response = configSchema.parse(await client.config.get());
        return response.config.providers ?? {};
      },
      async writeProviders(providers) {
        await client.config.patch({ providers } as unknown as Parameters<PaseoClient['config']['patch']>[0]);
      },
      async removeProviders(ids) {
        await client.config.patch({ removeProviders: [...ids] });
      },
      async refresh(ids) {
        await client.providers.refresh({ providers: [...ids] });
      },
    });
  } finally {
    await client.close();
  }
}

/** Compare only the keys the room owns; unrelated fields stay the operator's. */
export function providerMatches(desired: Provider, live: unknown): boolean {
  if (live === null || typeof live !== 'object') return false;
  const entry = live as Record<string, unknown>;
  const env = entry.env;
  const tools = entry.paseoTools;
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return entry.extends === desired.extends &&
    same(entry.command, desired.command) &&
    env !== null && typeof env === 'object' &&
    Object.entries(desired.env).every(([key, value]) => (env as Record<string, unknown>)[key] === value) &&
    tools !== null && typeof tools === 'object' &&
    (tools as { enabled?: unknown }).enabled === desired.paseoTools.enabled &&
    // Pins are the room's guarantee: drifting them silently re-enables what they block.
    same(entry.params, desired.params) &&
    same(entry.disallowedTools, desired.disallowedTools);
}
