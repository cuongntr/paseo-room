import { isAbsolute, resolve, dirname } from 'node:path';
import { valid, gte } from 'semver';
import { z } from 'zod';
import type { ArtifactSpec } from '../adapters/contract.js';
import { validateCodexManifestBindings } from '../adapters/codex/manifest.js';
import { endpointIdentitySha256, normalizeListen } from '../paseo/cli-probe.js';
import { validateProviderEntry, type ProviderOverrideV1 } from '../paseo/provider-policy.js';
import { MANAGED_PROVIDER_IDS, type ManagedProviderId } from '../room/roles.js';
import { canonicalJson, canonicalJsonSha256, sha256 } from './hash.js';
import { containsPath, requireDisjointRoots } from './paths.js';

const path = z.string().refine(value => isAbsolute(value) && resolve(value) === value && value !== '/' && !/\p{Cc}/u.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine(value => valid(value) === value);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const launchPath = path.refine(value => !value.split('/').some(part => part === '_npx' || part === '_cacache'));
export const manifestArtifactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path, mode: z.literal(0o600), sha256: hash }),
  z.strictObject({ kind: z.literal('directory'), path, mode: z.literal(0o700) }),
  // Portable link mode declaration, never target metadata or target content.
  z.strictObject({ kind: z.literal('symlink'), path, mode: z.literal(0o777), target: path }),
]);
export type ManifestArtifact = z.infer<typeof manifestArtifactSchema>;
const providerRecord = z.strictObject({ prior: z.null(), applied: z.unknown(), appliedSha256: hash });
const schema = z.strictObject({
  schemaVersion: z.literal(1), packageVersion: version, installationId: identifier, lastTransactionId: identifier,
  status: z.enum(['committed', 'uninstall-incomplete']), adapter: z.literal('codex'),
  paseo: z.strictObject({ localHome: path, listen: z.string(), endpointIdentitySha256: hash,
    cliVersion: version, daemonVersion: version, minimumVersion: z.literal('0.8.0-beta.1') }),
  source: z.strictObject({ canonicalHome: path, canonicalConfigSha256: hash,
    codexLaunchArgv: z.tuple([launchPath], launchPath), codexVersion: version }),
  artifacts: z.array(manifestArtifactSchema),
  providers: z.strictObject({ 'codex-supervisor': providerRecord.optional(), 'codex-lead': providerRecord.optional(), 'codex-peer': providerRecord.optional() }),
  committedAt: z.iso.datetime({ offset: true }),
});
export interface ManifestProvider {
  readonly prior: null;
  readonly applied: ProviderOverrideV1;
  readonly appliedSha256: string;
}
export type InstallationManifestV1 = Omit<z.infer<typeof schema>, 'providers'> & {
  providers: Partial<Record<ManagedProviderId, ManifestProvider>>;
};
export interface ManifestContext {
  /** Canonical destination selected independently of the untrusted manifest. */
  readonly roomHome: string;
  /** Credential/other forbidden paths, including aliases known to discovery. */
  readonly forbiddenFilePaths?: readonly string[];
}
export class ManifestValidationError extends Error {
  constructor(reason: string) {
    super(`Cannot use installation manifest: ${reason}. Preserve it and run doctor; use a compatible package or explicitly reconcile ownership. Nothing was written.`);
  }
}
function validateArtifacts(artifacts: readonly ManifestArtifact[], context: ManifestContext): void {
  path.parse(context.roomHome);
  const seen = new Map<string, ManifestArtifact>();
  for (const artifact of artifacts) {
    if (!containsPath(context.roomHome, artifact.path)) throw new Error('artifact outside managed root');
    if (seen.has(artifact.path)) throw new Error('duplicate artifact path');
    if (artifact.path === context.roomHome && artifact.kind !== 'directory') throw new Error('managed root must be a directory');
    if (artifact.kind === 'file' && context.forbiddenFilePaths?.includes(artifact.path)) throw new Error('forbidden file declaration');
    seen.set(artifact.path, artifact);
  }
  for (const artifact of artifacts) {
    let parent = dirname(artifact.path);
    while (containsPath(context.roomHome, parent)) {
      const declared = seen.get(parent);
      if (declared && declared.kind !== 'directory') throw new Error('artifact has a non-directory parent');
      if (parent === context.roomHome) break;
      parent = dirname(parent);
    }
  }
}

