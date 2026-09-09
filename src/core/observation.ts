import { dirname } from 'node:path';
import { canonicalJson } from './hash.js';
import { validateManifest, type InstallationManifestV1, type ManifestArtifact, type ManifestContext } from './manifest.js';
import { containsPath } from './paths.js';
import type { FileMetadata, GuardedFileHasher, ReadonlyFileSystem } from './seams.js';
import { providerEntriesEqual } from '../paseo/provider-policy.js';
import { endpointIdentitySha256, normalizeListen } from '../paseo/cli-probe.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';

export type OwnershipState = 'unchanged' | 'customized' | 'missing' | 'wrong-type' | 'unsafe';
export interface ArtifactObservation {
  readonly path: string;
  readonly state: OwnershipState;
}
export interface ProviderObservation {
  readonly id: ManagedProviderId;
  readonly state: 'unchanged' | 'customized' | 'missing';
}
export interface ObservationDependencies {
  readonly filesystem: Pick<ReadonlyFileSystem, 'lstat' | 'readlink'> & GuardedFileHasher;
  readonly uid: number;
  /** Discovery supplies credential identities without reading their bytes. */
  readonly forbiddenFileIdentities?: readonly Pick<FileMetadata, 'device' | 'inode'>[];
}
export interface LiveManifestFacts {
  readonly packageVersion: string;
  readonly adapter: string;
  readonly paseo: InstallationManifestV1['paseo'];
  readonly source: InstallationManifestV1['source'];
  /** Only provider entries; never pass whole unrelated daemon configuration. */
  readonly providers: Readonly<Record<string, unknown>>;
}
export interface OwnedStateObservation {
  readonly artifacts: readonly ArtifactObservation[];
  readonly providers: readonly ProviderObservation[];
  /** Stable field identifiers, no raw values or credential-bearing diagnostics. */
  readonly drift: readonly string[];
}

/** Retain the accepted immediate parent before leaf lstat can traverse a replacement. */
async function parentState(path: string, roomHome: string, deps: ObservationDependencies): Promise<'missing' | 'unsafe' | FileMetadata> {
  const parents: string[] = [];
  let cursor = dirname(path);
  for (;;) {
    parents.push(cursor);
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  let immediate: FileMetadata | undefined;
  for (const parent of parents.reverse()) {
    const metadata = await deps.filesystem.lstat(parent);
    if (!metadata) return 'missing';
    const managed = containsPath(roomHome, parent);
    if (metadata.kind !== 'directory' || (metadata.uid !== deps.uid && (managed || metadata.uid !== 0)) ||
        (managed ? (metadata.mode & 0o7077) !== 0 : (metadata.mode & 0o022) !== 0 && !(metadata.mode & 0o1000))) return 'unsafe';
    immediate = metadata;
  }
  return immediate ?? 'unsafe';
}
async function observeArtifact(artifact: ManifestArtifact, context: ManifestContext, deps: ObservationDependencies): Promise<ArtifactObservation> {
  const result = (state: OwnershipState): ArtifactObservation => ({ path: artifact.path, state });
  try {
    const parent = await parentState(artifact.path, context.roomHome, deps);
    if (typeof parent === 'string') return result(parent);
    const metadata = await deps.filesystem.lstat(artifact.path);
    if (!metadata) return result('missing');
    if (metadata.kind !== artifact.kind) return result('wrong-type');
    if (metadata.uid !== deps.uid) return result('unsafe');
    if (artifact.kind === 'symlink') {
      if (metadata.links !== 1) return result('unsafe');
      if ((metadata.mode & 0o7777) !== artifact.mode) return result('customized');
      // Deliberately no realpath, target lstat/readFile, or link-target hashing.
      return result(await deps.filesystem.readlink(artifact.path) === artifact.target ? 'unchanged' : 'customized');
    }
    if ((metadata.mode & 0o7077) !== 0) return result('unsafe');
    if (artifact.kind === 'file' && (metadata.links !== 1 || context.forbiddenFilePaths?.includes(artifact.path) ||
        deps.forbiddenFileIdentities?.some(identity => identity.device === metadata.device && identity.inode === metadata.inode))) return result('unsafe');
    if ((metadata.mode & 0o7777) !== artifact.mode) return result('customized');
    if (artifact.kind === 'directory') return result('unchanged'); // Never enumerate mutable children.
    return result(await deps.filesystem.hashFileNoFollow(artifact.path, parent, metadata, deps.forbiddenFileIdentities ?? []) === artifact.sha256 ? 'unchanged' : 'customized');
  } catch { return result('unsafe'); } // IO failures are not absence or ownership evidence.
}
function equal(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}
function factDrift(manifest: InstallationManifestV1, live: LiveManifestFacts): string[] {
  const drift: string[] = [];
  for (const field of ['packageVersion', 'adapter'] as const) if (!equal(manifest[field], live[field])) drift.push(field);
  for (const field of ['canonicalHome', 'canonicalConfigSha256', 'codexLaunchArgv', 'codexVersion'] as const) {
    if (!equal(manifest.source[field], live.source[field])) drift.push(`source.${field}`);
  }
  for (const field of ['localHome', 'listen', 'endpointIdentitySha256', 'cliVersion', 'daemonVersion', 'minimumVersion'] as const) {
    if (!equal(manifest.paseo[field], live.paseo[field])) drift.push(`paseo.${field}`);
  }
  try {
    if (normalizeListen(live.paseo.listen) !== live.paseo.listen || endpointIdentitySha256(live.paseo.localHome, live.paseo.listen) !== live.paseo.endpointIdentitySha256) {
      drift.push('paseo.endpointBinding');
    }
  } catch { drift.push('paseo.endpointBinding'); }
  return drift.sort();
}

/** Observe only recorded ownership, including a residual subset on repeated uninstall.
 * Missing residual items are discharged by the later planner; this never edits a
 * manifest or enumerates/deletes container children. Callers must serialize against
 * concurrent content mutation; cwd-anchored hashes reject changed parent/leaf identities before
 * reading, but do not provide a snapshot against writes to the same opened inode.
 */
export async function observeOwnedState(value: unknown, context: ManifestContext, live: LiveManifestFacts, deps: ObservationDependencies): Promise<OwnedStateObservation> {
  const manifest = validateManifest(value, context); // Fail before any filesystem access.
  const artifacts: ArtifactObservation[] = [];
  for (const artifact of manifest.artifacts) artifacts.push(await observeArtifact(artifact, context, deps));
  const providers: ProviderObservation[] = [];
  for (const id of MANAGED_PROVIDER_IDS) {
    const owned = manifest.providers[id];
    if (!owned) continue;
    providers.push({ id, state: !Object.hasOwn(live.providers, id) ? 'missing' : providerEntriesEqual(id, owned.applied, live.providers[id]) ? 'unchanged' : 'customized' });
  }
  return { artifacts, providers, drift: factDrift(manifest, live) };
}
