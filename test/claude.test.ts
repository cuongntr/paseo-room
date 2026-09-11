import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAgent, renderRoleMemory, renderRoleSettings, renderRoleState } from '../src/agents/claude.js';
import { applyEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { makeFixture } from './helpers.js';

describe('renderRoleSettings', () => {
  it('keeps operator hooks and env, tags the role, and refuses cross-session input', () => {
    const settings = JSON.parse(renderRoleSettings(JSON.stringify({
      env: {
        FOO: '1',
        CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
        CLAUDE_CODE_DISABLE_WORKFLOWS: '0',
      },
      hooks: { SessionStart: [] },
      crossSessionInbound: 'auto',
      disableAgentView: false,
      disableWorkflows: false,
    }), 'peer')) as {
      env: Record<string, string>; hooks: unknown; crossSessionInbound: string;
      disableAgentView: boolean; disableWorkflows: boolean;
    };
    expect(settings.env.FOO).toBe('1');
    expect(settings.env.PASEO_ROOM_ROLE).toBe('peer');
    expect(settings.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1');
    expect(settings.env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBe('1');
    expect(settings.hooks).toBeDefined();
    expect(settings.crossSessionInbound).toBe('refuse');
    expect(settings.disableAgentView).toBe(true);
    expect(settings.disableWorkflows).toBe(true);
  });

  it('survives a missing or corrupt source', () => {
    expect(JSON.parse(renderRoleSettings(undefined, 'lead'))).toBeTypeOf('object');
    expect(JSON.parse(renderRoleSettings('{not json', 'lead'))).toBeTypeOf('object');
  });
});

describe('renderRoleState', () => {
  it('copies stable onboarding state and personal MCP servers, but not auth or project history', () => {
    const state = JSON.parse(renderRoleState(JSON.stringify({
      theme: 'dark', userID: 'u1', oauthAccount: { email: 'stale@example.test' },
      mcpServers: { personal: { command: 'serve' } }, projects: { a: 1 },
    }))) as Record<string, unknown>;
    expect(state).toMatchObject({
      hasCompletedOnboarding: true, theme: 'dark', userID: 'u1', mcpServers: { personal: { command: 'serve' } },
    });
    expect(state.projects).toBeUndefined();
    expect(state.oauthAccount).toBeUndefined();
  });
});

describe('renderRoleMemory', () => {
  it('keeps the operator global memory and appends the role contract', () => {
    const memory = renderRoleMemory('# Operator preferences\n', 'peer');
    expect(memory).toContain('# Operator preferences');
    expect(memory).toContain('You are Peer');
    expect(memory.indexOf('# Operator preferences')).toBeLessThan(memory.indexOf('You are Peer'));
  });
});

describe('claudeAgent.build', () => {
  it('creates one config dir per role and shares file-backed credentials by link', async () => {
    const fixture = await makeFixture();
    await mkdir(join(fixture.home, '.claude', 'rules'));
    await writeFile(join(fixture.home, '.claude', '.credentials.json'), '{"key":"k"}');
    await writeFile(join(fixture.home, '.claude', 'CLAUDE.md'), '# Keep this preference\n');
    await writeFile(join(fixture.home, '.claude', 'rules', 'operator.md'), '# Keep this rule\n');
    await writeFile(join(fixture.home, '.claude', 'keybindings.json'), '{"bindings":[]}');
    const layout = resolveLayout({}, fixture.env);
    const plan = await claudeAgent.build(layout, ['supervisor', 'lead', 'peer']);
    await applyEntries(plan.entries);

    const peer = join(layout.roomHome, 'roles/claude/peer');
    const memory = await readFile(join(peer, 'CLAUDE.md'), 'utf8');
    expect(memory).toContain('Keep this preference');
    expect(memory).toContain('You are Peer');
    expect(memory).toContain('## WP-02 Verification');
    expect(await readFile(join(peer, '.credentials.json'), 'utf8')).toBe('{"key":"k"}');
    expect(await readFile(join(peer, 'rules/operator.md'), 'utf8')).toBe('# Keep this rule\n');
    expect(await readFile(join(peer, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}');
    expect(plan.binary).toContain('claude');
  });

  it('reads state inside a custom CLAUDE_CONFIG_DIR', async () => {
    const fixture = await makeFixture();
    const customHome = join(fixture.home, 'custom-claude');
    await mkdir(customHome);
    await writeFile(join(customHome, 'settings.json'), '{}');
    await writeFile(join(customHome, '.claude.json'), JSON.stringify({ theme: 'light' }));
    const layout = resolveLayout({ claudeHome: customHome }, fixture.env);
    const plan = await claudeAgent.build(layout, ['lead']);
    await applyEntries(plan.entries);
    const state = JSON.parse(await readFile(join(layout.roomHome, 'roles/claude/lead/.claude.json'), 'utf8')) as {
      theme?: string;
    };
    expect(state.theme).toBe('light');
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
