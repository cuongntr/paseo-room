import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import type { Prompts } from '../src/wizard.js';
import { fakeClient, makeFixture, type FakeDaemon } from './helpers.js';

/** Scripted answers for the no-argument path; a symbol means the user cancelled. */
function scripted(answers: { action: string; agents?: string[]; confirm?: boolean | symbol }): Prompts {
  return {
    select: () => Promise.resolve(answers.action),
    multiselect: () => Promise.resolve((answers.agents ?? ['codex']) as never),
    confirm: () => Promise.resolve(answers.confirm ?? false),
  };
}
async function wizard(prompts: Prompts, env: NodeJS.ProcessEnv, daemon: FakeDaemon): Promise<{ code: number; out: string }> {
  let out = '';
  const code = await runCli([], { stdout: text => { out += text; }, stderr: () => { /* unused */ } }, {
    isTTY: true, prompts, options: { env, factory: fakeClient(daemon) },
  });
  return { code, out };
}

describe('the no-argument wizard', () => {
  it('previews, then applies once confirmed', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = { providers: {}, refreshed: [], connects: 0 };
    const result = await wizard(scripted({ action: 'setup', agents: ['codex'], confirm: true }), fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers)).toHaveLength(3);
    await expect(stat(fixture.roomHome)).resolves.toBeDefined();
  });

  it('changes nothing when the confirmation is declined', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = { providers: {}, refreshed: [], connects: 0 };
    const result = await wizard(scripted({ action: 'setup', confirm: false }), fixture.env, daemon);
    expect(result.out).toContain('Cancelled');
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('treats a cancelled prompt as a no-op', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = { providers: {}, refreshed: [], connects: 0 };
    const cancel = Symbol('cancel');
    const result = await wizard({ ...scripted({ action: 'setup' }), select: () => Promise.resolve(cancel) }, fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Cancelled');
  });
});
