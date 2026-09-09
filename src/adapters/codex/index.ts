import type { AgentAdapter } from '../contract.js';
import type { ReadonlyFileSystem } from '../../core/seams.js';
import { discoverCodex, type CodexDiscovery } from './discover.js';
import { buildCodexArtifacts, buildCodexProvider } from './runtime.js';
import { verifyCodexRuntime } from './verify.js';

/** Filesystem injection keeps artifact generation read-only without extending the shared contract. */
export function createCodexAdapter(filesystem: ReadonlyFileSystem): AgentAdapter<CodexDiscovery> {
  return { id: 'codex', discover: discoverCodex,
    buildArtifacts: input => buildCodexArtifacts(input, filesystem),
    buildProvider: buildCodexProvider, verifyRuntime: verifyCodexRuntime };
}
