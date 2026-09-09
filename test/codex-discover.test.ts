import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverCodex } from '../src/adapters/codex/discover.js';
import type { DiscoveryContext } from '../src/adapters/contract.js';
import type { ReadonlyFileSystem } from '../src/core/seams.js';
import { runtime } from './fakes/contracts.js';
import { processRunner } from '../src/core/process.js';

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
  readFile(path) { reads.push(path); return fs.readFile(path); },
};
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); reads.length = 0; });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'codex discovery ')));
  roots.push(root);
  const home = join(root, '.codex');
  const bin = join(root, 'bin with spaces');
  await fs.mkdir(home); await fs.mkdir(bin);
  for (const name of ['skills', 'plugins']) await fs.mkdir(join(home, name));
  for (const name of ['config.toml', 'auth.json', 'AGENTS.md']) await fs.writeFile(join(home, name), name === 'auth.json' ? 'disposable fake credential' : 'fixture');
  const codex = join(bin, 'codex');
  await fs.writeFile(codex, Buffer.from('7f454c4600000000', 'hex'), { mode: 0o700 });
  await fs.symlink(await fs.realpath(process.execPath), join(bin, 'node'));
  const calls: Parameters<DiscoveryContext['process']['run']>[0][] = [];
  const context: DiscoveryContext = {
    intent: { command: 'plan', agent: 'codex', apply: false, json: false, nonInteractive: true },
    filesystem, runtime, environment: { HOME: root, PATH: bin, PASEO_PASSWORD: 'must-not-forward', NODE_OPTIONS: 'must-not-forward' },
    process: { run(input) { calls.push(input); return Promise.resolve({ exitCode: 0, stdout: input.args.includes('--version') ? 'codex-cli 0.114.0\n' : '{"models":[]}', stderr: '' }); } },
  };
  return { root, home, bin, codex, calls, context };
}
async function snapshot(root: string): Promise<unknown> {
  const entries: unknown[] = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const path = join(root, name); const stat = await fs.lstat(path);
    // Credential content is never read, copied, or hashed, even in test snapshots.
    entries.push([name, stat.mode, stat.size, stat.mtimeMs, stat.ino, stat.nlink,
      stat.isSymbolicLink() ? await fs.readlink(path) : stat.isDirectory() ? await snapshot(path) : name === 'auth.json' ? 'metadata-only' : await fs.readFile(path)]);
  }
  return entries;
}

