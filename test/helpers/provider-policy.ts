import { join } from 'node:path';
import { buildCodexProvider } from '../../src/adapters/codex/runtime.js';
import { buildProviderPolicy } from '../../src/paseo/provider-policy.js';
import type { ProbeDependencies } from '../../src/paseo/cli-probe.js';
import { filesystem } from '../fakes/contracts.js';

export function policyFixture(prefix: readonly [string, ...string[]] = ['/opt/codex'], root = '/fixture') {
  const roomHome = join(root, 'room');
  const canonicalHome = join(root, 'canonical');
  const input = { roomHome, roleHomes: { supervisor: join(roomHome, 'roles/codex/supervisor'),
    lead: join(roomHome, 'roles/codex/lead'), peer: join(roomHome, 'roles/codex/peer') },
  discovery: { roomHome, canonicalHome, configPath: join(canonicalHome, 'config.toml'), launchPrefix: prefix,
    version: '1.0.0', modelCatalog: {}, sharedTargets: Object.fromEntries(['auth.json', 'AGENTS.md', 'skills', 'plugins'].map(name => [name, join(canonicalHome, name)])) } };
  return buildProviderPolicy({ 'codex-supervisor': buildCodexProvider('supervisor', input),
    'codex-lead': buildCodexProvider('lead', input), 'codex-peer': buildCodexProvider('peer', input) });
}
export const probeInput = { executable: '/bin/paseo', localHome: '/home/paseo', home: '/home', timeoutMs: 50 };
export function probeFixture(): ProbeDependencies {
  const status = { home: '/home/paseo', listen: 'localhost:6767', localDaemon: 'running', connectedDaemon: 'reachable',
    pid: 123, owner: '501@fixture', hostname: 'fixture', cliVersion: '0.8.0-beta.1', daemonVersion: '0.8.0-beta.1' };
  return { uid: 501, hostname: 'fixture', processUid: () => Promise.resolve(501),
    runner: { run: () => Promise.resolve({ exitCode: 0, stdout: JSON.stringify(status), stderr: '' }) },
    filesystem: { ...filesystem,
      readFile: path => Promise.resolve(Buffer.from(path === '/bin/paseo' ? '#!/usr/bin/env node\n' : path.endsWith('paseo.pid')
        ? JSON.stringify({ pid: 123, uid: 501, hostname: 'fixture', listen: 'localhost:6767' }) : 'fixture')),
      lstat: path => Promise.resolve({ kind: ['/bin/paseo', '/home/paseo/server-id', '/home/paseo/cli-client-id', '/home/paseo/paseo.pid', '/home/paseo/config.json'].includes(path) ? 'file' : 'directory',
        mode: path === '/bin/paseo' ? 0o755 : 0o600, device: 1, inode: 1, links: 1, uid: 501 }) } };
}
