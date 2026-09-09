import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { ArtifactSpec, BuildArtifactsInput, ProviderInput } from '../contract.js';
import type { ManagedProvider, ReadonlyFileSystem } from '../../core/seams.js';
import { containsPath, requireDisjointRoots, resolveManagedRoot } from '../../core/paths.js';
import { ROOM_ROLES, ROLE_PASEO_TOOLS, type RoomRole } from '../../room/roles.js';
import { renderModelInstructions, renderWorkspaceProtocol } from '../../room/instructions/index.js';
import type { CodexDiscovery } from './discover.js';
import { renderModelCatalog, renderRoleConfig } from './config-codec.js';

export const SHARED_RESOURCES = ['auth.json', 'AGENTS.md', 'skills', 'plugins', 'hooks.json'] as const;
export const CATALOG_NAME = 'model-catalog.no-native-agents.json';
type Input = BuildArtifactsInput<CodexDiscovery>;

export function validateLayout(input: Input): void {
  const { roomHome, discovery, roleHomes } = input;
  if (!isAbsolute(roomHome) || normalize(roomHome) !== roomHome || roomHome !== discovery.roomHome) {
    throw new Error('Use the validated discovered room home.');
  }
  requireDisjointRoots(discovery.canonicalHome, roomHome);
  for (const role of ROOM_ROLES) {
    if (roleHomes[role] !== join(roomHome, 'roles/codex', role)) throw new Error('Use isolated managed Codex role homes.');
  }
  for (const name of SHARED_RESOURCES) {
    const target = discovery.sharedTargets[name];
    if (target === undefined && name === 'hooks.json') continue;
    if (!target || !isAbsolute(target) || normalize(target) !== target || target === discovery.canonicalHome ||
        !containsPath(discovery.canonicalHome, target)) throw new Error('Use validated canonical shared-resource targets.');
  }
}

/** Recheck source metadata before reading config, including credential aliases. */
async function readConfig(filesystem: ReadonlyFileSystem, discovery: CodexDiscovery): Promise<string> {
  const path = discovery.configPath;
  const authPath = discovery.sharedTargets['auth.json'];
  if (!authPath || !isAbsolute(path) || path === discovery.canonicalHome || !containsPath(discovery.canonicalHome, path)) throw new Error();
  await resolveManagedRoot(filesystem, dirname(path));
  const [config, auth] = await Promise.all([filesystem.lstat(path), filesystem.lstat(authPath)]);
  if (config?.kind !== 'file' || auth?.kind !== 'file' || config.links !== 1 ||
      config.uid !== auth.uid || config.uid !== process.getuid?.() ||
      (config.device === auth.device && config.inode === auth.inode) || await filesystem.realpath(path) !== path) throw new Error();
  return Buffer.from(await filesystem.readFile(path)).toString('utf8');
}

export async function buildCodexArtifacts(input: Input, filesystem: ReadonlyFileSystem): Promise<ArtifactSpec[]> {
  try {
    validateLayout(input);
    const source = await readConfig(filesystem, input.discovery);
    const room = join(input.roomHome, 'room');
    const instructions = join(room, 'model-instructions.md');
    const artifacts: ArtifactSpec[] = [input.roomHome, room, join(input.roomHome, 'roles'), join(input.roomHome, 'roles/codex')]
      .map(path => ({ kind: 'directory', path, mode: 0o700 }));
    artifacts.push({ kind: 'file', path: instructions, mode: 0o600, content: renderModelInstructions() },
      { kind: 'file', path: join(room, 'workspace-protocol.md'), mode: 0o600, content: renderWorkspaceProtocol() });
    const catalog = renderModelCatalog(input.discovery.modelCatalog);
    for (const role of ROOM_ROLES) {
      const home = input.roleHomes[role];
      const catalogPath = join(home, CATALOG_NAME);
      artifacts.push({ kind: 'directory', path: home, mode: 0o700 },
        { kind: 'file', path: join(home, 'config.toml'), mode: 0o600, content: renderRoleConfig(source, role, instructions, catalogPath) },
        { kind: 'file', path: catalogPath, mode: 0o600, content: catalog });
      for (const name of SHARED_RESOURCES) {
        const target = input.discovery.sharedTargets[name];
        if (target !== undefined) artifacts.push({ kind: 'symlink', path: join(home, name), target });
      }
    }
    return artifacts;
  } catch {
    throw new Error('Cannot build Codex artifacts; rediscover safe paths and check canonical config/catalog compatibility.');
  }
}

export function buildCodexProvider(role: RoomRole, input: ProviderInput<CodexDiscovery>): ManagedProvider {
  validateLayout(input);
  return { extends: 'codex', label: `Codex ${role.charAt(0).toUpperCase()}${role.slice(1)}`,
    command: [...input.discovery.launchPrefix], env: { CODEX_HOME: input.roleHomes[role] },
    paseoTools: { enabled: ROLE_PASEO_TOOLS[role] } };
}
