import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/command.js';
import { type LifecycleServices } from '../src/cli/lifecycle.js';
import { type WizardPrompts } from '../src/cli/wizard.js';
import { COMMANDS, type NormalizedIntent } from '../src/core/intent.js';
import { planLifecycle } from '../src/core/planner.js';
import { type CommandResult } from '../src/core/result.js';
import { renderHuman } from '../src/cli/render.js';
import { policyFixture } from './helpers/provider-policy.js';

const cancelled = Symbol('cancel');
function plan(intent: NormalizedIntent): CommandResult {
  const path = intent.roomHome ?? '/fixture/room';
  return planLifecycle({ intent,
    desired: { artifacts: [{ kind: 'directory', path, mode: 0o700 }], providers: policyFixture() },
    current: { paths: [{ path, occupancy: 'absent' }], unfinishedJournal: false,
      paseo: { mode: 'live', admission: 'pass', providers: {}, activeSessions: [], readiness: {} } },
  });
}
function harness(answers: readonly (string | symbol)[] = [], approval: boolean | symbol = false,
  transform: (result: CommandResult) => CommandResult = result => result) {
  let stdout = ''; let stderr = ''; let confirmed = false;
  const plans: CommandResult[] = [];
  const mutate = vi.fn<() => Promise<CommandResult>>(() => {
    expect(confirmed).toBe(true);
    return Promise.resolve({ schemaVersion: 1, command: 'install', outcome: 'ok', changed: true, checks: [], operations: [] } satisfies CommandResult);
  });
  const prepare = vi.fn<LifecycleServices['prepare']>(intent => {
    if (intent.apply) expect(confirmed).toBe(true);
    const result = transform(plan(intent));
    plans.push(result);
    return Promise.resolve({ result, mutate });
  });
  let index = 0;
  const answer = () => {
    expect(prepare).not.toHaveBeenCalled(); expect(mutate).not.toHaveBeenCalled();
    return Promise.resolve(answers[index++] ?? '');
  };
  const text = vi.fn<WizardPrompts['text']>(answer);
  const masked = vi.fn<WizardPrompts['masked']>(answer);
  const confirm = vi.fn<WizardPrompts['confirm']>(options => {
    expect(options.initialValue).toBe(false);
    expect(prepare).toHaveBeenCalledOnce(); expect(mutate).not.toHaveBeenCalled();
    const preview = plans[0];
    if (!preview) throw new Error('Expected a preview before confirmation.');
    expect(stdout).toContain(renderHuman(preview));
    confirmed = approval === true;
    return Promise.resolve(approval);
  });
  const invoke = async (argv: readonly string[] = [], isTTY = true) => {
    const status = await runCli(argv, { stdout: text => { stdout += text; }, stderr: text => { stderr += text; } },
      { prepare }, { isTTY, prompts: { text, masked, confirm } });
    return { status, stdout, stderr };
  };
  return { invoke, text, masked, confirm, prepare, mutate, plans };
}