describe('read-only Codex discovery', () => {
  it('discovers native prefixes, versions and defaults without changing the tree or reading auth', async () => {
    const f = await fixture(); const before = await snapshot(f.root);
    const result = await discoverCodex(f.context);
    expect(result.launchPrefix).toEqual([f.codex]); expect(result.version).toBe('0.114.0');
    expect(result.canonicalHome).toBe(f.home); expect(result.roomHome).toBe(join(f.root, '.local/share/paseo-room'));
    expect(f.calls.map((call) => call.args)).toEqual([['--version'], ['debug', 'models']]);
    for (const call of f.calls) expect(call).toMatchObject({ shell: false, timeoutMs: 10000, env: { HOME: f.root, CODEX_HOME: f.home, LANG: 'C', LC_ALL: 'C' } });
    expect(Object.keys(f.calls[0]?.env ?? {}).sort()).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL']);
    expect(reads).not.toContain(join(f.home, 'auth.json')); expect(await snapshot(f.root)).toEqual(before);
  });
  it('runs a real npm launcher with absolute Node/script argv under a minimal environment', async () => {
    const f = await fixture();
    await fs.writeFile(f.codex, '#!/usr/bin/env node\nconsole.log(process.argv.includes("--version") ? "codex-cli 0.114.0" : JSON.stringify({models:[]}));\n');
    const alias = join(f.bin, 'alias'); await fs.symlink(f.codex, alias);
    const before = await snapshot(f.root);
    const result = await discoverCodex({ ...f.context, intent: { ...f.context.intent, codexBin: alias }, process: processRunner });
    expect(result.launchPrefix).toEqual([await fs.realpath(process.execPath), f.codex]);
    expect(result.version).toBe('0.114.0'); expect(result.modelCatalog).toEqual({ models: [] });
    expect(await snapshot(f.root)).toEqual(before);
  });
  it('resolves canonical aliases and explicit > environment > defaults', async () => {
    const f = await fixture(); const alias = join(f.root, 'home alias'); await fs.symlink(f.home, alias);
    const environment = { ...f.context.environment, CODEX_HOME: alias, CODEX_BIN: f.codex, PASEO_ROOM_HOME: join(f.root, 'env room') };
    expect((await discoverCodex({ ...f.context, environment })).canonicalHome).toBe(f.home);
    const result = await discoverCodex({ ...f.context, environment: { ...environment, CODEX_HOME: '/missing', CODEX_BIN: '/missing' }, intent: { ...f.context.intent, codexHome: alias, codexBin: f.codex, roomHome: join(f.root, 'explicit room') } });
    expect(result.roomHome).toBe(join(f.root, 'explicit room'));
  });
  it.each(['#!/bin/sh', '#!/usr/bin/python3', '#!/usr/bin/env node --flag', 'plain script'])('rejects unsupported launcher %s without probes', async (launcher) => {
    const f = await fixture(); await fs.writeFile(f.codex, `${launcher}\n`);
    const before = await snapshot(f.root);
    await expect(discoverCodex(f.context)).rejects.toThrow(/native|launcher/);
    expect(f.calls).toEqual([]); expect(await snapshot(f.root)).toEqual(before);
  });
  it.each(['config.toml', 'auth.json', 'AGENTS.md', 'skills', 'plugins'])('rejects missing required %s', async (name) => {
    const f = await fixture(); await fs.rm(join(f.home, name), { recursive: true });
    await expect(discoverCodex(f.context)).rejects.toThrow(name); expect(f.calls).toEqual([]);
  });
  it.each(['inside', 'outside', 'equal'])('rejects nested roots: %s', async (direction) => {
    const f = await fixture(); const roomHome = direction === 'inside' ? join(f.home, 'room') : direction === 'outside' ? f.root : f.home;
    await expect(discoverCodex({ ...f.context, intent: { ...f.context.intent, roomHome } })).rejects.toThrow(/disjoint/);
    expect(f.calls).toEqual([]);
  });
  it('rejects managed symlink parents and shared resource escapes', async () => {
    const f = await fixture(); const alias = join(f.root, 'alias'); await fs.symlink(f.home, alias);
    await expect(discoverCodex({ ...f.context, intent: { ...f.context.intent, roomHome: join(alias, 'room') } })).rejects.toThrow(/parents/);
    await fs.rm(join(f.home, 'auth.json')); await fs.symlink(f.codex, join(f.home, 'auth.json'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/inside the canonical/);
  });
  it('accepts contained shared aliases and rejects hardlinks', async () => {
    const f = await fixture(); await fs.rename(join(f.home, 'AGENTS.md'), join(f.home, 'instructions'));
    await fs.symlink(join(f.home, 'instructions'), join(f.home, 'AGENTS.md'));
    expect((await discoverCodex(f.context)).sharedTargets['AGENTS.md']).toBe(join(f.home, 'instructions'));
    await fs.link(join(f.home, 'config.toml'), join(f.root, 'config alias'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/hard-link/);
  });
  it('rejects config and executable aliases to auth before reading credentials', async () => {
    const f = await fixture();
    const auth = join(f.home, 'auth.json');
    await fs.rm(join(f.home, 'config.toml'));
    await fs.symlink(auth, join(f.home, 'config.toml'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/physically distinct/);
    expect(reads).not.toContain(auth);
    expect(f.calls).toEqual([]);

    await fs.rm(join(f.home, 'config.toml'));
    await fs.writeFile(join(f.home, 'config.toml'), 'fixture');
    await fs.chmod(auth, 0o700);
    await fs.rm(f.codex);
    await fs.symlink(auth, f.codex);
    await expect(discoverCodex(f.context)).rejects.toThrow(/physically distinct/);
    expect(reads).not.toContain(auth);
    expect(f.calls).toEqual([]);
  });
  it('rejects a Node alias to auth before reading credentials', async () => {
    const f = await fixture();
    const auth = join(f.home, 'auth.json');
    await fs.chmod(auth, 0o700);
    await fs.writeFile(f.codex, '#!/usr/bin/env node\n');
    await fs.unlink(join(f.bin, 'node'));
    await fs.symlink(auth, join(f.bin, 'node'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/physically distinct/);
    expect(reads).not.toContain(auth);
    expect(f.calls).toEqual([]);
  });
  it('rejects missing homes and missing executables without creating paths', async () => {
    const f = await fixture(); const before = await snapshot(f.root);
    await expect(discoverCodex({ ...f.context, intent: { ...f.context.intent, codexHome: join(f.root, 'missing') } })).rejects.toThrow(/existing/);
    await expect(discoverCodex({ ...f.context, intent: { ...f.context.intent, codexBin: join(f.root, 'missing') } })).rejects.toThrow(/executable/);
    await expect(discoverCodex({ ...f.context, environment: {} })).rejects.toThrow(/HOME/);
    await expect(discoverCodex(f.context, -1)).rejects.toThrow(/operator-owned/);
    expect(await snapshot(f.root)).toEqual(before);
  });
  it('validates optional hooks, unreadable files and wrong types', async () => {
    const f = await fixture(); await fs.writeFile(join(f.home, 'hooks.json'), '{}');
    expect((await discoverCodex(f.context)).sharedTargets['hooks.json']).toBe(join(f.home, 'hooks.json'));
    await fs.chmod(join(f.home, 'hooks.json'), 0);
    await expect(discoverCodex(f.context)).rejects.toThrow(/hooks.json/);
    await fs.rm(join(f.home, 'hooks.json')); await fs.mkdir(join(f.home, 'hooks.json'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/expected type/);
  });
  it('rejects dangling links, non-executable files and cached executables', async () => {
    const f = await fixture();
    await fs.symlink(join(f.root, 'missing'), join(f.home, 'hooks.json'));
    await expect(discoverCodex(f.context)).rejects.toThrow(/accessible/);
    await fs.rm(join(f.home, 'hooks.json')); await fs.chmod(f.codex, 0o600);
    await expect(discoverCodex(f.context)).rejects.toThrow(/executable/);
    const cache = join(f.root, '_npx'); await fs.mkdir(cache);
    const cached = join(cache, 'codex'); await fs.copyFile(f.codex, cached); await fs.chmod(cached, 0o700);
    await expect(discoverCodex({ ...f.context, intent: { ...f.context.intent, codexBin: cached } })).rejects.toThrow(/persistent/);
  });
  it('rejects a Node interpreter wrapper and primitive model catalogs', async () => {
    const f = await fixture(); await fs.writeFile(f.codex, '#!/usr/bin/env node\n');
    await fs.unlink(join(f.bin, 'node')); await fs.writeFile(join(f.bin, 'node'), '#!/bin/sh\n', { mode: 0o700 });
    await expect(discoverCodex(f.context)).rejects.toThrow(/native Node/);
    await fs.unlink(join(f.bin, 'node')); await fs.symlink(process.execPath, join(f.bin, 'node'));
    await expect(discoverCodex({ ...f.context, process: { run(input) { return Promise.resolve({ exitCode: 0, stdout: input.args.includes('--version') ? '1.0.0' : 'null', stderr: '' }); } } })).rejects.toThrow(/catalog/);
  });
  it.each(['failure', 'version', 'models', 'throw'])('sanitizes %s probe failures', async (kind) => {
    const f = await fixture();
    const secret = 'sensitive-output';
    const runner: DiscoveryContext['process'] = { run(input) {
      if (kind === 'throw') return Promise.reject(new Error(secret));
      return Promise.resolve({ exitCode: kind === 'failure' ? 1 : 0, stdout: kind === 'version' || input.args.includes('models') ? secret : 'codex-cli 0.114.0', stderr: secret });
    } };
    const error: unknown = await discoverCodex({ ...f.context, process: runner }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain(secret);
  });
});

it('bounds process execution and does not expose stderr in spawn errors', async () => {
  const input = { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], env: {}, timeoutMs: 20, shell: false as const };
  await expect(processRunner.run(input)).rejects.toThrow(/timeout/);
  await expect(processRunner.run({ ...input, timeoutMs: 0 })).rejects.toThrow(/timeout/);
  await expect(processRunner.run({ ...input, executable: 'node' })).rejects.toThrow(/absolute/);
});
