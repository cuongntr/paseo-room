import type { PaseoClient, PaseoClientConfig } from '@getpaseo/client';
import { gte, valid } from 'semver';
import { z } from 'zod';
import type { Layout } from './layout.js';
import { fail, pass, type Check } from './result.js';
import type { Profile, Provider } from './agents/types.js';
import type { AgentId } from './roles.js';
import { probe, which } from './which.js';

export const MINIMUM_VERSION = '0.8.0-beta.1';
export const PI_MINIMUM_VERSION = '0.8.0';

/** Claude and Pi need `0.8.0`; so does the runtime plugin, whose range the caller also checks. */
export function minimumPaseoVersion(agents: readonly AgentId[], runtime = false): string {
  return runtime || agents.includes('pi') || agents.includes('claude') ? PI_MINIMUM_VERSION : MINIMUM_VERSION;
}

/**
 * Read `daemon status --json` for only the four facts compatibility turns on, and read them
 * loosely: this is a CLI's human-facing output, not a versioned protocol type, and it has already
 * changed shape once. `0.8.x` reported `cliVersion`; `0.9.x` dropped it and gained a supervisor
 * `pid` separate from `workerPid`, so the caller supplies the CLI version instead. `localDaemon`
 * is a plain string because its state names are Paseo's to extend — `0.9.x` added `not_ready` —
 * and every name but `running` means the same thing to this tool.
 */
