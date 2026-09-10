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

/** A throwaway $HOME with a Codex home, a Claude home, and fake executables. */
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

  await script(join(bin, 'paseo'), JSON.stringify(options.paseoStatus ?? RUNNING_STATUS));
  await script(join(bin, 'codex'), JSON.stringify({ models: [{ id: 'gpt-5.6-sol', multi_agent_version: 2 }] }));
  await script(join(bin, 'claude'), '{}');
  return { home, roomHome: join(home, '.paseo-room'), env: { HOME: home, PATH: bin } };
}

// Shell builtins only: the probe runs these with a PATH containing just this bin dir.
async function script(path: string, output: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\necho '${output}'\n`);
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
