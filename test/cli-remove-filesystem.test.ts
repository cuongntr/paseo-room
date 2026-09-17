import { stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CliContext, Output } from '../src/cli.js';
import { emptyDaemon, fakeClient, makeFixture } from './helpers.js';

const removeFs = vi.hoisted(() => ({
  failingPath: undefined as string | undefined,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      if (removeFs.failingPath !== undefined && String(args[0]) === removeFs.failingPath) {
        throw new Error('synthetic EACCES');
      }
      await actual.rm(...args);
    },
  };
});

async function runCli(argv: readonly string[], context: CliContext): Promise<{
  readonly code: number;
  readonly out: string;
  readonly err: string;
}> {
  vi.resetModules();
  const { runCli: execute } = await import('../src/cli.js');
  let out = '';
  let err = '';
  const output: Output = {
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  };
  const code = await execute(argv, output, context);
  return { code, out, err };
}

describe('remove filesystem failure containment', () => {
  it('reports partial removal accurately instead of blaming Paseo connectivity', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const context = {
      isTTY: false,
      options: { env: fixture.env, factory: fakeClient(daemon) },
    } satisfies CliContext;
    expect((await runCli(['setup', '--apply'], context)).code).toBe(0);

    removeFs.failingPath = fixture.roomHome;
    const removed = await runCli(['remove', '--apply'], context);
    removeFs.failingPath = undefined;

    expect(removed.code).toBe(1);
    expect(removed.err).toBe('');
    expect(removed.out).toContain('Removed 3 Paseo providers and their agent profiles.');
    expect(removed.out).toContain(`could not fully delete ${fixture.roomHome}: synthetic EACCES`);
    expect(removed.out).toContain('Delete that directory manually after reviewing it for role-owned credentials');
    expect(removed.out).toContain(`remove provider codex-lead`);
    expect(removed.out).not.toContain(`remove dir ${fixture.roomHome}`);
    expect(removed.out).not.toContain('Check that Paseo is running and reachable');
    expect(daemon.providers).toEqual({});
    expect(daemon.agentProfiles.filter(profile => String(profile.id).startsWith('room-'))).toEqual([]);
    await expect(stat(fixture.roomHome)).resolves.toBeDefined();
  });
});
