import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAgent, renderRoleSettings, renderRoleState } from '../src/agents/claude.js';
import { applyEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { makeFixture } from './helpers.js';

describe('renderRoleSettings', () => {
  it('keeps operator hooks and env, and tags the role', () => {
    const settings = JSON.parse(renderRoleSettings(JSON.stringify({ env: { FOO: '1' }, hooks: { SessionStart: [] } }), 'peer')) as {
      env: Record<string, string>; hooks: unknown;
    };
    expect(settings.env.FOO).toBe('1');
    expect(settings.env.PASEO_ROOM_ROLE).toBe('peer');
    expect(settings.hooks).toBeDefined();
  });

  it('survives a missing or corrupt source', () => {
    expect(JSON.parse(renderRoleSettings(undefined, 'lead'))).toBeTypeOf('object');
    expect(JSON.parse(renderRoleSettings('{not json', 'lead'))).toBeTypeOf('object');
  });
});

describe('renderRoleState', () => {
  it('copies onboarding identity but not project history', () => {
    const state = JSON.parse(renderRoleState(JSON.stringify({ theme: 'dark', userID: 'u1', projects: { a: 1 } }))) as Record<string, unknown>;
    expect(state).toMatchObject({ hasCompletedOnboarding: true, theme: 'dark', userID: 'u1' });
    expect(state.projects).toBeUndefined();
  });
});

describe('claudeAgent.build', () => {
  it('creates one config dir per role and shares credentials by link', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.claude', '.credentials.json'), '{"key":"k"}');
    const layout = resolveLayout({}, fixture.env);
    const plan = await claudeAgent.build(layout, ['supervisor', 'lead', 'peer']);
    await applyEntries(plan.entries);

    const peer = join(layout.roomHome, 'roles/claude/peer');
    expect(await readFile(join(peer, 'CLAUDE.md'), 'utf8')).toContain('You are Peer');
    expect(await readFile(join(peer, '.credentials.json'), 'utf8')).toBe('{"key":"k"}');
    expect(plan.binary).toContain('claude');
  });

  it('leaves role runtime state alone once seeded', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    const plan = await claudeAgent.build(layout, ['lead']);
    await applyEntries(plan.entries);
    const statePath = join(layout.roomHome, 'roles/claude/lead/.claude.json');
    await writeFile(statePath, '{"numStartups":9}');
    await applyEntries(plan.entries);
    expect(await readFile(statePath, 'utf8')).toBe('{"numStartups":9}');
  });
});