/** Strict validation, with root and cross-field bindings; no filesystem access. */
export function validateManifest(value: unknown, context: ManifestContext): InstallationManifestV1 {
  try {
    canonicalJson(value); // Reject lossy JS inputs before schema parsing.
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion !== 1) {
      throw new ManifestValidationError('unsupported schema version; upgrade before retrying');
    }
    const parsed = schema.parse(value);
    validateArtifacts(parsed.artifacts, context);
    requireDisjointRoots(parsed.source.canonicalHome, context.roomHome);
    requireDisjointRoots(parsed.paseo.localHome, context.roomHome);
    const paseo = parsed.paseo;
    if (normalizeListen(paseo.listen) !== paseo.listen || endpointIdentitySha256(paseo.localHome, paseo.listen) !== paseo.endpointIdentitySha256 ||
        paseo.cliVersion !== paseo.daemonVersion || !gte(paseo.cliVersion, paseo.minimumVersion)) throw new Error('invalid endpoint/version binding');
    const providers: InstallationManifestV1['providers'] = {};
    for (const id of MANAGED_PROVIDER_IDS) {
      const record = parsed.providers[id];
      if (!record) {
        if (parsed.status === 'committed') throw new Error('committed provider missing');
        continue;
      }
      const applied = validateProviderEntry(id, record.applied);
      if (canonicalJsonSha256(applied) !== record.appliedSha256 || canonicalJson(applied.command) !== canonicalJson(parsed.source.codexLaunchArgv)) throw new Error('invalid provider binding');
      providers[id] = { prior: null, applied, appliedSha256: record.appliedSha256 };
    }
    const manifest = { ...parsed, artifacts: [...parsed.artifacts].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), providers };
    validateCodexManifestBindings(manifest, context.roomHome);
    return manifest;
  } catch (error) {
    if (error instanceof ManifestValidationError) throw error;
    throw new ManifestValidationError('malformed schema, paths, ownership or source/provider/endpoint binding');
  }
}

export function loadManifest(content: string | Uint8Array, context: ManifestContext): InstallationManifestV1 {
  let value: unknown;
  try {
    const text = typeof content === 'string' ? content : new TextDecoder('utf-8', { fatal: true }).decode(content);
    value = JSON.parse(text) as unknown;
  } catch { throw new ManifestValidationError('invalid UTF-8 or JSON'); }
  return validateManifest(value, context);
}

/** Build only authored declarations. No credential or link-target reads/hashes. */
export function buildManifestArtifacts(specs: readonly ArtifactSpec[], context: ManifestContext): ManifestArtifact[] {
  const artifacts = specs.map(spec => {
    if (spec.kind === 'file') {
      // Validate reserved destinations before hashing authored bytes, too.
      validateCodexManifestBindings({ artifacts: [{ kind: 'file', path: spec.path, mode: spec.mode, sha256: '0'.repeat(64) }], providers: {} }, context.roomHome);
      if (context.forbiddenFilePaths?.includes(spec.path)) throw new ManifestValidationError('forbidden file declaration');
      return manifestArtifactSchema.parse({ kind: spec.kind, path: spec.path, mode: spec.mode, sha256: sha256(spec.content) });
    }
    return manifestArtifactSchema.parse(spec.kind === 'symlink' ? { ...spec, mode: 0o777 } : spec);
  });
  validateArtifacts(artifacts, context);
  validateCodexManifestBindings({ artifacts, providers: {} }, context.roomHome);
  return artifacts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function buildManifestProviders(providers: Readonly<Partial<Record<ManagedProviderId, unknown>>>): InstallationManifestV1['providers'] {
  if (Object.keys(providers).some(id => !MANAGED_PROVIDER_IDS.some(managed => managed === id))) throw new ManifestValidationError('unknown managed provider');
  const result: InstallationManifestV1['providers'] = {};
  for (const id of MANAGED_PROVIDER_IDS) {
    if (!Object.hasOwn(providers, id)) continue;
    const applied = validateProviderEntry(id, providers[id]);
    result[id] = { prior: null, applied, appliedSha256: canonicalJsonSha256(applied) };
  }
  return result;
}
