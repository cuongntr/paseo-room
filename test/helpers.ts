import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaseoClient } from '@getpaseo/client';
import type { ClientFactory } from '../src/paseo.js';

export interface Fixture {
  readonly home: string;
  readonly roomHome: string;
  readonly env: NodeJS.ProcessEnv;
}

export const RUNNING_STATUS = {
  listen: '127.0.0.1:6767', localDaemon: 'running', cliVersion: '0.8.1', daemonVersion: '0.8.1',
};

/** A throwaway $HOME with Codex, Claude, and Pi homes plus fake executables. */
export async function makeFixture(options: { readonly paseoStatus?: unknown } = {}): Promise<Fixture> {
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

  await script(join(bin, 'paseo'), JSON.stringify(options.paseoStatus ?? RUNNING_STATUS));
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

export interface FakeDaemon {
  providers: Record<string, unknown>;
  agentProfiles: Record<string, unknown>[];
  refreshed: string[];
  connects: number;
}
export function emptyDaemon(): FakeDaemon {
  return { providers: {}, agentProfiles: [], refreshed: [], connects: 0 };
}
/** Stands in for the Paseo daemon: config.get/patch over an in-memory object. */
export function fakeClient(state: FakeDaemon): ClientFactory {
  return () => ({
    connect: () => { state.connects += 1; return Promise.resolve(); },
    close: () => Promise.resolve(),
    config: {
      get: () => Promise.resolve({ config: { providers: state.providers, agentProfiles: state.agentProfiles } }),
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
  } as unknown as PaseoClient);
}
