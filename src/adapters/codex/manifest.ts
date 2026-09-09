import { basename, join } from 'node:path';
import type { ManifestArtifact, ManifestProvider } from '../../core/manifest.js';
import { containsPath } from '../../core/paths.js';
import { MANAGED_PROVIDER_IDS } from '../../room/roles.js';
import { SHARED_RESOURCES } from './runtime.js';

/** Adapter-specific destination and credential rules stay out of shared lifecycle code. */
export function validateCodexManifestBindings(manifest: {
  readonly artifacts: readonly ManifestArtifact[];
  readonly providers: Partial<Record<(typeof MANAGED_PROVIDER_IDS)[number], ManifestProvider>>;
  readonly source?: { readonly canonicalHome: string };
}, roomHome: string): void {
  for (const artifact of manifest.artifacts) {
    if (SHARED_RESOURCES.some(name => name === basename(artifact.path)) && artifact.kind !== 'symlink') {
      throw new Error('Shared Codex resources may only be declared as links, never owned bytes or directories.');
    }
    if (artifact.kind === 'symlink' && manifest.source &&
        (artifact.target === manifest.source.canonicalHome || !containsPath(manifest.source.canonicalHome, artifact.target))) {
      throw new Error('Codex shared links must target canonical source children.');
    }
  }
  for (const id of MANAGED_PROVIDER_IDS) {
    const provider = manifest.providers[id];
    if (provider && provider.applied.env.CODEX_HOME !== join(roomHome, 'roles/codex', id.slice('codex-'.length))) {
      throw new Error('Managed providers must bind to their isolated role homes.');
    }
  }
}
