import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'smol-toml';
import type { ArtifactSpec, BuildArtifactsInput } from '../src/adapters/contract.js';
import type { ReadonlyFileSystem } from '../src/core/seams.js';
import type { CodexDiscovery } from '../src/adapters/codex/discover.js';
import { createCodexAdapter } from '../src/adapters/codex/index.js';
import { renderModelCatalog, renderRoleConfig } from '../src/adapters/codex/config-codec.js';
import { CATALOG_NAME } from '../src/adapters/codex/runtime.js';
import { ROOM_ROLES, ROLE_PASEO_TOOLS } from '../src/room/roles.js';
import { renderDeveloperInstructions, renderModelInstructions, renderWorkspaceProtocol } from '../src/room/instructions/index.js';
import { gateway } from './fakes/contracts.js';

const roots: string[] = [];
const reads: string[] = [];
const filesystem: ReadonlyFileSystem = {
  async lstat(path) {
    const stat = await fs.lstat(path).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    return stat && { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      mode: stat.mode, device: stat.dev, inode: stat.ino, links: stat.nlink, uid: stat.uid };
  },
  realpath: fs.realpath, readlink: fs.readlink, readdir: fs.readdir,
  readFile(path) {
    if (path.endsWith('/auth.json')) throw new Error('Credential reads forbidden');
    reads.push(path); return fs.readFile(path);
  },
};
const adapter = createCodexAdapter(filesystem);
const catalog = { models: [{ slug: 'gpt-5.6-sol', multi_agent_version: 'v2', limits: [1, 2], enabled: true },
  { slug: 'other', multi_agent_version: null }], extra: { multi_agent_version: 9, nested: [{ multi_agent_version: false, untouched: 'value' }] } };
const source = `# canonical comments must survive unchanged\nmodel = "operator-model"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
approval_policy = "on-request"
approvals_reviewer = "user"
model_instructions_file = "/old/instructions"
developer_instructions = "old role"
model_catalog_json = "/old/catalog"
[agents]
enabled = true
max_threads = 6
[features]
multi_agent = true
other_feature = true
[features.multi_agent_v2]
enabled = true
extra = "preserved"
[mcp_servers.example]
command = "operator-tool"
args = ["--flag", "with spaces"]
[profiles.operator]
model = "unrelated-profile"
`;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); reads.length = 0; });
async function fixture(hooks = true): Promise<BuildArtifactsInput<CodexDiscovery>> {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codex runtime '))); roots.push(root);
  const canonicalHome = join(root, 'canonical'); const roomHome = join(root, 'room home');
  await fs.mkdir(canonicalHome);
  const sharedTargets: Record<string, string> = {};
  for (const name of ['auth.json', 'AGENTS.md', 'skills', 'plugins', ...(hooks ? ['hooks.json'] : [])]) {
    const path = join(canonicalHome, name);
    if (name === 'skills' || name === 'plugins') await fs.mkdir(path);
    else await fs.writeFile(path, name === 'auth.json' ? '' : 'operator-owned reference');
    sharedTargets[name] = path;
  }
  await fs.writeFile(join(canonicalHome, 'config.toml'), source);
  return { roomHome, roleHomes: { supervisor: join(roomHome, 'roles/codex/supervisor'), lead: join(roomHome, 'roles/codex/lead'), peer: join(roomHome, 'roles/codex/peer') },
    discovery: { canonicalHome, roomHome, configPath: join(canonicalHome, 'config.toml'), launchPrefix: ['/persistent/node', '/persistent/codex.js'], version: '0.114.0', modelCatalog: structuredClone(catalog), sharedTargets } };
}
async function snapshot(path: string): Promise<unknown> {
  const entries: unknown[] = [];
  for (const name of (await fs.readdir(path)).sort()) {
    const child = join(path, name); const stat = await fs.lstat(child);
    entries.push([name, stat.mode, stat.ino, stat.nlink, stat.size, stat.mtimeMs,
      stat.isSymbolicLink() ? await fs.readlink(child) : stat.isDirectory() ? await snapshot(child) :
        name === 'auth.json' ? 'metadata-only' : createHash('sha256').update(await fs.readFile(child)).digest('hex')]);
  }
  return entries;
}
async function publish(artifacts: ArtifactSpec[]) {
  for (const artifact of artifacts) {
    if (artifact.kind === 'directory') await fs.mkdir(artifact.path, { mode: artifact.mode });
    else if (artifact.kind === 'file') await fs.writeFile(artifact.path, artifact.content, { mode: artifact.mode });
    else await fs.symlink(artifact.target, artifact.path);
  }
}
function verification(input: BuildArtifactsInput<CodexDiscovery>, fsPort = filesystem) {
  return adapter.verifyRuntime({ ...input, filesystem: fsPort, process: { run: vi.fn(() => { throw new Error('Process must not be called'); }) }, gateway: {
    snapshot: vi.fn(() => { throw new Error('Paseo must not be called'); }), close: () => gateway.close(),
  } });
}

