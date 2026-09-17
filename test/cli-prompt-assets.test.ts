import { mkdir, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CliContext, Output } from '../src/cli.js';
import type { Prompts } from '../src/wizard.js';
import { emptyDaemon, fakeClient, makeFixture } from './helpers.js';

const promptFs = vi.hoisted(() => ({
  failure: undefined as undefined | 'missing' | 'malformed',
  reads: 0,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: (url: URL): string => {
      if (!url.pathname.includes('/room/prompts/')) return actual.readFileSync(url, 'utf8');
      promptFs.reads += 1;
      if (promptFs.failure === 'missing') throw new Error('ENOENT synthetic missing asset');
      if (promptFs.failure === 'malformed') return '# Wrong heading level\n';
      return actual.readFileSync(url, 'utf8');
    },
  };
});

interface CliRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function runCli(
  argv: readonly string[],
  context: CliContext,
): Promise<CliRun> {
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

function scriptedSetup(): Prompts {
  return {
    select: () => Promise.resolve('setup'),
    multiselect: () => Promise.resolve(['codex']),
    confirm: () => Promise.resolve(false),
  };
}

describe('CLI prompt-asset failure containment', () => {
  it('returns a failed result with reinstall guidance for a missing asset on the flag path', async () => {
    const fixture = await makeFixture();
    promptFs.failure = 'missing';
    promptFs.reads = 0;

    const result = await runCli(['setup'], {
      isTTY: false,
      options: { env: fixture.env, factory: fakeClient(emptyDaemon()) },
    });

    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.out).toContain('documents.workspace');
    expect(result.out).toContain('Reinstall paseo-room');
    expect(result.out).not.toContain('Check that Paseo is running and reachable');
    expect(result.out).toContain('setup: failed');
    expect(promptFs.reads).toBeGreaterThan(0);
  });

  it('returns a failed result with reinstall guidance for a malformed asset on the wizard path', async () => {
    const fixture = await makeFixture();
    promptFs.failure = 'malformed';
    promptFs.reads = 0;

    const result = await runCli([], {
      isTTY: true,
      prompts: scriptedSetup(),
      options: { env: fixture.env, factory: fakeClient(emptyDaemon()) },
    });

    expect(result.code).toBe(1);
    expect(result.err).toBe('');
    expect(result.out).toContain('workspace.topology');
    expect(result.out).toContain('Reinstall paseo-room');
    expect(result.out).not.toContain('Check that Paseo is running and reachable');
    expect(result.out).toContain('setup: failed');
    expect(promptFs.reads).toBeGreaterThan(0);
  });

  it('removes an existing room without reading an unavailable prompt asset', async () => {
    const fixture = await makeFixture();
    await mkdir(fixture.roomHome, { recursive: true });
    await writeFile(`${fixture.roomHome}/room.json`, JSON.stringify({
      version: '0.1.0', agents: ['codex'], roles: ['supervisor', 'lead', 'peer'],
    }));
    promptFs.failure = 'missing';
    promptFs.reads = 0;

    const result = await runCli(['remove', '--apply'], {
      isTTY: false,
      options: { env: fixture.env, factory: fakeClient(emptyDaemon()) },
    });

    expect(result.code).toBe(0);
    expect(result.out).toContain('remove: ok');
    expect(promptFs.reads).toBe(0);
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('retains generic connectivity guidance for unrelated wizard failures', async () => {
    promptFs.failure = undefined;
    promptFs.reads = 0;
    const prompts: Prompts = {
      ...scriptedSetup(),
      select: () => Promise.reject(new Error('synthetic unrelated failure')),
    };

    const result = await runCli([], { isTTY: true, prompts });

    expect(result.code).toBe(1);
    expect(result.out).toContain('synthetic unrelated failure');
    expect(result.out).toContain('Check that Paseo is running and reachable');
    expect(result.out).not.toContain('Reinstall paseo-room');
  });

  it('keeps help, version, and no-command non-TTY parsing behavior', async () => {
    promptFs.failure = 'missing';
    promptFs.reads = 0;
    let promptCalls = 0;
    const prompts: Prompts = {
      ...scriptedSetup(),
      select: () => { promptCalls += 1; return Promise.resolve('setup'); },
    };

    const help = await runCli(['--help'], { isTTY: false, prompts });
    const version = await runCli(['--version'], { isTTY: false, prompts });
    const noCommand = await runCli([], { isTTY: false, prompts });

    expect(help.code).toBe(0);
    expect(help.out).toContain('Usage: paseo-room');
    expect(version.code).toBe(0);
    expect(version.out).toMatch(/^\d+\.\d+\.\d+/m);
    expect(noCommand.code).toBe(2);
    expect(noCommand.err).toContain('no command given');
    expect(promptCalls).toBe(0);
    expect(promptFs.reads).toBe(0);
  });
});