const statusSchema = z.object({
  listen: z.string().min(1),
  localDaemon: z.string().min(1),
  cliVersion: z.string().optional(),
  daemonVersion: z.string().nullish(),
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

/**
 * The whole compatibility story: is Paseo running, and is it new enough? `cliVersion` is the
 * executable's own version, used only when the status output no longer carries one; comparing it
 * to the daemon is what catches an upgraded CLI whose daemon was never restarted.
 */
export function assessStatus(raw: unknown, minimumVersion = MINIMUM_VERSION, cliVersion?: string): DaemonResult {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) {
    return { checks: [fail('paseo.status', 'Paseo status output was not understood.', 'Upgrade Paseo, then run: paseo daemon status --json')] };
  }
  const status = parsed.data;
  if (status.localDaemon !== 'running') {
    return { checks: [fail('paseo.daemon', `Paseo daemon is ${status.localDaemon}.`, 'Start it with: paseo daemon start')] };
  }
  const cli = valid(status.cliVersion ?? cliVersion);
  const daemon = status.daemonVersion == null ? null : valid(status.daemonVersion);
  if (!cli || !daemon) {
    return { checks: [fail('paseo.version', 'Paseo did not report a usable version.', 'Upgrade Paseo to a release that reports semver versions.')] };
  }
  if (cli !== daemon) {
    return { checks: [fail('paseo.version', `Paseo CLI is ${cli} but the running daemon is ${daemon}.`, 'Restart the daemon with: paseo daemon restart')] };
  }
  if (!gte(daemon, minimumVersion)) {
    return { checks: [fail('paseo.version', `Paseo ${daemon} is older than the required ${minimumVersion}.`, 'Upgrade Paseo, then run setup again.')] };
  }
  const url = normalizeUrl(status.listen);
  if (!url) {
    return { checks: [fail('paseo.listen', `Paseo listen address ${status.listen} was not understood.`, 'Use a host:port listen address in the Paseo config.')] };
  }
  return { checks: [pass('paseo.version', `Paseo ${daemon} is running on ${url} (compatible, needs >= ${minimumVersion}).`)], daemon: { url, version: daemon } };
}

export async function checkDaemon(layout: Layout, env: NodeJS.ProcessEnv = process.env, minimumVersion = MINIMUM_VERSION): Promise<DaemonResult> {
  const binary = await which(layout.bin.paseo, layout.searchPath);
  if (!binary) {
    return { checks: [fail('paseo.bin', 'Paseo executable not found.', 'Install Paseo, or pass --paseo-bin /path/to/paseo.')] };
  }
  const output = await probe(binary, ['daemon', 'status', '--json'], {
    HOME: layout.home, PASEO_HOME: layout.paseoHome, PATH: layout.searchPath,
    ...(env.PASEO_PASSWORD === undefined ? {} : { PASEO_PASSWORD: env.PASEO_PASSWORD }),
  });
  if (!output.ok) {
    return { checks: [fail('paseo.status', 'Could not read Paseo daemon status.', 'Run: paseo daemon status --json')] };
  }
  let status: unknown;
  try { status = JSON.parse(output.stdout); }
  catch { return assessStatus(undefined, minimumVersion); }
  // Paseo 0.9 stopped reporting the CLI version in status, so ask the same executable we just
  // ran. Only then: a status that still carries one needs no second process.
  const reported = (status as { cliVersion?: unknown } | null)?.cliVersion;
  if (typeof reported === 'string') return assessStatus(status, minimumVersion);
  const version = await probe(binary, ['--version'], { HOME: layout.home, PATH: layout.searchPath });
  return assessStatus(status, minimumVersion, version.ok ? version.stdout.trim() : undefined);
}

const configSchema = z.object({
  config: z.object({
    providers: z.record(z.string(), z.unknown()).optional(),
    // Read loosely: entries carry operator fields the room neither knows nor touches.
    agentProfiles: z.array(z.record(z.string(), z.unknown())).optional(),
    pluginsEnabled: z.boolean().optional(),
  }),
});
export type LiveProfile = Record<string, unknown>;
export interface LivePlugin {
  readonly id: string;
  readonly path: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly error?: string | undefined;
}

export interface Session {
  readProviders(): Promise<Record<string, unknown>>;
  writeProviders(providers: Readonly<Record<string, Provider>>): Promise<void>;
  removeProviders(ids: readonly string[]): Promise<void>;
  readProfiles(): Promise<readonly LiveProfile[]>;
  /** Paseo has no remove-one call for profiles, so this replaces the whole array. */
  writeProfiles(profiles: readonly LiveProfile[]): Promise<void>;
  pluginsEnabled(): Promise<boolean>;
  listPlugins(): Promise<readonly LivePlugin[]>;
  installPlugin(path: string, id: string): Promise<LivePlugin>;
  reloadPlugin(id: string): Promise<LivePlugin>;
  enablePlugin(id: string): Promise<LivePlugin>;
  removePlugin(id: string): Promise<void>;
  refresh(ids: readonly string[]): Promise<void>;
}
export interface RoomClient extends PaseoClient {
  listPlugins(): Promise<LivePlugin[]>;
  installDirectoryPlugin(path: string, id?: string): Promise<LivePlugin>;
  reloadPlugin(id: string): Promise<LivePlugin>;
  enablePlugin(id: string): Promise<LivePlugin>;
  removePlugin(id: string): Promise<void>;
}
export type ClientFactory = (config: PaseoClientConfig) => RoomClient;

/** One connection per command. No retries, no reconnects, no background state. */
export async function withSession<T>(
  daemon: Daemon,
  run: (session: Session) => Promise<T>,
  options: { readonly password?: string; readonly factory?: ClientFactory } = {},
): Promise<T> {
  const quiet = { debug() { /* silent */ }, info() { /* silent */ }, warn() { /* silent */ }, error() { /* silent */ } };
  // Loaded here so the "Paseo is not running" path never pays for the SDK.
  const clientConfig: PaseoClientConfig = {
    url: `${daemon.url}/ws`,
    ...(options.password === undefined ? {} : { password: options.password }),
    appVersion: MINIMUM_VERSION,
    connectTimeoutMs: 10_000,
    reconnect: { enabled: false },
    logger: quiet,
  };
  let client: RoomClient;
  if (options.factory !== undefined) {
    client = options.factory(clientConfig);
  } else {
    const [{ createPaseoApi }, { DaemonClient }] = await Promise.all([
      import('@getpaseo/client'), import('@getpaseo/client/internal/daemon-client'),
    ]);
    // The public config types `capabilities` as possibly undefined while DaemonClient's does not,
    // so forward it only when present rather than spreading an explicit undefined.
    const { capabilities, ...config } = clientConfig;
    const raw = new DaemonClient({
      ...config, ...(capabilities === undefined ? {} : { capabilities }),
      clientId: `paseo-room-${String(process.pid)}`, clientType: 'cli',
    });
    client = {
      ...createPaseoApi(raw),
      connect: () => raw.connect(), close: () => raw.close(),
      ensureConnected: () => { raw.ensureConnected(); }, getConnectionState: () => raw.getConnectionState(),
      listPlugins: () => raw.listPlugins(),
      installDirectoryPlugin: (path, id) => raw.installDirectoryPlugin(path, id),
      reloadPlugin: id => raw.reloadPlugin(id), enablePlugin: id => raw.enablePlugin(id),
      removePlugin: id => raw.removePlugin(id),
    };
  }
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
      async readProfiles() {
        const response = configSchema.parse(await client.config.get());
        return response.config.agentProfiles ?? [];
      },
      async writeProfiles(profiles) {
        await client.config.patch({ agentProfiles: [...profiles] } as unknown as Parameters<PaseoClient['config']['patch']>[0]);
      },
      async pluginsEnabled() {
        const response = configSchema.parse(await client.config.get());
        return response.config.pluginsEnabled === true;
      },
      async listPlugins() {
        return await client.listPlugins();
      },
      async installPlugin(path, id) {
        return await client.installDirectoryPlugin(path, id);
      },
      async reloadPlugin(id) {
        return await client.reloadPlugin(id);
      },
      async enablePlugin(id) {
        return await client.enablePlugin(id);
      },
      async removePlugin(id) {
        await client.removePlugin(id);
      },
      async refresh(ids) {
        await client.providers.refresh({ providers: [...ids] });
      },
    });
  } finally {
    await client.close();
  }
}

