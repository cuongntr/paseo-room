import { symlinkSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, mkdir, writeFile, symlink, lstat, readFile, readlink, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, canonicalJsonSha256, sha256 } from '../src/core/hash.js';
import { buildManifestArtifacts, buildManifestProviders, loadManifest, validateManifest, type InstallationManifestV1 } from '../src/core/manifest.js';
import { observeOwnedState, type LiveManifestFacts, type ObservationDependencies } from '../src/core/observation.js';
import type { FileMetadata } from '../src/core/seams.js';
import { endpointIdentitySha256 } from '../src/paseo/cli-probe.js';
import { paseoFilesystem } from '../src/paseo/runtime.js';
import { hashFileNoFollow } from '../src/core/guarded-hash.js';
import { policyFixture } from './helpers/provider-policy.js';

const context = { roomHome: '/fixture/room' };
function fixture(): InstallationManifestV1 {
  return {
    schemaVersion: 1, packageVersion: '0.1.0-alpha.0', installationId: 'installation-1', lastTransactionId: 'transaction-1',
    status: 'committed', adapter: 'codex',
    paseo: { localHome: '/fixture/paseo', listen: 'ws://127.0.0.1:6767', endpointIdentitySha256: endpointIdentitySha256('/fixture/paseo', 'ws://127.0.0.1:6767'),
      cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1', minimumVersion: '0.8.0-beta.1' },
    source: { canonicalHome: '/fixture/canonical', canonicalConfigSha256: sha256('config'), codexLaunchArgv: ['/opt/codex'], codexVersion: '1.0.0' },
    artifacts: buildManifestArtifacts([
      { kind: 'directory', path: context.roomHome, mode: 0o700 },
      { kind: 'directory', path: '/fixture/room/roles/codex/peer', mode: 0o700 },
      { kind: 'file', path: '/fixture/room/roles/codex/peer/config.toml', mode: 0o600, content: 'authored' },
      { kind: 'symlink', path: '/fixture/room/roles/codex/peer/auth.json', target: '/fixture/canonical/auth.json' },
    ], context),
    providers: buildManifestProviders(policyFixture()), committedAt: '2026-09-09T09:00:00.000Z',
  };
}
function live(manifest = fixture()): LiveManifestFacts {
  return { packageVersion: manifest.packageVersion, adapter: manifest.adapter, paseo: { ...manifest.paseo }, source: { ...manifest.source }, providers: policyFixture() };
}
function observationFixture() {
  const manifest = fixture();
  const metadata = new Map<string, FileMetadata>();
  for (const artifact of manifest.artifacts) metadata.set(artifact.path, { kind: artifact.kind, mode: artifact.mode, uid: 501, device: 1, inode: 2, links: 1 });
  const readFile = vi.fn((path: string) => {
    if (path !== '/fixture/room/roles/codex/peer/config.toml') throw new Error('forbidden read');
    return Promise.resolve(Buffer.from('authored'));
  });
  const readlink = vi.fn(() => Promise.resolve('/fixture/canonical/auth.json'));
  const lstat = vi.fn((path: string): Promise<FileMetadata | null> => Promise.resolve(metadata.get(path) ?? { kind: 'directory' as const, mode: 0o700, uid: 501, device: 1, inode: 3, links: 2 }));
  const deps: ObservationDependencies = { uid: 501, filesystem: { lstat, hashFileNoFollow: async path => sha256(await readFile(path)), readlink } };
  return { manifest, metadata, readFile, readlink, lstat, deps };
}

describe('canonical JSON and SHA256', () => {
  it('sorts recursively without sorting arrays and matches independent vectors', () => {
    expect(canonicalJson({ z: [3, { b: true, a: null }], a: 'é\n' })).toBe('{"a":"é\\n","z":[3,{"a":null,"b":true}]}');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(canonicalJsonSha256({ b: 2, a: 1 })).toBe(canonicalJsonSha256({ a: 1, b: 2 }));
    expect(canonicalJsonSha256([1, 2])).not.toBe(canonicalJsonSha256([2, 1]));
    const child = { a: 1 };
    expect(canonicalJson([child, child])).toBe('[{"a":1},{"a":1}]');
  });
  it.each([undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol('x'), () => 1, new Date(), new Map(), new Set(),
    [undefined], Array(1), Object.assign([1], { extra: true }), { value: undefined }, Object.defineProperty({}, 'hidden', { value: 1 }),
    { [Symbol('key')]: 1 }, Object.create({ inherited: true }) as unknown])('rejects ambiguous/non-JSON input %#', value => {
    expect(() => canonicalJson(value)).toThrow();
  });
  it('rejects cycles and accessors without invoking them', () => {
    const cycle: unknown[] = []; cycle.push(cycle);
    expect(() => canonicalJson(cycle)).toThrow();
    const getter = vi.fn(() => 'secret');
    expect(() => canonicalJson(Object.defineProperty({}, 'x', { enumerable: true, get: getter }))).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('manifest v1', () => {
  it('loads committed strings/bytes, deterministic paths and residual provider subsets', () => {
    const manifest = fixture();
    expect(loadManifest(JSON.stringify(manifest), context)).toEqual(manifest);
    expect(loadManifest(Buffer.from(JSON.stringify(manifest)), context)).toEqual(manifest);
    manifest.status = 'uninstall-incomplete';
    manifest.artifacts = [];
    delete manifest.providers['codex-lead']; delete manifest.providers['codex-peer'];
    expect(validateManifest(manifest, context)).toEqual(manifest);
    manifest.providers = {};
    expect(validateManifest(manifest, context)).toEqual(manifest);
  });
  it.each([
    ['schemaVersion', 2], ['schemaVersion', '1'], ['adapter', 'pi'], ['packageVersion', 'bad'], ['installationId', '../id'],
    ['committedAt', 'yesterday'], ['committedAt', '2026-02-30T00:00:00Z'], ['committedAt', '2026-09-09'], ['serverId', 'unexpected'],
    ['status', 'pending'], ['source', {}],
  ])('rejects malformed %s %#', (key, value) => {
    expect(() => validateManifest({ ...fixture(), [key]: value }, context)).toThrow('Cannot use installation manifest');
  });
  it.each(['relative', '/fixture/room/../escape', '/fixture/room//x', '/fixture/room/x/', '/fixture/roomish/x', '/elsewhere', '/fixture/room/\u0000x'])('rejects malformed/outside path %s', path => {
    const manifest = fixture(); manifest.artifacts = [{ kind: 'file', path, mode: 0o600, sha256: sha256('x') }];
    expect(() => validateManifest(manifest, context)).toThrow();
  });
  it('rejects duplicate paths, link parents, forbidden file declarations and credential ownership', () => {
    const manifest = fixture(); manifest.artifacts.push(...manifest.artifacts);
    expect(() => validateManifest(manifest, context)).toThrow();
    manifest.artifacts = [{ kind: 'symlink', mode: 0o777, path: '/fixture/room/link', target: '/fixture/canonical/skills' }, { kind: 'file', path: '/fixture/room/link/child', mode: 0o600, sha256: sha256('x') }];
    expect(() => validateManifest(manifest, context)).toThrow();
    expect(() => buildManifestArtifacts([{ kind: 'file', path: '/fixture/room/roles/codex/peer/auth.json', mode: 0o600, content: 'not credentials' }], context)).toThrow();
    expect(() => buildManifestArtifacts([{ kind: 'file', path: '/fixture/room/secret', mode: 0o600, content: 'not credentials' }], { ...context, forbiddenFilePaths: ['/fixture/room/secret'] })).toThrow();
  });
  it.each(['SHA256', 'a'.repeat(63), 'A'.repeat(64), 'x'.repeat(64)])('rejects malformed hash %s', hash => {
    const manifest = fixture(); manifest.source.canonicalConfigSha256 = hash;
    expect(() => validateManifest(manifest, context)).toThrow();
  });
  it('requires complete provider sets for committed and validates exact fixed applied shape/hash/home/launch', () => {
    const manifest = fixture(); delete manifest.providers['codex-peer'];
    expect(() => validateManifest(manifest, context)).toThrow();
    const policy = policyFixture();
    const extra = { ...policy, other: policy['codex-peer'] };
    expect(() => buildManifestProviders(extra)).toThrow();
    expect(() => buildManifestProviders({ ...policy, 'codex-peer': { ...policy['codex-peer'], extra: true } })).toThrow();
    for (const change of ['hash', 'prior', 'home', 'launch']) {
      const candidate = fixture(); const record = candidate.providers['codex-peer'];
      if (!record) throw new Error();
      candidate.providers['codex-peer'] = change === 'hash' ? { ...record, appliedSha256: '0'.repeat(64) } : record;
      if (change === 'home') record.applied.env.CODEX_HOME = '/fixture/room/roles/codex/supervisor';
      if (change === 'launch') candidate.source.codexLaunchArgv = ['/other/codex'];
      if (change === 'prior') Object.assign(record, { prior: {} });
      expect(() => validateManifest(candidate, context)).toThrow();
    }
  });
  it.each([
    { endpointIdentitySha256: '0'.repeat(64) }, { listen: 'localhost:6767' }, { listen: 'ws://example.com:6767' },
    { localHome: '/other/paseo' }, { cliVersion: '0.7.0', daemonVersion: '0.7.0' }, { daemonVersion: '0.9.0' }, { minimumVersion: '0.7.0' },
  ])('rejects invalid endpoint/version binding %#', change => {
    const manifest = fixture(); expect(() => validateManifest({ ...manifest, paseo: { ...manifest.paseo, ...change } }, context)).toThrow();
  });
  it.each([[], ['relative'], ['/opt/codex', '--flag'], ['/cache/_npx/codex']].map(codexLaunchArgv => ({ codexLaunchArgv })))('rejects invalid launch argv %#', ({ codexLaunchArgv }) => {
    const manifest = fixture(); expect(() => validateManifest({ ...manifest, source: { ...manifest.source, codexLaunchArgv } }, context)).toThrow();
  });
  it('injects and requires the portable symlink mode declaration', () => {
    const manifest = fixture();
    const artifact = manifest.artifacts.find(item => item.kind === 'symlink');
    expect(artifact?.mode).toBe(0o777);
    for (const mode of [undefined, 0o700, 0o600]) {
      expect(() => validateManifest({ ...manifest, artifacts: [{ ...artifact, mode }] }, context)).toThrow();
    }
  });
  it('rejects bad UTF-8, JSON, extra artifact keys and source overlap', () => {
    expect(() => loadManifest(new Uint8Array([0xff]), context)).toThrow('UTF-8');
    expect(() => loadManifest('{', context)).toThrow('JSON');
    const manifest = fixture();
    expect(() => validateManifest({ ...manifest, source: { ...manifest.source, canonicalHome: '/fixture' } }, context)).toThrow();
    expect(() => validateManifest({ ...manifest, paseo: { ...manifest.paseo, serverId: 'not-supported' } }, context)).toThrow();
    expect(() => validateManifest({ ...manifest, artifacts: [{ kind: 'directory', path: context.roomHome, mode: 0o700, sha256: sha256('children are not owned') }] }, context)).toThrow();
    expect(() => validateManifest({ ...manifest, artifacts: [{ kind: 'symlink', path: '/fixture/room/link', mode: 0o777, target: '/fixture/canonical/auth.json', sha256: sha256('not credentials') }] }, context)).toThrow();
  });
});

describe('read-only owned state', () => {
  it('observes declarations only; never reads/hashes auth or link targets or enumerates children', async () => {
    const f = observationFixture();
    const result = await observeOwnedState(f.manifest, context, live(), f.deps);
    expect(result.artifacts.map(item => item.state)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(result.providers.every(item => item.state === 'unchanged')).toBe(true);
    expect(result.drift).toEqual([]);
    expect(f.readFile.mock.calls).toEqual([['/fixture/room/roles/codex/peer/config.toml']]);
    expect(f.lstat.mock.calls.some(([path]) => path.startsWith('/fixture/canonical'))).toBe(false);
    expect(f.readlink).toHaveBeenCalledExactlyOnceWith('/fixture/room/roles/codex/peer/auth.json');
  });
  it.each(['file', 'symlink', 'directory'] as const)('classifies missing/wrong-type/foreign %s before reading', async kind => {
    for (const state of ['missing', 'wrong-type', 'unsafe'] as const) {
      const f = observationFixture(); const artifact = f.manifest.artifacts.find(item => item.kind === kind);
      if (!artifact) throw new Error();
      const original = f.lstat.getMockImplementation(); if (!original) throw new Error();
      f.lstat.mockImplementation(path => path === artifact.path ? Promise.resolve(state === 'missing' ? null : { kind: state === 'wrong-type' ? 'other' : kind, mode: 0o600, uid: 999, links: 1, device: 1, inode: 1 }) : original(path));
      const result = await observeOwnedState(f.manifest, context, live(), f.deps);
      expect(result.artifacts.find(item => item.path === artifact.path)?.state).toBe(state);
      expect(f.readFile.mock.calls.some(([path]) => path === artifact.path)).toBe(false);
    }
  });
  it.each([0o644, 0o666, 0o1600, 0o2600, 0o4600])('rejects unsafe file mode %i without reading', async mode => {
    const f = observationFixture(); const path = '/fixture/room/roles/codex/peer/config.toml';
    f.metadata.set(path, { kind: 'file', mode, uid: 501, links: 1, device: 1, inode: 2 });
    expect((await observeOwnedState(f.manifest, context, live(), f.deps)).artifacts.find(item => item.path === path)?.state).toBe('unsafe');
    expect(f.readFile).not.toHaveBeenCalled();
  });
  it('rejects hardlinks and credential inode aliases before reads', async () => {
    for (const links of [0, 2, 1]) {
      const f = observationFixture(); const path = '/fixture/room/roles/codex/peer/config.toml';
      f.metadata.set(path, { kind: 'file', mode: 0o600, uid: 501, links, device: 1, inode: 42 });
      const result = await observeOwnedState(f.manifest, context, live(), { ...f.deps, forbiddenFileIdentities: [{ device: 1, inode: 42 }] });
      expect(result.artifacts.find(item => item.path === path)?.state).toBe('unsafe'); expect(f.readFile).not.toHaveBeenCalled();
    }
  });
  it('detects customized file bytes, restrictive modes, and literal rather than resolved link targets', async () => {
    const f = observationFixture(); f.readFile.mockResolvedValue(Buffer.from('customized')); f.readlink.mockResolvedValue('/fixture/canonical/./auth.json');
    let result = await observeOwnedState(f.manifest, context, live(), f.deps);
    expect(result.artifacts.filter(item => item.state === 'customized')).toHaveLength(2);
    f.metadata.set('/fixture/room', { kind: 'directory', mode: 0o500, uid: 501, links: 10, device: 1, inode: 2 });
    result = await observeOwnedState(f.manifest, context, live(), f.deps);
    expect(result.artifacts[0]?.state).toBe('customized');
  });
  it.each(['symlink', 'other'] as const)('rejects malicious %s parents without traversing', async kind => {
    const f = observationFixture(); f.metadata.set('/fixture', { kind, mode: 0o700, uid: 501, links: 1, device: 1, inode: 2 });
    expect((await observeOwnedState(f.manifest, context, live(), f.deps)).artifacts.every(item => item.state === 'unsafe')).toBe(true);
    expect(f.readFile).not.toHaveBeenCalled(); expect(f.readlink).not.toHaveBeenCalled();
    expect(f.lstat.mock.calls.some(([path]) => path.startsWith('/fixture/room'))).toBe(false);
  });
  it('never follows a regular-file replacement link, or a customized malicious auth link', async () => {
    const f = observationFixture();
    f.metadata.set('/fixture/room/roles/codex/peer/config.toml', { kind: 'symlink', mode: 0o777, uid: 501, links: 1, device: 1, inode: 8 });
    f.readlink.mockResolvedValue('/outside/sensitive');
    const result = await observeOwnedState(f.manifest, context, live(), f.deps);
    expect(result.artifacts.find(item => item.path.endsWith('config.toml'))?.state).toBe('wrong-type');
    expect(result.artifacts.find(item => item.path.endsWith('auth.json'))?.state).toBe('customized');
    expect(f.readFile).not.toHaveBeenCalled();
    expect(f.lstat.mock.calls.some(([path]) => path.startsWith('/outside'))).toBe(false);
  });
  it('fails closed on IO errors and validates before observing', async () => {
    const f = observationFixture(); f.lstat.mockRejectedValue(new Error('sensitive diagnostics'));
    expect((await observeOwnedState(f.manifest, context, live(), f.deps)).artifacts.every(item => item.state === 'unsafe')).toBe(true);
    f.lstat.mockClear();
    await expect(observeOwnedState({ ...f.manifest, schemaVersion: 2 }, context, live(), f.deps)).rejects.toThrow('upgrade');
    expect(f.lstat).not.toHaveBeenCalled();
  });
  it('compares full provider entries, ignoring only unrelated providers', async () => {
    const f = observationFixture(); const facts = live(); const policy = policyFixture();
    const missing = Object.fromEntries(Object.entries(policy['codex-peer']).filter(([key]) => key !== 'env'));
    for (const value of [{ ...policy['codex-peer'], extra: 1 }, missing, { ...policy['codex-peer'], paseoTools: { enabled: false, disabledTools: [] } }, null]) {
      const result = await observeOwnedState(f.manifest, context, { ...facts, providers: { ...policy, 'codex-peer': value, unrelated: { secret: 'never inspected' } } }, f.deps);
      expect(result.providers.find(item => item.id === 'codex-peer')?.state).toBe('customized');
    }
    expect((await observeOwnedState(f.manifest, context, { ...facts, providers: {} }, f.deps)).providers.every(item => item.state === 'missing')).toBe(true);
  });
  it('detects every source/package/adapter/version/endpoint field drift deterministically', async () => {
    const f = observationFixture(); const facts = live();
    for (const section of ['source', 'paseo'] as const) {
      for (const field of Object.keys(facts[section])) {
        const result = await observeOwnedState(f.manifest, context, { ...facts, [section]: { ...facts[section], [field]: 'changed' } }, f.deps);
        expect(result.drift).toContain(`${section}.${field}`); expect(result.drift).toEqual([...result.drift].sort());
      }
    }
    expect((await observeOwnedState(f.manifest, context, { ...facts, adapter: 'other', packageVersion: '2.0.0' }, f.deps)).drift).toEqual(['adapter', 'packageVersion']);
  });
  it('supports repeated residual discharge without reacquiring removed ownership', async () => {
    const f = observationFixture(); f.manifest.status = 'uninstall-incomplete'; f.manifest.artifacts = []; delete f.manifest.providers['codex-peer']; delete f.manifest.providers['codex-lead'];
    const first = await observeOwnedState(f.manifest, context, { ...live(), providers: {} }, f.deps);
    expect(first.providers).toEqual([{ id: 'codex-supervisor', state: 'missing' }]); expect(f.lstat).not.toHaveBeenCalled();
    expect(await observeOwnedState(f.manifest, context, { ...live(), providers: {} }, f.deps)).toEqual(first);
  });
  it('rejects unsafe directory permissions and hardlinked links without reading children/targets', async () => {
    for (const kind of ['directory', 'symlink'] as const) {
      const f = observationFixture(); const artifact = f.manifest.artifacts.find(item => item.kind === kind);
      if (!artifact) throw new Error();
      f.metadata.set(artifact.path, { kind, mode: 0o777, uid: 501, links: 2, device: 1, inode: 2 });
      expect((await observeOwnedState(f.manifest, context, live(), f.deps)).artifacts.find(item => item.path === artifact.path)?.state).toBe('unsafe');
      expect(f.readlink).not.toHaveBeenCalled();
    }
  });
  it('leaves disposable on-disk files and extra mutable role children untouched', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'manifest-')));
    try {
      const roomHome = join(root, 'room'); const roleHome = join(roomHome, 'roles/codex/peer');
      const canonicalHome = join(root, 'canonical');
      await mkdir(roleHome, { recursive: true, mode: 0o700 }); await mkdir(canonicalHome, { mode: 0o700 });
      const file = join(roleHome, 'config.toml'); const auth = join(canonicalHome, 'auth.json'); const link = join(roleHome, 'auth.json');
      const mutable = join(roleHome, 'sessions');
      await mkdir(mutable, { mode: 0o700 }); await writeFile(join(mutable, 'runtime'), 'unowned', { mode: 0o600 });
      await writeFile(file, 'authored', { mode: 0o600 }); await writeFile(auth, 'synthetic credential sentinel', { mode: 0o600 });
      // macOS applies umask to links. Keep the process-wide change synchronous.
      const mask = process.umask(0);
      try { symlinkSync(auth, link); } finally { process.umask(mask); }
      const authBefore = await lstat(auth); const fileBefore = await lstat(file); const entriesBefore = await readdir(roleHome);
      const manifest = fixture(); manifest.status = 'uninstall-incomplete'; manifest.providers = {};
      manifest.source.canonicalHome = canonicalHome;
      manifest.artifacts = buildManifestArtifacts([{ kind: 'directory', path: roleHome, mode: 0o700 },
        { kind: 'file', path: file, mode: 0o600, content: 'authored' }, { kind: 'symlink', path: link, target: auth }], { roomHome });
      const read = vi.fn<typeof hashFileNoFollow>((path, parent, expected, forbidden) => { if (path !== file) throw new Error('credential or mutable-child read forbidden'); return hashFileNoFollow(path, parent, expected, forbidden); });
      const deps: ObservationDependencies = { uid: process.getuid?.() ?? -1,
        forbiddenFileIdentities: [{ device: authBefore.dev, inode: authBefore.ino }], filesystem: {
          lstat: async path => {
            const stat = await lstat(path);
            return { kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
              mode: stat.mode, uid: stat.uid, device: stat.dev, inode: stat.ino, links: stat.nlink };
          }, hashFileNoFollow: read, readlink,
        } };
      const result = await observeOwnedState(manifest, { roomHome }, live(manifest), deps);
      expect(result.artifacts.every(item => item.state === 'unchanged')).toBe(true);
      expect(read.mock.calls.map(([path]) => path)).toEqual([file]);
      expect(await lstat(auth)).toEqual(authBefore);
      const fileAfter = await lstat(file);
      expect([fileAfter.mode, fileAfter.size, fileAfter.mtimeMs, fileAfter.ctimeMs]).toEqual([fileBefore.mode, fileBefore.size, fileBefore.mtimeMs, fileBefore.ctimeMs]);
      expect(await readdir(roleHome)).toEqual(entriesBefore); expect(await readFile(join(mutable, 'runtime'), 'utf8')).toBe('unowned');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('compares symlink permission bits without reading its target', async () => {
    const f = observationFixture(); const path = '/fixture/room/roles/codex/peer/auth.json';
    const metadata = f.metadata.get(path); if (!metadata) throw new Error();
    f.metadata.set(path, { ...metadata, mode: 0o700 });
    expect((await observeOwnedState(f.manifest, context, live(), f.deps)).artifacts.find(item => item.path === path)?.state).toBe('customized');
    expect(f.readlink).not.toHaveBeenCalled();
  });
  it.each(['leaf-link', 'leaf-credential', 'parent-link', 'before-leaf-link', 'before-leaf-directory'] as const)('rejects %s replacement between lstat and open before reading credential bytes', async race => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'manifest-race-')));
    try {
      const roomHome = join(root, 'room'); const parent = join(roomHome, 'owned');
      const canonicalHome = join(root, 'canonical');
      await mkdir(parent, { recursive: true, mode: 0o700 }); await mkdir(canonicalHome, { mode: 0o700 });
      const file = join(parent, 'config.toml'); const credential = join(canonicalHome, 'config.toml');
      await writeFile(file, 'authored', { mode: 0o600 });
      await writeFile(credential, 'disposable canonical credential sentinel', { mode: 0o600 });
      const identity = await lstat(credential);
      const manifest = fixture(); manifest.status = 'uninstall-incomplete'; manifest.providers = {};
      manifest.source.canonicalHome = canonicalHome;
      manifest.artifacts = buildManifestArtifacts([{ kind: 'file', path: file, mode: 0o600, content: 'authored' }], { roomHome });
      const result = await observeOwnedState(manifest, { roomHome }, live(manifest), {
        uid: process.getuid?.() ?? -1, forbiddenFileIdentities: race.startsWith('before-leaf') ? [] : [{ device: identity.dev, inode: identity.ino }],
        filesystem: { ...paseoFilesystem, async lstat(path) {
          if (path === file && race.startsWith('before-leaf')) {
            await rename(parent, parent + '-old');
            if (race === 'before-leaf-link') await symlink(canonicalHome, parent);
            else await rename(canonicalHome, parent);
          }
          return paseoFilesystem.lstat(path);
        }, async hashFileNoFollow(path, expectedParent, expected, forbidden) {
          if (race === 'parent-link') {
            await rename(parent, parent + '-old'); await symlink(canonicalHome, parent);
          } else if (!race.startsWith('before-leaf')) {
            await rename(file, file + '-old');
            if (race === 'leaf-link') await symlink(credential, file);
            else await rename(credential, file);
          }
          return hashFileNoFollow(path, expectedParent, expected, forbidden);
        } },
      });
      expect(result.artifacts).toEqual([{ path: file, state: 'unsafe' }]);
      expect(JSON.stringify(result)).not.toContain('sentinel');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('normalizes artifact ordering independent of declaration order', async () => {
    const f = observationFixture(); const first = await observeOwnedState(f.manifest, context, live(), f.deps);
    f.manifest.artifacts.reverse();
    expect(await observeOwnedState(f.manifest, context, live(), f.deps)).toEqual(first);
  });
});
