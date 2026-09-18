import { lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeAgent, renderRoleMemory, renderRoleSettings, renderRoleState } from '../src/agents/claude.js';
import { applyEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { renderInstructions } from '../src/room/instructions.js';
import { makeFixture } from './helpers.js';

describe('renderRoleSettings', () => {
  it('keeps operator hooks and env, tags the role, and refuses cross-session input', () => {
    const settings = JSON.parse(renderRoleSettings(JSON.stringify({
      env: {
        FOO: '1',
        CLAUDE_CODE_DISABLE_AGENT_VIEW: '0',
        CLAUDE_CODE_DISABLE_WORKFLOWS: '0',
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '/operator/shared-auth',
      },
      hooks: { SessionStart: [] },
      crossSessionInbound: 'auto',
      disableAgentView: false,
      disableWorkflows: false,
    }), 'peer', '/room/roles/claude/peer')) as {
      env: Record<string, string>; hooks: unknown; crossSessionInbound: string;
      disableAgentView: boolean; disableWorkflows: boolean;
    };
    expect(settings.env.FOO).toBe('1');
    expect(settings.env.PASEO_ROOM_ROLE).toBe('peer');
    expect(settings.env.CLAUDE_CODE_DISABLE_AGENT_VIEW).toBe('1');
    expect(settings.env.CLAUDE_CODE_DISABLE_WORKFLOWS).toBe('1');
    expect(settings.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/room/roles/claude/peer');
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
  it('keeps the operator global memory before the exact role contract', () => {
    const operator = '# Operator preferences\n';
    const expected = renderInstructions('peer');
    expect(renderRoleMemory(operator, 'peer')).toBe(`# Operator preferences\n\n${expected}`);
    expect(renderRoleMemory(undefined, 'peer')).toBe(expected);
  });

  it('drops only the contract when suppressed, and writes nothing without operator memory', () => {
    const operator = '# Operator preferences\n';
    // The operator's own memory survives; the role contract is what the plugin then carries alone.
    expect(renderRoleMemory(operator, 'peer', false)).toBe('# Operator preferences\n');
    expect(renderRoleMemory(operator, 'peer', false)).not.toContain(renderInstructions('peer'));
    // No operator memory and no contract leaves nothing worth writing.
    expect(renderRoleMemory(undefined, 'peer', false)).toBeUndefined();
    expect(renderRoleMemory('   \n', 'peer', false)).toBeUndefined();
  });
});

describe('claudeAgent.build', () => {
  it('creates one config dir per role without sharing file-backed credentials', async () => {
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
    expect(memory).toBe(`# Keep this preference\n\n${renderInstructions('peer')}`);
    await expect(readFile(join(peer, '.credentials.json'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(layout.agentHome.claude, '.credentials.json'), 'utf8')).toBe('{"key":"k"}');
    expect(await readFile(join(peer, 'rules/operator.md'), 'utf8')).toBe('# Keep this rule\n');
    expect(await readFile(join(peer, 'keybindings.json'), 'utf8')).toBe('{"bindings":[]}');
    expect(plan.binary).toContain('claude');
    expect(plan.credentials).toHaveLength(3);
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

describe('claudeAgent.build resource distribution', () => {
  async function operatorResources(home: string): Promise<void> {
    const claude = join(home, '.claude');
    await mkdir(join(claude, 'skills', 'formatting'), { recursive: true });
    await mkdir(join(claude, 'skills', 'paseo-handoff'), { recursive: true });
    await mkdir(join(claude, 'plugins'), { recursive: true });
    await mkdir(join(claude, 'commands'), { recursive: true });
    await mkdir(join(claude, 'hooks'), { recursive: true });
    await mkdir(join(claude, 'rules'), { recursive: true });
  }

  it('keeps Supervisor and Lead sharing while Peer omits plugins, commands, and hooks', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await claudeAgent.build(layout, ['supervisor', 'lead', 'peer'])).entries);

    const operator = layout.agentHome.claude;
    for (const role of ['supervisor', 'lead'] as const) {
      const home = join(layout.roomHome, 'roles/claude', role);
      for (const name of ['skills', 'plugins', 'commands', 'hooks', 'rules']) {
        expect(await readlink(join(home, name))).toBe(join(operator, name));
      }
    }
    const peer = join(layout.roomHome, 'roles/claude/peer');
    for (const name of ['plugins', 'commands', 'hooks']) {
      await expect(lstat(join(peer, name))).rejects.toThrow();
    }
    // Non-executable operator content still reaches Peer as one shared alias.
    expect(await readlink(join(peer, 'rules'))).toBe(join(operator, 'rules'));
  });

  it('projects Peer skills exactly, excluding paseo* orchestration skills', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);

    const skills = join(layout.roomHome, 'roles/claude/peer/skills');
    expect((await lstat(skills)).isSymbolicLink()).toBe(false);
    expect(await readdir(skills)).toEqual(['formatting']);
    expect((await readdir(join(layout.agentHome.claude, 'skills'))).sort()).toEqual(['formatting', 'paseo-handoff']);
  });

  it('never projects or reconciles the runtime skill bucket Claude owns', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    // Claude's own runtime writes `synced` into whichever home it runs with, operator or role.
    await mkdir(join(fixture.home, '.claude/skills/synced/bucket'), { recursive: true });
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);

    const skills = join(layout.roomHome, 'roles/claude/peer/skills');
    // Not aliased: a link here would point the role's runtime state at the operator's.
    expect(await readdir(skills)).toEqual(['formatting']);

    // Once Claude has written its own bucket in the role home, a rerun must leave it intact
    // rather than treating it as a stale child of an exactly owned directory.
    const runtime = join(skills, 'synced');
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, 'manifest.json'), '{"skills":[]}');
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);
    expect(await readFile(join(runtime, 'manifest.json'), 'utf8')).toBe('{"skills":[]}');
    expect((await readdir(skills)).sort()).toEqual(['formatting', 'synced']);
  });
});

