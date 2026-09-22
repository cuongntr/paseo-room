import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { gateEnvironment, maskTail, recoverGate, runGate, type GateEvent, type GateRequest } from '../src/runtime-plugin/server/gate.js';
import { GitEvidence } from '../src/runtime-plugin/server/git.js';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function workspace(): Promise<{ root: string; gates: string; request: (command: string, timeoutSeconds?: number) => GateRequest }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'paseo-room-gate-')));
  const gates = await mkdtemp(join(tmpdir(), 'paseo-room-gates-'));
  roots.push(root, gates);
  const git = (...args: string[]) => exec('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root });
  await git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'README.md'), 'x\n');
  await git('add', '.');
  await git('commit', '-q', '-m', 'base');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();
  let run = 0;
  return {
    root, gates,
    request: (command, timeoutSeconds = 30) => ({
      gateRunId: `gate-${String(++run)}`, assignmentId: 'asg_abcdefgh', command, timeoutSeconds, cwd: root, gitCommonDir: join(root, '.git'),
      candidate: { kind: 'git-commit', commit, baseCommit: commit, changedPaths: [], workspaceId: 'ws1' },
    }),
  };
}

function deps(gates: string, events: GateEvent[], environment: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' }) {
  return { git: new GitEvidence(), gatesDirectory: gates, publish: (event: GateEvent) => { events.push(event); return Promise.resolve(); }, environment, graceMs: 300 };
}

describe('runtime gate runner', () => {
  it('records a passing run with its digest, owner-only tail and sidecar', async () => {
    const { gates, request } = await workspace();
    const events: GateEvent[] = [];
    const outcome = await runGate(request('echo hello; echo world 1>&2'), deps(gates, events));
    expect(outcome.status).toBe('finished');
    if (outcome.status !== 'finished') return;
    expect(outcome.result).toMatchObject({ exitCode: 0, termination: 'exited', timedOut: false, workspaceMoved: false, processContractVersion: 1, environmentPolicyVersion: 1 });
    expect(events.map(event => event.type)).toEqual(['gate.requested', 'gate.finished']);
    const tail = join(gates, 'gate-1.log');
    expect((await readFile(tail, 'utf8')).split('\n').sort()).toEqual(['', 'hello', 'world']);
    expect((await stat(tail)).mode & 0o777).toBe(0o600);
    expect(await recoverGate('gate-1', gates)).toEqual({ status: 'finished', result: outcome.result });
  });

  it('records failures and signals faithfully', async () => {
    const { gates, request } = await workspace();
    const failed = await runGate(request('exit 3'), deps(gates, []));
    expect(failed).toMatchObject({ status: 'finished', result: { exitCode: 3, termination: 'exited' } });
    const signaled = await runGate(request('kill -USR1 $$'), deps(gates, []));
    expect(signaled).toMatchObject({ status: 'finished', result: { signal: 'SIGUSR1', termination: 'signaled' } });
  });

  it('terminates the whole process group on timeout, escalating past SIGTERM', async () => {
    const { gates, request } = await workspace();
    const timed = await runGate(request('sleep 30', 1), deps(gates, []));
    expect(timed).toMatchObject({ status: 'finished', result: { timedOut: true, termination: 'signaled', signal: 'SIGTERM' } });

    const stubborn = await runGate(request("trap '' TERM; (trap '' TERM; sleep 30) & sleep 30", 1), deps(gates, []));
    expect(stubborn).toMatchObject({ status: 'finished', result: { timedOut: true, termination: 'killed' } });
  }, 20_000);

  it('reaps a descendant that outlives the shell before publishing', async () => {
    const { gates, request } = await workspace();
    const started = Date.now();
    const outcome = await runGate(request("(trap '' TERM; sleep 30) & echo done"), deps(gates, []));
    expect(outcome).toMatchObject({ status: 'finished', result: { exitCode: 0 } });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  it('runs with only the versioned minimal environment', async () => {
    const { gates, request } = await workspace();
    const outcome = await runGate(request('env | sort'), deps(gates, [], { PATH: process.env.PATH ?? '/bin', HOME: '/tmp', SECRET_TOKEN: 'hunter2', PASEO_PASSWORD: 'pw', LANG: 'C' }));
    expect(outcome.status).toBe('finished');
    const tail = await readFile(join(gates, 'gate-1.log'), 'utf8');
    expect(tail).not.toContain('hunter2');
    expect(tail).not.toContain('PASEO_PASSWORD');
    expect(tail).toContain('CI=1');
    expect(tail).toContain('PASEO_ROOM_GATE=1');
    expect(Object.keys(gateEnvironment({ PATH: '/bin', SECRET: 'x', LC_ALL: 'C' })).sort()).toEqual(['CI', 'LC_ALL', 'PASEO_ROOM_GATE', 'PATH']);
  });

  it('bounds the tail at 64 KiB while the digest covers every byte', async () => {
    const { gates, request } = await workspace();
    const outcome = await runGate(request("head -c 200000 /dev/zero | tr '\\000' 'a'"), deps(gates, []));
    if (outcome.status !== 'finished') throw new Error('gate did not finish');
    expect(outcome.result.outputDigest).toBe(`sha256:${createHash('sha256').update('a'.repeat(200_000)).digest('hex')}`);
    expect((await readFile(join(gates, 'gate-1.log'))).length).toBe(64 * 1024);
    expect(maskTail('API_TOKEN=abc123 and Bearer xyz.789 ok')).toBe('API_TOKEN=[masked] and Bearer [masked] ok');
  });

  it('detects a workspace the gate itself moved and refuses a workspace off the candidate', async () => {
    const { root, gates, request } = await workspace();
    const moved = await runGate(request('echo changed >> README.md'), deps(gates, []));
    expect(moved).toMatchObject({ status: 'finished', result: { workspaceMoved: true } });
    const events: GateEvent[] = [];
    const refused = await runGate(request('true'), deps(gates, events));
    expect(refused).toMatchObject({ status: 'refused', code: 'workspace-mismatch' });
    expect(events).toEqual([]);
    await writeFile(join(root, 'README.md'), 'x\n');
    expect(await runGate(request('true', 0), deps(gates, []))).toMatchObject({ status: 'refused', code: 'timeout-invalid' });
  });

  it('treats a restart without a sidecar as uncertain and never signals anything', async () => {
    const { gates } = await workspace();
    expect(await recoverGate('gate-lost', gates)).toMatchObject({ status: 'uncertain' });
    await writeFile(join(gates, 'gate-bad.result.json'), '{"id":"gate-bad"}');
    expect(await recoverGate('gate-bad', gates)).toMatchObject({ status: 'uncertain' });
  });
});