describe('no-argument simulated TTY wizard', () => {
  it('shows a read-only plan before explicit consent and re-enters the shared lifecycle to apply', async () => {
    const h = harness([], true);
    const response = await h.invoke();
    expect(response.status).toBe(0); expect(response.stderr).toBe('');
    expect(response.stdout).toContain('changed: no'); expect(response.stdout).toContain('changed: yes');
    expect(h.text.mock.calls.map(([options]) => options.key)).toEqual(['roomHome', 'codexHome', 'codexBin', 'paseoBin']);
    expect(h.masked.mock.calls.map(([options]) => options.key)).toEqual(['paseoUrl']);
    expect(h.prepare.mock.calls.map(([intent]) => intent.apply)).toEqual([false, true]);
    expect(h.mutate).toHaveBeenCalledOnce(); expect(h.confirm).toHaveBeenCalledOnce();
  });
  it.each([false, cancelled])('decline/cancel at confirmation is clean no-change: %s', async approval => {
    const h = harness([], approval);
    expect(await h.invoke()).toMatchObject({ status: 0, stderr: '' });
    expect(h.confirm).toHaveBeenCalledOnce(); expect(h.prepare).toHaveBeenCalledOnce();
    expect(h.mutate).not.toHaveBeenCalled();
  });
  it.each([0, 1, 2, 3, 4])('cancels collection at field %s without even preparing', async index => {
    const h = harness([...Array<string>(index).fill(''), cancelled], true);
    expect(await h.invoke()).toMatchObject({ status: 0, stderr: '' });
    expect(h.text).toHaveBeenCalledTimes(Math.min(index + 1, 4));
    expect(h.masked).toHaveBeenCalledTimes(index === 4 ? 1 : 0);
    expect(h.prepare).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
  });
  it.each([
    ['missing prerequisites', 'failed', 1], ['incompatible prerequisites', 'failed', 1],
    ['ownership conflict', 'conflict', 3], ['unfinished journal', 'recovery-required', 4],
  ] as const)('presents %s without confirmation or mutation', async (message, outcome, status) => {
    const h = harness([], true, result => ({ ...result, outcome,
      checks: [{ id: 'fixture.admission', status: 'fail', message, remediation: 'Reconcile explicitly.' }] }));
    const response = await h.invoke();
    expect(response.status).toBe(status); expect(response.stdout).toContain(message);
    expect(response.stdout).toContain('Reconcile explicitly.');
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
  });
  it('does not confirm even a changes-planned result with failed checks', async () => {
    const h = harness([], true, result => ({ ...result, checks: [{ id: 'prerequisite', status: 'fail', message: 'Blocked.' }] }));
    expect((await h.invoke()).status).toBe(1); expect(h.confirm).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
  });
  it('does not confirm an already-current room', async () => {
    const h = harness([], true, result => ({ ...result, outcome: 'ok', operations: [] }));
    expect((await h.invoke()).status).toBe(0); expect(h.confirm).not.toHaveBeenCalled(); expect(h.mutate).not.toHaveBeenCalled();
  });
  it.each([
    { answers: ['', ' ', '', '', ''], flags: [] },
    { answers: ['/fixture/custom-room', '/fixture/codex', '/opt/codex', '/opt/paseo', 'ws://127.0.0.1:6767'],
      flags: ['--room-home', '/fixture/custom-room', '--codex-home', '/fixture/codex', '--codex-bin', '/opt/codex',
        '--paseo-bin', '/opt/paseo', '--paseo-url', 'ws://127.0.0.1:6767'] },
    { answers: [' /fixture/custom-room ', '', '', '', ''], flags: ['--room-home', '/fixture/custom-room'] },
  ])('produces deeply equal flag/wizard intent and real planner output: $flags', async ({ answers, flags }) => {
    const wizard = harness(answers); const flagged = harness();
    expect((await wizard.invoke()).status).toBe(0);
    const response = await flagged.invoke(['install', ...flags]);
    expect(response.status).toBe(0);
    expect(wizard.prepare.mock.calls[0]?.[0]).toEqual(flagged.prepare.mock.calls[0]?.[0]);
    expect(wizard.plans).toEqual(flagged.plans);
    const preview = wizard.plans[0];
    if (!preview) throw new Error('Expected a wizard plan.');
    expect(response.stdout).toBe(renderHuman(preview));
    expect(wizard.mutate).not.toHaveBeenCalled(); expect(flagged.mutate).not.toHaveBeenCalled();
  });
  it.each(COMMANDS)('explicit %s never prompts on a TTY', async command => {
    const h = harness(); await h.invoke([command]);
    expect(h.text).not.toHaveBeenCalled(); expect(h.masked).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each([['--non-interactive'], ['--json'], ['--apply'], ['--room-home', '/fixture/room']])('missing command with %j never prompts', async (...argv) => {
    const h = harness(); expect((await h.invoke(argv)).status).toBe(2);
    expect(h.text).not.toHaveBeenCalled(); expect(h.masked).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });
  it('non-TTY missing command returns usage without waiting for input', async () => {
    const h = harness(); expect((await h.invoke([], false)).status).toBe(2);
    expect(h.text).not.toHaveBeenCalled(); expect(h.masked).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  });
  it('invalid overrides fail without echoing input or offering apply', async () => {
    const h = harness(['', '', '', '', 'ws://user:synthetic-secret@localhost'], true);
    const response = await h.invoke();
    expect(response.status).toBe(1); expect(response.stdout).not.toContain('synthetic-secret');
    expect(h.masked).toHaveBeenCalledOnce(); expect(h.prepare).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  });
  it('propagates transaction recovery outcome after consent, not a clean cancellation', async () => {
    const h = harness([], true);
    h.mutate.mockImplementationOnce(() => Promise.resolve({ schemaVersion: 1, command: 'install', outcome: 'recovery-required',
      changed: true, checks: [], operations: [] }));
    expect((await h.invoke()).status).toBe(4);
    expect(h.confirm).toHaveBeenCalledOnce(); expect(h.mutate).toHaveBeenCalledOnce();
  });
});