describe('claudeAgent.build MCP conflict detection', () => {
  it('fails before apply for a recognizable server in operator state', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true,
      mcpServers: { bridge: { command: 'npx', args: ['-y', 'paseo-mcp'] } },
    }));
    const plan = await claudeAgent.build(resolveLayout({}, fixture.env), ['supervisor', 'lead', 'peer']);
    const check = plan.checks.find(entry => entry.id === 'claude.mcp');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('bridge (args: paseo-mcp)');
    expect(plan.entries).toHaveLength(0);
    expect(plan.binary).toBeUndefined();
  });

  it('fails for an existing role-owned .claude.json and inspects that key only', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);
    const statePath = join(layout.roomHome, 'roles/claude/peer/.claude.json');
    await writeFile(statePath, JSON.stringify({
      numStartups: 9,
      oauthAccount: { email: 'operator@example.test' },
      mcpServers: { local: { url: 'http://127.0.0.1:6767/paseo' } },
    }));

    const plan = await claudeAgent.build(layout, ['peer']);
    const check = plan.checks.find(entry => entry.id === 'claude.mcp.peer');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain(statePath);
    expect(check?.message).toContain('local (url: http://127.0.0.1:6767/paseo)');
    expect(check?.message).not.toContain('operator@example.test');
    expect(plan.entries).toHaveLength(0);
    // Runtime-owned state is never rewritten by the check.
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toMatchObject({ numStartups: 9 });
  });

  it('passes benign operator and role MCP declarations', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { docs: { command: 'uvx', args: ['mcp-server-docs'] } },
    }));
    const layout = resolveLayout({}, fixture.env);
    const plan = await claudeAgent.build(layout, ['peer']);
    expect(plan.checks.some(check => check.status === 'fail')).toBe(false);
    await applyEntries(plan.entries);
    const state = JSON.parse(await readFile(join(layout.roomHome, 'roles/claude/peer/.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(state.mcpServers).toEqual({ docs: { command: 'uvx', args: ['mcp-server-docs'] } });
    expect((await claudeAgent.build(layout, ['peer'])).checks.some(check => check.status === 'fail')).toBe(false);
  });

  it('fails when operator or role state cannot be read or parsed for MCP inspection', async () => {
    const operatorFixture = await makeFixture();
    await rm(join(operatorFixture.home, '.claude.json'));
    await mkdir(join(operatorFixture.home, '.claude.json'));
    const operatorPlan = await claudeAgent.build(resolveLayout({}, operatorFixture.env), ['peer']);
    expect(operatorPlan.checks.find(check => check.id === 'claude.mcp')).toMatchObject({ status: 'fail' });
    expect(operatorPlan.entries).toHaveLength(0);

    const malformedFixture = await makeFixture();
    await writeFile(join(malformedFixture.home, '.claude.json'), '{not json');
    const malformedPlan = await claudeAgent.build(resolveLayout({}, malformedFixture.env), ['peer']);
    expect(malformedPlan.checks.find(check => check.id === 'claude.mcp')).toMatchObject({ status: 'fail' });
    expect(malformedPlan.entries).toHaveLength(0);

    const roleFixture = await makeFixture();
    const layout = resolveLayout({}, roleFixture.env);
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);
    const roleState = join(layout.roomHome, 'roles/claude/peer/.claude.json');
    await rm(roleState);
    await mkdir(roleState);
    const rolePlan = await claudeAgent.build(layout, ['peer']);
    expect(rolePlan.checks.find(check => check.id === 'claude.mcp.peer')).toMatchObject({ status: 'fail' });
    expect(rolePlan.entries).toHaveLength(0);
  });
});

