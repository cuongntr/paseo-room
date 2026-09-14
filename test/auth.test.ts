import { EventEmitter } from 'node:events';
import { lstat, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoginSpawner, LoginSpawnOptions } from '../src/auth.js';
import { runCli } from '../src/cli.js';
import { emptyDaemon, fakeClient, makeFixture, script, type FakeDaemon } from './helpers.js';

interface SpawnCall {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly options: LoginSpawnOptions;
}

function fakeSpawner(
  calls: SpawnCall[],
  outcome: { readonly code: number | null; readonly signal: NodeJS.Signals | null } = { code: 0, signal: null },
): LoginSpawner {
  return (executable, argv, options) => {
    calls.push({ executable, argv, options });
    const child = new EventEmitter();
    queueMicrotask(() => { child.emit('close', outcome.code, outcome.signal); });
    return child;
  };
}

async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  daemon: FakeDaemon,
  options: { readonly isTTY?: boolean; readonly spawn?: LoginSpawner } = {},
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  }, {
    isTTY: options.isTTY ?? true,
    options: { env, factory: fakeClient(daemon) },
    ...(options.spawn ? { loginSpawn: options.spawn } : {}),
  });
  return { code, out, err };
}

describe('managed authentication guide', () => {
  it('uses setup-resolved binaries, shell-quotes paths, covers selected roles, and contains no credential contents', async () => {
    const fixture = await makeFixture();
    const roomHome = join(fixture.home, "room home's space");
    const codexBin = join(fixture.home, "bin/codex user's copy");
    await script(codexBin, JSON.stringify({ models: [] }));
    const daemon = emptyDaemon();
    const result = await run([
      'setup', '--room-home', roomHome, '--codex-bin', codexBin, '--apply',
    ], fixture.env, daemon);
    expect(result.code).toBe(0);
    const guide = await readFile(join(roomHome, 'AUTHENTICATION.md'), 'utf8');
    expect(guide).toContain(`CODEX_HOME='${join(roomHome, 'roles/codex/lead').replaceAll("'", `'"'"'`)}'`);
    expect(guide).toContain(`'${codexBin.replaceAll("'", `'"'"'`)}' 'login'`);
    expect(guide.match(/^### (Supervisor|Lead|Peer)$/gm)).toHaveLength(3);
    expect(guide).not.toContain('Claude Code');
    expect(guide).not.toContain('## Pi');
    expect(guide).not.toContain('secret');
    expect((await lstat(join(roomHome, 'AUTHENTICATION.md'))).isFile()).toBe(true);
  });

  it('previews, applies, regenerates, verifies, and remains idempotent through managed-entry conventions', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const guidePath = join(fixture.roomHome, 'AUTHENTICATION.md');
    const preview = await run(['setup'], fixture.env, daemon);
    expect(preview.out).toContain(`create file ${guidePath}`);
    expect(preview.out).toContain('Role authentication was not validated');
    await expect(stat(guidePath)).rejects.toThrow();

    await run(['setup', '--apply'], fixture.env, daemon);
    const initial = await readFile(guidePath, 'utf8');
    const repeated = await run(['setup'], fixture.env, daemon);
    expect(repeated.out).toContain('Everything is already up to date');
    expect(await readFile(guidePath, 'utf8')).toBe(initial);

    await writeFile(guidePath, 'stale\n');
    const verified = await run(['verify'], fixture.env, daemon);
    expect(verified.code).toBe(1);
    expect(verified.out).toContain('Role authentication was not validated');
    expect(verified.out).toContain(guidePath);
    await run(['setup', '--apply'], fixture.env, daemon);
    expect(await readFile(guidePath, 'utf8')).toBe(initial);
  });

  it('includes only selected agents and gives Pi its isolated minimal-login warning', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const setup = await run(['setup', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    const guide = await readFile(join(fixture.roomHome, 'AUTHENTICATION.md'), 'utf8');
    expect(guide).toContain('## Claude Code');
    expect(guide).toContain('## Pi');
    expect(guide).not.toContain('## Codex');
    expect(guide).toContain("'--no-extensions' '--no-approve' '--append-system-prompt' ''");
    expect(guide).toContain(`cd '${join(fixture.roomHome, 'roles/pi/supervisor')}' && PI_CODING_AGENT_DIR=`);
    expect(guide).toContain('Run `/login`, then exit Pi when authentication completes');
    expect(guide).toContain('starts in the role home, not the caller repository');
    expect(guide).toContain('suppresses role-home APPEND_SYSTEM.md discovery');
    expect(guide).toContain('not equivalent to launching the room seat through Paseo');
    expect(setup.out).toContain("'--no-extensions' '--no-approve' '--append-system-prompt' ''");
  });
});

describe('auth login CLI', () => {
  it('rejects unsupported syntax, values, setup flags, and non-interactive use as documented usage failures', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    expect((await run(['auth', 'status', 'codex', 'lead'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'all', 'lead'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'codex', 'worker'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'codex'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'codex', 'lead', '--apply'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'codex', 'lead', '--agent', 'codex'], fixture.env, daemon)).code).toBe(2);
    expect((await run(['auth', 'login', 'codex', 'lead', '--all'], fixture.env, daemon)).code).toBe(2);
    const calls: SpawnCall[] = [];
    const nonTty = await run(['auth', 'login', 'codex', 'lead'], fixture.env, daemon, {
      isTTY: false, spawn: fakeSpawner(calls),
    });
    expect(nonTty.code).toBe(1);
    expect(nonTty.err).toContain('requires interactive stdin, stdout, and stderr terminals');
    expect(calls).toHaveLength(0);
  });

  it('requires a valid room, selected agent, and safely installed role home', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawner(calls);
    const missing = await run(['auth', 'login', 'codex', 'lead'], fixture.env, daemon, { spawn });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('No room found');

    await run(['setup', '--apply'], fixture.env, daemon);
    const unselected = await run(['auth', 'login', 'claude', 'lead'], fixture.env, daemon, { spawn });
    expect(unselected.code).toBe(1);
    expect(unselected.err).toContain('not selected in this room');
    await rm(join(fixture.roomHome, 'roles/codex/lead'), { force: true, recursive: true });
    const absentRole = await run(['auth', 'login', 'codex', 'lead'], fixture.env, daemon, { spawn });
    expect(absentRole.code).toBe(1);
    expect(absentRole.err).toContain('not safely installed');
    expect(calls).toHaveLength(0);
  });

  it('refuses an installed-path symlink rather than launching login through it', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const external = join(fixture.home, 'external-role');
    await mkdir(external);
    const rolePath = join(fixture.roomHome, 'roles/codex/lead');
    await rm(rolePath, { force: true, recursive: true });
    await symlink(external, rolePath);
    const calls: SpawnCall[] = [];
    const result = await run(['auth', 'login', 'codex', 'lead'], fixture.env, daemon, {
      spawn: fakeSpawner(calls),
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('not safely installed');
    expect(calls).toHaveLength(0);
  });

  it('spawns exact Codex, Claude, and Pi argv and role environments with inherited terminal streams', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'codex', '--agent', 'claude', '--agent', 'pi', '--apply'], fixture.env, daemon);
    const calls: SpawnCall[] = [];
    const spawn = fakeSpawner(calls);
    for (const [agent, role] of [['codex', 'lead'], ['claude', 'peer'], ['pi', 'supervisor']] as const) {
      const result = await run(['auth', 'login', agent, role], { ...fixture.env, INHERITED_SENTINEL: 'yes' }, daemon, { spawn });
      expect(result.code).toBe(0);
      if (agent === 'pi') {
        expect(result.out).toContain('Run /login');
        expect(result.out).toContain('minimal interactive Pi login session');
        expect(result.out).toContain('APPEND_SYSTEM.md discovery is suppressed');
        expect(result.out).toContain('not a room-equivalent Paseo launch');
      }
    }
    expect(calls.map(call => [call.executable, call.argv])).toEqual([
      [join(fixture.home, 'bin/codex'), ['login']],
      [join(fixture.home, 'bin/claude'), ['auth', 'login']],
      [join(fixture.home, 'bin/pi'), ['--no-extensions', '--no-approve', '--append-system-prompt', '']],
    ]);
    for (const call of calls) {
      expect(call.options).toMatchObject({ shell: false, stdio: 'inherit' });
      expect(call.options.env.INHERITED_SENTINEL).toBe('yes');
    }
    expect(calls[0]?.options.env.CODEX_HOME).toBe(join(fixture.roomHome, 'roles/codex/lead'));
    expect(calls[1]?.options.env.CLAUDE_CONFIG_DIR).toBe(join(fixture.roomHome, 'roles/claude/peer'));
    expect(calls[1]?.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(join(fixture.roomHome, 'roles/claude/peer'));
    expect(calls[2]?.options.env.PI_CODING_AGENT_DIR).toBe(join(fixture.roomHome, 'roles/pi/supervisor'));
    expect(calls[0]?.options.cwd).toBeUndefined();
    expect(calls[1]?.options.cwd).toBeUndefined();
    expect(calls[2]?.options.cwd).toBe(join(fixture.roomHome, 'roles/pi/supervisor'));
    expect(calls[2]?.argv).not.toContain('--extension');
  });

  it('honors binary overrides without building or probing Pi, and preserves child exit and signal mappings', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--agent', 'pi', '--apply'], fixture.env, daemon);
    await rm(join(fixture.home, '.pi/agent/npm'), { force: true, recursive: true });
    const override = join(fixture.home, 'bin/pi-login-only');
    await script(override, 'unused');

    const exitCalls: SpawnCall[] = [];
    const exited = await run(['auth', 'login', 'pi', 'peer', '--pi-bin', override], fixture.env, daemon, {
      spawn: fakeSpawner(exitCalls, { code: 23, signal: null }),
    });
    expect(exited.code).toBe(23);
    expect(exitCalls[0]?.executable).toBe(override);
    expect(exitCalls[0]?.argv).toEqual(['--no-extensions', '--no-approve', '--append-system-prompt', '']);

    const signalled = await run(['auth', 'login', 'pi', 'peer', '--pi-bin', override], fixture.env, daemon, {
      spawn: fakeSpawner([], { code: null, signal: 'SIGTERM' }),
    });
    expect(signalled.code).toBe(143);
    expect(signalled.err).toContain('signal SIGTERM; returning 143');
  });

  it('maps spawn errors to a check failure without invoking setup', async () => {
    const fixture = await makeFixture();
    const daemon = emptyDaemon();
    await run(['setup', '--apply'], fixture.env, daemon);
    const failing: LoginSpawner = () => {
      const child = new EventEmitter();
      queueMicrotask(() => { child.emit('error', new Error('synthetic spawn failure')); });
      return child;
    };
    const result = await run(['auth', 'login', 'codex', 'lead'], fixture.env, daemon, { spawn: failing });
    expect(result.code).toBe(1);
    expect(result.err).toContain('synthetic spawn failure');
  });
});
