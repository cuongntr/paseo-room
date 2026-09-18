import { lstat, mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { catalogEvidence, codexAgent, renderCatalog, renderRoleConfig } from '../src/agents/codex.js';
import { applyEntries, planEntries } from '../src/fsops.js';
import { resolveLayout } from '../src/layout.js';
import { renderInstructions } from '../src/room/instructions.js';
import { makeFixture, script } from './helpers.js';

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
    const expected = renderInstructions('lead');
    await expect(stat(join(lead, 'auth.json'))).rejects.toThrow();
    expect(await readFile(join(layout.agentHome.codex, 'auth.json'), 'utf8')).toBe('{"token":"secret"}');
    const config = parse(await readFile(join(lead, 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect(config.developer_instructions).toBe(expected);
    // The readable operator copy and the runtime carrier receive the same complete document.
    expect(await readFile(join(lead, 'role-instructions.md'), 'utf8')).toBe(expected);
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
    // Supervisor and Lead alias both; Peer aliases AGENTS.md and projects skills instead.
    expect(links).toHaveLength(5);
    expect(plan.entries.filter(entry => entry.kind === 'managed-dir')).toHaveLength(1);
    expect(plan.credentials).toHaveLength(3);
    expect(plan.binary).toContain('codex');
  });

  it('fails with an actionable message when Codex is not installed', async () => {
    const fixture = await makeFixture();
    const plan = await codexAgent.build(resolveLayout({ codexBin: '/nope/codex' }, fixture.env), ['lead']);
    expect(plan.checks[0]?.fix).toContain('--codex-bin');
  });
});

describe('codexAgent.build resource distribution', () => {
  async function operatorResources(home: string): Promise<void> {
    const codex = join(home, '.codex');
    await mkdir(join(codex, 'skills', 'formatting'), { recursive: true });
    await mkdir(join(codex, 'skills', 'paseo-committee'), { recursive: true });
    await mkdir(join(codex, 'plugins'), { recursive: true });
    await writeFile(join(codex, 'hooks.json'), '{}');
  }

  it('keeps Supervisor and Lead sharing while Peer omits executable resources', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    const plan = await codexAgent.build(layout, ['supervisor', 'lead', 'peer']);
    await applyEntries(plan.entries);

    const operator = join(layout.agentHome.codex);
    for (const role of ['supervisor', 'lead'] as const) {
      const home = join(layout.roomHome, 'roles/codex', role);
      expect(await readlink(join(home, 'skills'))).toBe(join(operator, 'skills'));
      expect(await readlink(join(home, 'plugins'))).toBe(join(operator, 'plugins'));
      expect(await readlink(join(home, 'hooks.json'))).toBe(join(operator, 'hooks.json'));
    }
    const peer = join(layout.roomHome, 'roles/codex/peer');
    await expect(lstat(join(peer, 'plugins'))).rejects.toThrow();
    await expect(lstat(join(peer, 'hooks.json'))).rejects.toThrow();
    // Peer still receives non-executable operator context.
    expect(await readlink(join(peer, 'AGENTS.md'))).toBe(join(operator, 'AGENTS.md'));
  });

  it('projects Peer skills exactly, excluding paseo* orchestration skills', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await codexAgent.build(layout, ['peer'])).entries);

    const skills = join(layout.roomHome, 'roles/codex/peer/skills');
    expect((await lstat(skills)).isSymbolicLink()).toBe(false);
    expect(await readdir(skills)).toEqual(['formatting']);
    expect(await readlink(join(skills, 'formatting')))
      .toBe(join(layout.agentHome.codex, 'skills', 'formatting'));
    // The operator inventory is only read.
    expect((await readdir(join(layout.agentHome.codex, 'skills'))).sort()).toEqual(['formatting', 'paseo-committee']);
  });

  it('drifts and repairs when the operator skill inventory changes', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    await applyEntries((await codexAgent.build(layout, ['peer'])).entries);
    const skills = join(layout.roomHome, 'roles/codex/peer/skills');

    await mkdir(join(layout.agentHome.codex, 'skills', 'reviewing'), { recursive: true });
    const added = await codexAgent.build(layout, ['peer']);
    // An addition is a new declared child; the directory itself holds nothing stale.
    expect((await planEntries(added.entries)).filter(operation => operation.action !== 'noop'))
      .toEqual([{ action: 'create', kind: 'link', target: join(skills, 'reviewing') }]);
    await applyEntries(added.entries);
    expect(await readdir(skills)).toEqual(['formatting', 'reviewing']);

    await rm(join(layout.agentHome.codex, 'skills', 'formatting'), { recursive: true });
    const removed = await codexAgent.build(layout, ['peer']);
    expect((await planEntries(removed.entries)).filter(operation => operation.action !== 'noop'))
      .toEqual([{ action: 'update', kind: 'dir', target: skills }]);
    await applyEntries(removed.entries);
    expect(await readdir(skills)).toEqual(['reviewing']);
  });

  it('migrates a legacy whole-directory Peer skills symlink', async () => {
    const fixture = await makeFixture();
    await operatorResources(fixture.home);
    const layout = resolveLayout({}, fixture.env);
    const peer = join(layout.roomHome, 'roles/codex/peer');
    const operatorSkills = join(layout.agentHome.codex, 'skills');
    await mkdir(peer, { recursive: true });
    await symlink(operatorSkills, join(peer, 'skills'));

    await applyEntries((await codexAgent.build(layout, ['peer'])).entries);
    expect((await lstat(join(peer, 'skills'))).isSymbolicLink()).toBe(false);
    expect(await readdir(join(peer, 'skills'))).toEqual(['formatting']);
    expect((await readdir(operatorSkills)).sort()).toEqual(['formatting', 'paseo-committee']);
  });
});

