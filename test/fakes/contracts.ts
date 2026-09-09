import type { AgentAdapter } from '../../src/adapters/contract.js';
import type { PaseoGateway, ProcessRunner, ReadonlyFileSystem, RuntimeIdentity } from '../../src/core/seams.js';
import { ROLE_PASEO_TOOLS } from '../../src/room/roles.js';

export const filesystem: ReadonlyFileSystem = {
  lstat: () => Promise.resolve(null),
  realpath: (path) => Promise.resolve(path),
  readlink: () => Promise.reject(new Error('No fixture link')),
  readdir: () => Promise.resolve([]),
  readFile: () => Promise.reject(new Error('No fixture file')),
};
export const processRunner: ProcessRunner = {
  run: () => Promise.resolve({ exitCode: 0, stdout: 'fixture', stderr: '' }),
};
export const runtime: RuntimeIdentity = {
  now: () => new Date('2026-01-01T00:00:00Z'), pid: 1,
  isProcessAlive: () => Promise.resolve(false),
};
export const gateway: PaseoGateway = {
  snapshot: () => Promise.resolve({ localHome: '/fixture/paseo', listen: 'ws://127.0.0.1:6767', endpointIdentitySha256: '0'.repeat(64), cliVersion: '0.8.0-beta.1',
    daemonVersion: '0.8.0-beta.1', providers: {}, readyProviderIds: [], activeManagedProviderIds: [] }),
  close: () => Promise.resolve(),
};
export const adapter: AgentAdapter<{ executable: string }> = {
  id: 'fixture',
  discover: async (context) => {
    await context.filesystem.lstat('/fixture');
    return { executable: '/fixture/agent' };
  },
  buildArtifacts: (input) => Promise.resolve([{ kind: 'directory', path: input.roomHome, mode: 0o700 }]),
  buildProvider: (role, input) => ({ extends: 'fixture', label: role,
    command: [input.discovery.executable], env: { FIXTURE_HOME: input.roleHomes[role] },
    paseoTools: { enabled: ROLE_PASEO_TOOLS[role] } }),
  verifyRuntime: async (input) => {
    await input.gateway.snapshot();
    return [{ id: 'fixture', status: 'pass', message: 'Fixture only' }];
  },
};