describe('claudeAgent.build MCP name drift', () => {
  it('warns when an already-seeded role home no longer matches the operator MCP names, and changes nothing', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { docs: { command: 'uvx' } },
    }));
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);

    // The operator adds a server and the runtime records its own state afterwards.
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { docs: { command: 'uvx' }, sql: { command: 'sqlx' } },
    }));
    const statePath = join(layout.roomHome, 'roles/claude/peer/.claude.json');
    const roleState = {
      hasCompletedOnboarding: true, numStartups: 12,
      oauthAccount: { email: 'operator@example.test' },
      mcpServers: { docs: { command: 'uvx' }, legacy: { command: 'old' } },
    };
    await writeFile(statePath, JSON.stringify(roleState));
    const before = await readFile(statePath, 'utf8');

    const plan = await claudeAgent.build(layout, ['peer']);
    const check = plan.checks.find(entry => entry.id === 'claude.mcp.drift.peer');
    expect(check?.status).toBe('warn');
    expect(check?.message).toContain('not declared for this role: sql');
    expect(check?.message).toContain('declared only for this role: legacy');
    expect(check?.message).toContain('only server names were compared');
    expect(check?.message).toContain(statePath);
    // No credential or history content reaches the diagnostic.
    expect(check?.message).not.toContain('operator@example.test');
    expect(check?.message).not.toContain('sqlx');
    expect(check?.fix).toContain('claude mcp add');
    expect(plan.checks.some(entry => entry.status === 'fail')).toBe(false);

    // Seed-once state stays byte-identical, before and after applying the plan.
    expect(await readFile(statePath, 'utf8')).toBe(before);
    await applyEntries(plan.entries);
    expect(await readFile(statePath, 'utf8')).toBe(before);
  });

  it('stays quiet for a matching role home and for one that has not been seeded yet', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { docs: { command: 'uvx' } },
    }));
    // Nothing seeded yet: there is no divergence to report about a file about to be written.
    const first = await claudeAgent.build(layout, ['supervisor', 'lead', 'peer']);
    expect(first.checks.some(entry => entry.id.startsWith('claude.mcp.drift.'))).toBe(false);
    await applyEntries(first.entries);
    const second = await claudeAgent.build(layout, ['supervisor', 'lead', 'peer']);
    expect(second.checks.some(entry => entry.id.startsWith('claude.mcp.drift.'))).toBe(false);
  });

  // Fail before warn: a recognizable Paseo server must not arrive behind a drift warning.
  it('reports the hard conflict alone when both conditions hold', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await claudeAgent.build(layout, ['peer'])).entries);
    await writeFile(join(fixture.home, '.claude.json'), JSON.stringify({
      hasCompletedOnboarding: true, mcpServers: { docs: { command: 'uvx' } },
    }));
    await writeFile(join(layout.roomHome, 'roles/claude/peer/.claude.json'), JSON.stringify({
      mcpServers: { bridge: { command: 'paseo-mcp' } },
    }));
    const plan = await claudeAgent.build(layout, ['peer']);
    expect(plan.checks.find(entry => entry.id === 'claude.mcp.peer')?.status).toBe('fail');
    expect(plan.checks.some(entry => entry.id.startsWith('claude.mcp.drift.'))).toBe(false);
    expect(plan.entries).toHaveLength(0);
  });
});