describe('codexAgent.build MCP conflict detection', () => {
  async function buildWith(servers: string): Promise<Awaited<ReturnType<typeof codexAgent.build>>> {
    const fixture = await makeFixture();
    await writeFile(join(fixture.home, '.codex', 'config.toml'), `model = "gpt-5.6-sol"\n${servers}`);
    return await codexAgent.build(resolveLayout({}, fixture.env), ['supervisor', 'lead', 'peer']);
  }

  it('fails before apply and names the source for a recognizable server', async () => {
    const plan = await buildWith('[mcp_servers.paseo-bridge]\ncommand = "serve"\n');
    const check = plan.checks.find(entry => entry.id === 'codex.mcp');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('config.toml');
    expect(check?.message).toContain('paseo-bridge (server name)');
    expect(plan.entries).toHaveLength(0);
    expect(plan.binary).toBeUndefined();
  });

  it('passes benign operator servers', async () => {
    const plan = await buildWith('[mcp_servers.docs]\ncommand = "uvx"\nargs = ["mcp-server-docs"]\n');
    expect(plan.checks.some(check => check.id === 'codex.mcp')).toBe(false);
    expect(plan.checks.some(check => check.status === 'fail')).toBe(false);
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

  it('pins the catalog and both multi-agent flags in the profile too', () => {
    const rendered = renderRoleConfig(parse('profile = "work"\n[profiles.work]\nmodel_catalog_json = "/home/u/.codex/operator-catalog.json"\n[profiles.work.features]\nmulti_agent = true\nmulti_agent_v2 = true\n'), {
      roleDocument: '# Peer role instructions\n',
      catalogPath: '/room/roles/codex/peer/model-catalog.json',
    });
    const config = parse(rendered) as {
      model_catalog_json: string;
      features: { multi_agent: boolean; multi_agent_v2: boolean };
      profiles: { work: { model_catalog_json: string; features: { multi_agent: boolean; multi_agent_v2: boolean } } };
    };
    expect(config.model_catalog_json).toBe('/room/roles/codex/peer/model-catalog.json');
    expect(config.profiles.work.model_catalog_json).toBe('/room/roles/codex/peer/model-catalog.json');
    expect(config.profiles.work.features.multi_agent).toBe(false);
    expect(config.profiles.work.features.multi_agent_v2).toBe(false);
  });

  it('keeps a table-shaped profile multi_agent_v2 as a table', () => {
    const rendered = renderRoleConfig(parse('profile = "work"\n[profiles.work.features.multi_agent_v2]\nenabled = true\nbeta = "x"\n'), { roleDocument: '# x\n' });
    const config = parse(rendered) as { profiles: { work: { features: { multi_agent_v2: { enabled: boolean; beta: string } } } } };
    expect(config.profiles.work.features.multi_agent_v2).toEqual({ enabled: false, beta: 'x' });
  });

  // Codex profiles have no `[agents]` key, so writing one there would be invented config.
  it('keeps agents.enabled top-level only', () => {
    const rendered = renderRoleConfig(parse('profile = "work"\n[profiles.work]\nmodel = "gpt-5.6-sol"\n'), { roleDocument: '# x\n' });
    const config = parse(rendered) as { agents: { enabled: boolean }; profiles: { work: Record<string, unknown> } };
    expect(config.agents.enabled).toBe(false);
    expect(config.profiles.work.agents).toBeUndefined();
  });

  // A named-but-absent profile must still be closed: Codex creates it from the key.
  it('creates the active profile table when the operator config lacks it', () => {
    const rendered = renderRoleConfig(parse('profile = "work"\n'), { roleDocument: '# x\n', catalogPath: '/room/catalog.json' });
    const config = parse(rendered) as { profiles: { work: { approval_policy: string; features: { multi_agent: boolean } } } };
    expect(config.profiles.work.approval_policy).toBe('never');
    expect(config.profiles.work.features.multi_agent).toBe(false);
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

  // The scrubbed catalog is a required closure layer, so no catalog means no room.
  it('fails closed when the catalog command fails', async () => {
    const fixture = await makeFixture();
    await script(join(fixture.home, 'bin', 'codex'), '{}', 1);
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    const check = plan.checks.find(entry => entry.id === 'codex.catalog');
    expect(check?.status).toBe('fail');
    expect(check?.fix).toContain("'debug' 'models'");
    expect(plan.entries).toHaveLength(0);
    expect(plan.binary).toBeUndefined();
  });

  it('fails closed when the catalog output is not JSON', async () => {
    const fixture = await makeFixture();
    await script(join(fixture.home, 'bin', 'codex'), 'not json at all');
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    const check = plan.checks.find(entry => entry.id === 'codex.catalog');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('not valid JSON');
    expect(plan.entries).toHaveLength(0);
    expect(plan.credentials).toBeUndefined();
  });
});

describe('catalogEvidence', () => {
  it('counts only the marker fields the generated copy removes', () => {
    expect(catalogEvidence({ models: [{ id: 'a', multi_agent_version: 2 }, { id: 'b' }] }))
      .toEqual({ object: true, markers: 1 });
    expect(catalogEvidence({ models: [] })).toEqual({ object: true, markers: 0 });
    // A field named that far down still counts, because the render drops it wherever it is.
    expect(catalogEvidence({ a: { b: { multi_agent_version: 1 } } })).toEqual({ object: true, markers: 1 });
  });

  it('reports valid JSON that is not a catalog object', () => {
    expect(catalogEvidence([{ id: 'a' }]).object).toBe(false);
    expect(catalogEvidence('a string').object).toBe(false);
    expect(catalogEvidence(null).object).toBe(false);
  });
});

describe('codexAgent.build catalog diagnostics', () => {
  it('states that the generated copy replaces the built-in catalog and how many markers it drops', async () => {
    const fixture = await makeFixture();
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    const check = plan.checks.find(entry => entry.id === 'codex.catalog');
    expect(check?.status).toBe('pass');
    expect(check?.message).toContain('1 multi_agent_version field(s) are nulled');
    expect(check?.message).toContain('generated copy in each role home');
  });

  it('says so when the captured catalog declared no marker at all', async () => {
    const fixture = await makeFixture();
    await script(join(fixture.home, 'bin', 'codex'), JSON.stringify({ models: [{ id: 'gpt-5.6-sol' }] }));
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    expect(plan.checks.find(entry => entry.id === 'codex.catalog')?.message)
      .toContain('declared no multi_agent_version field');
  });

  // Valid JSON that Codex cannot load as a catalog is the same closure failure as none.
  it('fails closed on valid JSON that is not a catalog object', async () => {
    const fixture = await makeFixture();
    await script(join(fixture.home, 'bin', 'codex'), '[]');
    const plan = await codexAgent.build(resolveLayout({}, fixture.env), ['lead']);
    const check = plan.checks.find(entry => entry.id === 'codex.catalog');
    expect(check?.status).toBe('fail');
    expect(check?.message).toContain('not a model catalog object');
    expect(plan.entries).toHaveLength(0);
    expect(plan.binary).toBeUndefined();
  });
});
