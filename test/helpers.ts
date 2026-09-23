import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientFactory, RoomClient } from '../src/paseo.js';

export interface Fixture {
  readonly home: string;
  readonly roomHome: string;
  readonly env: NodeJS.ProcessEnv;
}

export const RUNNING_STATUS = {
  listen: '127.0.0.1:6767', localDaemon: 'running', cliVersion: '0.8.1', daemonVersion: '0.8.1',
};

/** Paseo `0.9` dropped `cliVersion` and gained a supervisor `pid` beside the worker's. */
export const RUNNING_STATUS_09 = {
  listen: '127.0.0.1:6767', localDaemon: 'running', daemonVersion: '0.9.1',
  connectedDaemon: 'reachable', pid: 100, workerPid: 101,
};

/** A throwaway $HOME with Codex, Claude, and Pi homes plus fake executables. */
export async function makeFixture(
  options: { readonly paseoStatus?: unknown; readonly paseoCliVersion?: string } = {},
): Promise<Fixture> {
  const home = await mkdtemp(join(tmpdir(), 'paseo-room-'));
  const bin = join(home, 'bin');
  await mkdir(bin, { recursive: true });
  await mkdir(join(home, '.codex', 'skills'), { recursive: true });
  await writeFile(join(home, '.codex', 'config.toml'), 'model = "gpt-5.6-sol"\napproval_policy = "on-request"\n');
  await writeFile(join(home, '.codex', 'auth.json'), '{"token":"secret"}');
  await writeFile(join(home, '.codex', 'AGENTS.md'), '# operator notes\n');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ env: { FOO: '1' }, hooks: { SessionStart: [] } }));
  await writeFile(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', projects: { a: 1 } }));
  const adapterRoot = join(home, '.pi', 'agent', 'npm', 'node_modules', 'pi-mcp-adapter');
  const adapterEntry = join(adapterRoot, 'index.ts');
  await mkdir(join(home, '.pi', 'agent', 'skills'), { recursive: true });
  await mkdir(adapterRoot, { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({
    defaultProvider: 'openai', packages: ['npm:pi-mcp-adapter', 'npm:unrelated'], extensions: ['./extensions/other.ts'],
  }));
  await writeFile(join(home, '.pi', 'agent', 'auth.json'), '{"token":"pi-secret"}');
  await writeFile(join(adapterRoot, 'package.json'), JSON.stringify({
    name: 'pi-mcp-adapter', version: '2.32.1', pi: { extensions: ['./index.ts'] },
  }));
  await writeFile(adapterEntry, 'export default function adapter() {}\n');

  // The real executable answers `--version` with a bare version, and that is the only place a
  // 0.9 CLI still states its own.
  await writeFile(join(bin, 'paseo'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then',
    `  echo '${options.paseoCliVersion ?? '0.8.1'}'`,
    '  exit 0',
    'fi',
    `echo '${JSON.stringify(options.paseoStatus ?? RUNNING_STATUS)}'`,
    '',
  ].join('\n'));
  await chmod(join(bin, 'paseo'), 0o755);
  await script(join(bin, 'codex'), JSON.stringify({ models: [{ id: 'gpt-5.6-sol', multi_agent_version: 2 }] }));
  await script(join(bin, 'claude'), '{}');
  await script(join(bin, 'pi'), [
    JSON.stringify({ type: 'extension_ui_request', id: 'ui', method: 'setStatus' }),
    JSON.stringify({
      id: 'paseo-room-pi-mcp-probe', type: 'response', command: 'get_commands', success: true,
      data: { commands: [{ name: 'mcp', source: 'extension', sourceInfo: { path: adapterEntry } }] },
    }),
  ].join('\n'));
  return { home, roomHome: join(home, '.paseo-room'), env: { HOME: home, PATH: bin } };
}

// Shell builtins only: the probe runs these with a PATH containing just this bin dir.
export async function script(path: string, output: string, exit = 0): Promise<void> {
  await writeFile(path, `#!/bin/sh\necho '${output}'\n${exit === 0 ? '' : `exit ${String(exit)}\n`}`);
  await chmod(path, 0o755);
}

export async function nodeScript(path: string, source: string): Promise<void> {
  await writeFile(path, `#!${process.execPath}\n${source}\n`);
  await chmod(path, 0o755);
}

export interface FakePlugin {
  id: string;
  path: string;
  enabled: boolean;
  status: string;
  error?: string;
}
export interface FakeDaemon {
  providers: Record<string, unknown>;
  agentProfiles: Record<string, unknown>[];
  refreshed: string[];
  connects: number;
  pluginsEnabled?: boolean;
  plugins?: FakePlugin[];
  pluginReloads?: number;
  pluginLists?: number;
  /** One-shot fault seam for recovery tests after a command has already connected. */
  failNextConfigGet?: boolean;
  failNextPluginRemove?: boolean;
}
export function emptyDaemon(): FakeDaemon {
  return { providers: {}, agentProfiles: [], refreshed: [], connects: 0, pluginsEnabled: true, plugins: [], pluginReloads: 0, pluginLists: 0 };
}
/** Stands in for the Paseo daemon: config.get/patch over an in-memory object. */
export function fakeClient(state: FakeDaemon): ClientFactory {
  return () => ({
    connect: () => { state.connects += 1; return Promise.resolve(); },
    close: () => Promise.resolve(),
    config: {
      get: () => {
        if (state.failNextConfigGet === true) {
          state.failNextConfigGet = false;
          return Promise.reject(new Error('synthetic config read failure'));
        }
        return Promise.resolve({ config: {
          providers: state.providers,
          agentProfiles: state.agentProfiles,
          pluginsEnabled: state.pluginsEnabled ?? true,
        } });
      },
      patch: (patch: { providers?: Record<string, unknown>; removeProviders?: string[]; agentProfiles?: Record<string, unknown>[] }) => {
        if (patch.providers) Object.assign(state.providers, patch.providers);
        const removed = new Set(patch.removeProviders ?? []);
        state.providers = Object.fromEntries(Object.entries(state.providers).filter(([id]) => !removed.has(id)));
        // Paseo replaces the whole array, so the fake must too or a drop would never stick.
        if (patch.agentProfiles) state.agentProfiles = patch.agentProfiles;
        return Promise.resolve({ config: { providers: state.providers, agentProfiles: state.agentProfiles } });
      },
    },
    providers: {
      refresh: (options: { providers: string[] }) => { state.refreshed = options.providers; return Promise.resolve({ acknowledged: true }); },
    },
    listPlugins: () => {
      state.pluginLists = (state.pluginLists ?? 0) + 1;
      return Promise.resolve(state.plugins ?? []);
    },
    installDirectoryPlugin: (path: string, id?: string) => {
      const plugin: FakePlugin = { id: id ?? 'paseo-room-claude-carrier', path, enabled: true, status: 'running' };
      state.plugins = [...(state.plugins ?? []).filter(entry => entry.id !== plugin.id), plugin];
      return Promise.resolve(plugin);
    },
    reloadPlugin: (id: string) => {
      state.pluginReloads = (state.pluginReloads ?? 0) + 1;
      const plugin = (state.plugins ?? []).find(entry => entry.id === id);
      if (!plugin) return Promise.reject(new Error(`missing plugin ${id}`));
      delete plugin.error;
      plugin.enabled = true;
      plugin.status = 'running';
      return Promise.resolve(plugin);
    },
    enablePlugin: (id: string) => {
      const plugin = (state.plugins ?? []).find(entry => entry.id === id);
      if (!plugin) return Promise.reject(new Error(`missing plugin ${id}`));
      plugin.enabled = true;
      plugin.status = 'running';
      return Promise.resolve(plugin);
    },
    removePlugin: (id: string) => {
      if (state.failNextPluginRemove === true) {
        state.failNextPluginRemove = false;
        return Promise.reject(new Error('synthetic plugin remove failure'));
      }
      state.plugins = (state.plugins ?? []).filter(entry => entry.id !== id);
      return Promise.resolve();
    },
  } as unknown as RoomClient);
}
