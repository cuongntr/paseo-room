import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { renderInstructions } from '../src/room/instructions.js';
import type { Prompts } from '../src/wizard.js';
import { emptyDaemon, fakeClient, makeFixture, type FakeDaemon } from './helpers.js';

/** Scripted answers for the no-argument path; a symbol means the user cancelled. */
function scripted(answers: {
  action: string; agents?: string[]; confirm?: boolean | symbol; carrier?: string;
}): Prompts {
  let selects = 0;
  return {
    // The action is asked first; a Claude selection then asks for the contract carrier.
    select: () => Promise.resolve(selects++ === 0 ? answers.action : answers.carrier ?? 'both'),
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
    const daemon: FakeDaemon = emptyDaemon();
    const result = await wizard(scripted({ action: 'setup', agents: ['codex'], confirm: true }), fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(Object.keys(daemon.providers)).toHaveLength(3);
    await expect(stat(fixture.roomHome)).resolves.toBeDefined();
  });

  it('asks a Claude selection which contract carriers to use', async () => {
    const fixture = await makeFixture();
    const operatorMemory = '# Operator Claude memory\n';
    await writeFile(join(fixture.home, '.claude/CLAUDE.md'), operatorMemory);
    const daemon: FakeDaemon = emptyDaemon();
    const answers = { action: 'setup', agents: ['claude'], confirm: true, carrier: 'plugin' };
    const result = await wizard(scripted(answers), fixture.env, daemon);
    expect(result.code).toBe(0);
    // Plugin-only: the file keeps the operator's memory and drops the role contract.
    const leadMemory = join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md');
    expect(await readFile(leadMemory, 'utf8')).toBe(operatorMemory);
    expect(result.out).toContain('global memory only');
  });

  it('keeps both carriers when the Claude prompt is answered with the default', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = emptyDaemon();
    const result = await wizard(
      scripted({ action: 'setup', agents: ['claude'], confirm: true, carrier: 'both' }), fixture.env, daemon,
    );
    expect(result.code).toBe(0);
    await expect(readFile(join(fixture.roomHome, 'roles/claude/lead/CLAUDE.md'), 'utf8'))
      .resolves.toContain(renderInstructions('lead'));
    expect(result.out).not.toContain('global memory only');
  });

  it('changes nothing when the confirmation is declined', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = emptyDaemon();
    const result = await wizard(scripted({ action: 'setup', confirm: false }), fixture.env, daemon);
    expect(result.out).toContain('Cancelled');
    expect(daemon.providers).toEqual({});
    await expect(stat(fixture.roomHome)).rejects.toThrow();
  });

  it('treats a cancelled prompt as a no-op', async () => {
    const fixture = await makeFixture();
    const daemon: FakeDaemon = emptyDaemon();
    const cancel = Symbol('cancel');
    const result = await wizard({ ...scripted({ action: 'setup' }), select: () => Promise.resolve(cancel) }, fixture.env, daemon);
    expect(result.code).toBe(0);
    expect(result.out).toContain('Cancelled');
  });
});