describe('Codex artifact declarations', () => {
  it.each([true, false])('renders all role overlays, isolated homes, and only approved links (hooks=%s)', async hooks => {
    const input = await fixture(hooks); const before = await snapshot(input.discovery.canonicalHome);
    const artifacts = await adapter.buildArtifacts(input);
    expect(await filesystem.lstat(input.roomHome)).toBeNull();
    expect(new Set(artifacts.map(a => a.path)).size).toBe(artifacts.length);
    expect(artifacts.filter(a => a.kind === 'directory')).toHaveLength(7);
    expect(artifacts.find(a => a.path === join(input.roomHome, 'room/model-instructions.md'))).toMatchObject({ kind: 'file', mode: 0o600, content: renderModelInstructions() });
    expect(artifacts.find(a => a.path === join(input.roomHome, 'room/workspace-protocol.md'))).toMatchObject({ kind: 'file', mode: 0o600, content: renderWorkspaceProtocol() });
    for (const role of ROOM_ROLES) {
      const config = artifacts.find(a => a.path === join(input.roleHomes[role], 'config.toml'));
      expect(config?.kind).toBe('file'); if (config?.kind !== 'file') throw new Error('Missing config');
      expect(parse(config.content)).toEqual({ ...parse(source), model: 'gpt-5.6-sol', model_reasoning_effort: 'medium',
        sandbox_mode: 'danger-full-access', approval_policy: 'never',
        model_instructions_file: join(input.roomHome, 'room/model-instructions.md'), developer_instructions: renderDeveloperInstructions(role),
        model_catalog_json: join(input.roleHomes[role], CATALOG_NAME), agents: { enabled: false, max_threads: 6 },
        features: { multi_agent: false, other_feature: true, multi_agent_v2: { enabled: false, extra: 'preserved' } } });
      const links = artifacts.filter(a => a.kind === 'symlink' && a.path.startsWith(input.roleHomes[role] + '/'));
      expect(links).toEqual(Object.entries(input.discovery.sharedTargets).map(([name, target]) => ({ kind: 'symlink', path: join(input.roleHomes[role], name), target })));
      expect(adapter.buildProvider(role, input)).toEqual({ extends: 'codex', label: `Codex ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
        command: ['/persistent/node', '/persistent/codex.js'], env: { CODEX_HOME: input.roleHomes[role] }, paseoTools: { enabled: ROLE_PASEO_TOOLS[role] } });
    }
    await publish(artifacts);
    await fs.writeFile(join(input.roleHomes.peer, 'mutable-state'), 'not managed');
    expect((await verification(input)).every(c => c.status === 'pass')).toBe(true);
    expect(await snapshot(input.discovery.canonicalHome)).toEqual(before);
    expect(reads.every(path => !path.endsWith('/auth.json'))).toBe(true);
  });
  it.each(['multi_agent_v2 = true', 'multi_agent_v2 = false', ''])('supports compatible scalar/default v2 form %s', form => {
    for (const role of ROOM_ROLES) {
      const result = parse(renderRoleConfig(`[features]\nmulti_agent = true\n${form}`, role, '/instructions', '/catalog'));
      expect(result.features).toEqual({ multi_agent: false, multi_agent_v2: form ? false : { enabled: false } });
      expect(result.agents).toEqual({ enabled: false });
    }
  });
  it.each(['not valid toml', 'agents = true', 'features = []', 'profile = "operator"\n[profiles.operator]\nmodel = "override"', '[features]\nmulti_agent_v2 = "bad"', '[features]\nmulti_agent_v2 = 2026-01-01'])('fails closed on incompatible TOML without source disclosure', text => {
    expect(() => renderRoleConfig(text, 'peer', '/instructions', '/catalog')).toThrow('Cannot render canonical Codex config');
  });
  it('nulls every catalog key without unrelated semantic loss or input mutation', () => {
    const before = structuredClone(catalog);
    expect(JSON.parse(renderModelCatalog(catalog))).toEqual({ models: [{ slug: 'gpt-5.6-sol', multi_agent_version: null, limits: [1, 2], enabled: true },
      { slug: 'other', multi_agent_version: null }], extra: { multi_agent_version: null, nested: [{ multi_agent_version: null, untouched: 'value' }] } });
    expect(catalog).toEqual(before);
    expect(JSON.parse(renderModelCatalog(catalog.models))).toEqual([{ slug: 'gpt-5.6-sol', multi_agent_version: null, limits: [1, 2], enabled: true }, { slug: 'other', multi_agent_version: null }]);
    expect(() => renderModelCatalog(null)).toThrow('Cannot render');
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => renderModelCatalog(cyclic)).toThrow('Cannot render');
  });
  it('uses discovered alias targets, ignores unapproved resources and supports native prefixes', async () => {
    const input = await fixture();
    const target = join(input.discovery.canonicalHome, 'operator-instructions'); await fs.rename(join(input.discovery.canonicalHome, 'AGENTS.md'), target);
    const changed = { ...input, discovery: { ...input.discovery, launchPrefix: ['/native/codex'] as const,
      sharedTargets: { ...input.discovery.sharedTargets, 'AGENTS.md': target, 'unapproved': '/outside' } } };
    const artifacts = await adapter.buildArtifacts(changed);
    expect(artifacts.filter(a => a.kind === 'symlink' && a.target === target)).toHaveLength(3);
    expect(artifacts.some(a => a.path.endsWith('/unapproved'))).toBe(false);
    expect(adapter.buildProvider('peer', changed).command).toEqual(['/native/codex']);
  });
  it.each(['role', 'root', 'relative', 'overlap', 'target', 'missing-target', 'config', 'config-link', 'config-hardlink', 'auth-alias'])('rejects unsafe declaration/source %s', async kind => {
    const input = await fixture(); let changed = input;
    if (kind === 'role') changed = { ...input, roleHomes: { ...input.roleHomes, peer: input.roleHomes.lead } };
    if (kind === 'root') changed = { ...input, roomHome: input.roomHome + '/other' };
    if (kind === 'relative') changed = { ...input, roomHome: 'relative' };
    if (kind === 'overlap') changed = { ...input, discovery: { ...input.discovery, canonicalHome: input.roomHome } };
    if (kind === 'target' || kind === 'missing-target') changed = { ...input, discovery: { ...input.discovery, sharedTargets: { ...input.discovery.sharedTargets, 'auth.json': kind === 'target' ? '/outside' : '' } } };
    if (kind === 'config') changed = { ...input, discovery: { ...input.discovery, configPath: '/outside' } };
    if (kind === 'config-link' || kind === 'auth-alias') {
      await fs.unlink(input.discovery.configPath);
      if (kind === 'config-link') await fs.symlink(join(input.discovery.canonicalHome, 'auth.json'), input.discovery.configPath);
      else changed = { ...input, discovery: { ...input.discovery, configPath: join(input.discovery.canonicalHome, 'auth.json') } };
    }
    if (kind === 'config-hardlink') await fs.link(input.discovery.configPath, join(input.discovery.canonicalHome, 'alias'));
    await expect(adapter.buildArtifacts(changed)).rejects.toThrow('Cannot build Codex artifacts');
    expect(reads).toEqual([]);
  });
});

describe('read-only runtime verification', () => {
  it.each(['missing', 'content', 'catalog', 'mode', 'special-mode', 'directory-mode', 'wrong-type', 'wrong-link', 'auth-file', 'file-link', 'parent-link', 'hardlink', 'foreign-owner', 'io-error', 'credential-inode'])('detects %s without credential reads', async kind => {
    const input = await fixture(); await publish(await adapter.buildArtifacts(input)); reads.length = 0;
    const config = join(input.roleHomes.peer, 'config.toml'); const auth = join(input.roleHomes.peer, 'auth.json');
    let fsPort = filesystem;
    if (kind === 'missing') await fs.unlink(config);
    if (kind === 'content') await fs.writeFile(config, 'model = "wrong"');
    if (kind === 'catalog') await fs.writeFile(join(input.roleHomes.peer, CATALOG_NAME), '{}');
    if (kind === 'mode' || kind === 'special-mode') await fs.chmod(config, kind === 'mode' ? 0o644 : 0o4600);
    if (kind === 'directory-mode') await fs.chmod(input.roleHomes.peer, 0o755);
    if (kind === 'wrong-type') { await fs.unlink(config); await fs.mkdir(config); }
    if (kind === 'wrong-link' || kind === 'auth-file') {
      await fs.unlink(auth);
      if (kind === 'wrong-link') await fs.symlink('/wrong', auth); else await fs.writeFile(auth, '');
    }
    if (kind === 'file-link') { await fs.unlink(config); await fs.symlink(join(input.discovery.canonicalHome, 'auth.json'), config); }
    if (kind === 'parent-link') {
      await fs.rename(input.roleHomes.peer, input.roleHomes.peer + '-moved');
      await fs.symlink(input.roleHomes.peer + '-moved', input.roleHomes.peer);
    }
    if (kind === 'hardlink') await fs.link(config, join(input.roleHomes.peer, 'alias'));
    if (kind === 'foreign-owner' || kind === 'credential-inode') fsPort = { ...filesystem, async lstat(path) {
      const meta = await filesystem.lstat(path);
      if (path !== config || !meta) return meta;
      if (kind === 'foreign-owner') return { ...meta, uid: meta.uid + 1 };
      const credential = await filesystem.lstat(join(input.discovery.canonicalHome, 'auth.json'));
      if (!credential) throw new Error();
      return { ...meta, device: credential.device, inode: credential.inode };
    } };
    if (kind === 'io-error') fsPort = { ...filesystem, readFile(path) { if (path === config) throw new Error('sensitive diagnostic'); return filesystem.readFile(path); } };
    const before = await snapshot(input.discovery.canonicalHome);
    const checks = await verification(input, fsPort);
    expect(checks.some(c => c.status === 'fail')).toBe(true);
    expect(JSON.stringify(checks)).not.toContain('sensitive diagnostic');
    if (['file-link', 'parent-link', 'hardlink', 'foreign-owner', 'credential-inode'].includes(kind)) expect(reads).not.toContain(config);
    expect(await snapshot(input.discovery.canonicalHome)).toEqual(before);
  });
  it.each(['missing', 'symlink', 'wrong-type', 'unreadable'])('detects invalid shared target: %s', async kind => {
    const input = await fixture(); await publish(await adapter.buildArtifacts(input));
    const target = join(input.discovery.canonicalHome, 'AGENTS.md');
    if (kind === 'unreadable') await fs.chmod(target, 0o000);
    else {
      await fs.unlink(target);
      if (kind === 'symlink') await fs.symlink(join(input.discovery.canonicalHome, 'auth.json'), target);
      if (kind === 'wrong-type') await fs.mkdir(target);
    }
    const checks = await verification(input);
    expect(checks.filter(c => c.id.endsWith('/AGENTS.md') && c.status === 'fail')).toHaveLength(3);
  });
  it('returns a sanitized failure if expected state cannot be established', async () => {
    const input = await fixture(); await fs.writeFile(input.discovery.configPath, 'broken [');
    expect(await verification(input)).toMatchObject([{ id: 'codex.runtime', status: 'fail' }]);
  });
});
