import { describe, expect, it, vi } from 'vitest';
import metadata from '../package.json' with { type: 'json' };
import { runCli } from '../src/cli/command.js';
import { type LifecycleServices } from '../src/cli/lifecycle.js';
import { COMMANDS } from '../src/core/intent.js';
import { commandResultSchema, type CommandResult, OUTCOMES } from '../src/core/result.js';

async function invoke(argv: readonly string[], services?: LifecycleServices) {
  let stdout = ''; let stderr = '';
  const status = await runCli(argv, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } }, services);
  return { status, stdout, stderr };
}
describe('non-interactive lifecycle CLI', () => {
  it.each([['--help'], ['-h']])('shows harmless help for %j', async (...argv) => {
    const response = await invoke(argv);
    expect(response.status).toBe(0); expect(response.stderr).toBe('');
    expect(response.stdout).toContain('Usage: paseo-room');
    expect(response.stdout).toContain('--apply'); expect(response.stdout).not.toContain('--node-bin');
  });
  it.each(['--version', '-V'])('reports version %s', async flag => {
    expect(await invoke([flag])).toEqual({ status: 0, stdout: `${metadata.version}\n`, stderr: '' });
  });
  it.each(COMMANDS)('routes %s read-only and authorizes mutation only explicitly', async command => {
    const result: CommandResult = { schemaVersion: 1, command, outcome: 'changes-planned', changed: false, checks: [], operations: [] };
    const mutate = vi.fn(() => Promise.resolve({ ...result, outcome: 'ok' as const, changed: true }));
    const prepare = vi.fn<LifecycleServices['prepare']>(() => Promise.resolve({ result, mutate }));
    const response = await invoke([command, '--json', '--non-interactive'], { prepare });
    expect(response).toEqual({ status: 0, stdout: `${JSON.stringify(result, null, 2)}\n`, stderr: '' });
    expect(mutate).not.toHaveBeenCalled();
    const applied = await invoke([command, '--apply', '--json'], { prepare });
    if (['install', 'recover', 'uninstall'].includes(command)) {
      expect(applied.status).toBe(0); expect(mutate).toHaveBeenCalledOnce();
    } else { expect(applied.status).toBe(2); expect(mutate).not.toHaveBeenCalled(); }
  });
  it.each(OUTCOMES)('maps %s to exact public exit', async outcome => {
    const result: CommandResult = { schemaVersion: 1, command: 'install', outcome, changed: false, checks: [], operations: [] };
    const response = await invoke(['install', '--json'], { prepare: () => Promise.resolve({ result }) });
    expect(response.status).toBe({ ok: 0, 'changes-planned': 0, conflict: 3, failed: 1, 'recovery-required': 4 }[outcome]);
    expect(commandResultSchema.parse(JSON.parse(response.stdout))).toEqual(result); expect(response.stderr).toBe('');
  });
  it.each([[], ['--unknown'], ['--apply'], ['plan', '--agent', 'pi'], ['plan', 'extra'], ['plan', '--room-home'],
    ['plan', '--node-bin', '/bin/node'], ['plan', '--password', 'synthetic-secret'], ['plan', '--paseo-url', 'ws://remote.example']])(
    'rejects invalid usage without preparing %j', async (...args) => {
      const prepare = vi.fn<LifecycleServices['prepare']>();
      const response = await invoke([...args, '--json'], { prepare });
      expect(response.status).toBe(2); expect(response.stderr).toBe('');
      expect(commandResultSchema.parse(JSON.parse(response.stdout)).outcome).toBe('failed');
      expect(response.stdout).not.toContain('synthetic-secret'); expect(prepare).not.toHaveBeenCalled();
    });
  it('sanitizes unexpected service failures in human and JSON modes', async () => {
    const prepare = (): Promise<never> => Promise.reject(new Error('synthetic-secret\u001b[31m'));
    for (const args of [['plan'], ['plan', '--json']]) {
      const result = await invoke(args, { prepare });
      expect(result.status).toBe(1); expect(result.stdout).not.toContain('synthetic-secret'); expect(result.stdout).not.toContain('\u001b');
    }
  });
});
