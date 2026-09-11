import { readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { codexAgent, renderCatalog, renderRoleConfig } from '../src/agents/codex.js';
import { applyEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { makeFixture } from './helpers.js';

describe('renderRoleConfig', () => {
  const rendered = renderRoleConfig(parse('model = "gpt-5.6-sol"\napproval_policy = "on-request"\nmodel_instructions_file = "/home/u/.codex/model-instructions.md"\n[mcp_servers.custom]\ncommand = "x"\n'), {
    roleDocument: '# Lead role instructions\n',
  });
  const config = parse(rendered) as Record<string, unknown>;

  it('preserves the operator model and unrelated tables', () => {
    expect(config.model).toBe('gpt-5.6-sol');
    expect(config.mcp_servers).toBeDefined();
  });

  it('overrides only the keys the room owns', () => {
    expect(config.approval_policy).toBe('never');
    expect(config.sandbox_mode).toBe('danger-full-access');
    expect(config.developer_instructions).toContain('Lead role instructions');
    expect((config.agents as { enabled: boolean }).enabled).toBe(false);
  });

  it('never replaces the base prompt: model_instructions_file is left alone', () => {
    expect(config.model_instructions_file).toBe('/home/u/.codex/model-instructions.md');
  });

  it('turns off both native multi-agent flags', () => {
    const features = config.features as { multi_agent: boolean; multi_agent_v2: boolean };
    expect(features.multi_agent).toBe(false);
    expect(features.multi_agent_v2).toBe(false);
  });

  it('keeps a table-shaped multi_agent_v2 as a table', () => {
    const rendered = renderRoleConfig(parse('[features.multi_agent_v2]\nenabled = true\nbeta = "x"\n'), { roleDocument: '# x\n' });
    const features = parse(rendered).features as { multi_agent_v2: { enabled: boolean; beta: string } };
    expect(features.multi_agent_v2).toEqual({ enabled: false, beta: 'x' });
  });
});

describe('renderCatalog', () => {
  it('drops the native multi-agent marker and keeps everything else', () => {
    const catalog = JSON.parse(renderCatalog({ models: [{ id: 'a', multi_agent_version: 3 }] })) as { models: { id: string; multi_agent_version: null }[] };
    expect(catalog.models[0]?.id).toBe('a');
    expect(catalog.models[0]?.multi_agent_version).toBeNull();
  });
});

describe('codexAgent.build', () => {
  it('writes isolated role homes without sharing operator credentials', async () => {
    const fixture = await makeFixture();
    const layout = resolveLayout({}, fixture.env);
    const plan = await codexAgent.build(layout, ['supervisor', 'lead', 'peer']);
    expect(plan.checks.some(check => check.status === 'fail')).toBe(false);
    await applyEntries(plan.entries);

    const lead = join(layout.roomHome, 'roles/codex/lead');
    await expect(stat(join(lead, 'auth.json'))).rejects.toThrow();
    expect(await readFile(join(layout.agentHome.codex, 'auth.json'), 'utf8')).toBe('{"token":"secret"}');
    const config = parse(await readFile(join(lead, 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect(config.developer_instructions).toContain('Lead role instructions');
    // The whole instruction payload rides in this one key, workspace protocol included.
    expect(config.developer_instructions).toContain('## WP-02 Verification');
    expect(await readFile(join(layout.agentHome.codex, 'config.toml'), 'utf8')).not.toContain('danger-full-access');
  });

  // Version managers move the link target on every upgrade; a provider that stored
  // the target would point at a deleted file the next time Codex updates itself.
  it('records the stable launcher path, not the versioned file behind it', async () => {
    const fixture = await makeFixture();
    const bin = join(fixture.home, 'bin');
    await rename(join(bin, 'codex'), join(bin, 'codex-1.2.3'));
    await symlink(join(bin, 'codex-1.2.3'), join(bin, 'codex'));

    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    expect(plan.binary).toBe(join(bin, 'codex'));
  });

  it('probes the shared operator resources once, not once per role', async () => {
    const fixture = await makeFixture();
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['supervisor', 'lead', 'peer']);
    const links = plan.entries.filter(entry => entry.kind === 'link');
    // AGENTS.md and skills exist in the fixture; auth and absent resources are not linked.
    expect(links).toHaveLength(6);
    expect(plan.credentials).toHaveLength(3);
    expect(plan.binary).toContain('codex');
  });

  it('fails with an actionable message when Codex is not installed', async () => {
    const fixture = await makeFixture();
    const plan = await codexAgent.build(resolveLayout({ codexBin: '/nope/codex' }, fixture.env), ['lead']);
    expect(plan.checks[0]?.fix).toContain('--codex-bin');
  });
});

describe('renderRoleConfig with an active profile', () => {
  it('also overrides the profile, which outranks the top-level keys', () => {
    const rendered = renderRoleConfig(parse('profile = "work"\n[profiles.work]\nmodel = "gpt-5.6-sol"\napproval_policy = "untrusted"\n'), {
      roleDocument: '# Peer role instructions\n',
    });
    const config = parse(rendered) as { profiles: { work: Record<string, unknown> } };
    expect(config.profiles.work.approval_policy).toBe('never');
    expect(config.profiles.work.sandbox_mode).toBe('danger-full-access');
    expect(config.profiles.work.model).toBe('gpt-5.6-sol');
  });
});

describe('codexAgent.build failures', () => {
  it('reports unparsable TOML instead of crashing', async () => {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.codex', 'config.toml'), 'model = "unterminated\n');
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    expect(plan.checks[0]?.id).toBe('codex.config');
    expect(plan.entries).toHaveLength(0);
  });
});