/**
 * The provider environment is written whole by the room, so it is compared whole: an
 * added key can enable exactly what the pins close, and a subset test would call that a
 * match. Unrelated *top-level* provider fields remain the operator's.
 */
function envMatches(live: unknown, desired: Readonly<Record<string, string>>): boolean {
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false;
  const entries = Object.entries(live as Record<string, unknown>);
  return entries.length === Object.keys(desired).length &&
    entries.every(([key, value]) => Object.hasOwn(desired, key) && value === desired[key]);
}

/** Compare only the keys the room owns; unrelated fields stay the operator's. */
export function providerMatches(desired: Provider, live: unknown): boolean {
  if (live === null || typeof live !== 'object') return false;
  const entry = live as Record<string, unknown>;
  const tools = entry.paseoTools;
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  return entry.extends === desired.extends &&
    same(entry.command, desired.command) &&
    envMatches(entry.env, desired.env) &&
    tools !== null && typeof tools === 'object' &&
    (tools as { enabled?: unknown }).enabled === desired.paseoTools.enabled &&
    // Pins are the room's guarantee: drifting them silently re-enables what they block.
    same(entry.params, desired.params) &&
    same(entry.disallowedTools, desired.disallowedTools);
}

/** Compare only the fields the room writes on an update; the rest are the operator's. */
export function profileMatches(desired: Profile, live: unknown): boolean {
  if (live === null || typeof live !== 'object') return false;
  const entry = live as Record<string, unknown>;
  return entry.name === desired.name && entry.icon === desired.icon && entry.color === desired.color &&
    entry.provider === desired.provider && entry.modeId === desired.modeId && entry.notes === desired.notes;
}

/**
 * Paseo stores every profile in one host-wide array, so the room rewrites that array
 * rather than patching an entry. Operator profiles pass through untouched, and so does
 * every field of a room profile that the room does not own.
 */
export function mergeProfiles(
  live: readonly LiveProfile[],
  desired: readonly Profile[],
  drop: readonly string[],
): LiveProfile[] {
  const dropped = new Set(drop);
  const wanted = new Map(desired.map(profile => [profile.id, profile]));
  const seen = new Set<string>();
  const kept = live
    .filter(entry => !dropped.has(String(entry.id)))
    .map(entry => {
      const profile = wanted.get(String(entry.id));
      if (!profile) return entry;
      seen.add(profile.id);
      // Model and thinkingOptionId remain operator choices; the room owns the
      // role's visual identity and its no-prompt launch mode.
      const updated: LiveProfile = {
        ...entry, name: profile.name, icon: profile.icon, color: profile.color,
        provider: profile.provider, notes: profile.notes,
      };
      if (profile.modeId === undefined) delete updated.modeId;
      else updated.modeId = profile.modeId;
      return updated;
    });
  return [...kept, ...desired.filter(profile => !seen.has(profile.id)).map(profile => ({ ...profile }))];
}
