import { basename, dirname } from 'node:path';
import type { VerifyRuntimeInput } from '../contract.js';
import type { CheckResult } from '../../core/result.js';
import { resolveManagedRoot } from '../../core/paths.js';
import type { CodexDiscovery } from './discover.js';
import { buildCodexArtifacts } from './runtime.js';

/** Exact declared-state checks. Extra Codex-created state remains unowned and unexamined. */
export async function verifyCodexRuntime(input: VerifyRuntimeInput<CodexDiscovery>): Promise<CheckResult[]> {
  const { filesystem } = input;
  const checks: CheckResult[] = [];
  try {
    const artifacts = await buildCodexArtifacts(input, filesystem);
    const authPath = input.discovery.sharedTargets['auth.json'];
    const auth = authPath ? await filesystem.lstat(authPath) : null;
    for (const artifact of artifacts) {
      let valid = false;
      try {
        await resolveManagedRoot(filesystem, dirname(artifact.path));
        const metadata = await filesystem.lstat(artifact.path);
        if (metadata?.kind === artifact.kind && metadata.uid === process.getuid?.()) {
          if (artifact.kind === 'symlink') {
            // Inspect only validated target metadata, never shared-resource bytes.
            await resolveManagedRoot(filesystem, dirname(artifact.target));
            const target = await filesystem.lstat(artifact.target);
            const directory = ['skills', 'plugins'].includes(basename(artifact.path));
            valid = await filesystem.readlink(artifact.path) === artifact.target &&
              target?.kind === (directory ? 'directory' : 'file') && target.uid === metadata.uid &&
              (directory || target.links === 1) &&
              (target.mode & (directory ? 0o500 : 0o400)) === (directory ? 0o500 : 0o400) &&
              await filesystem.realpath(artifact.target) === artifact.target;
          } else if ((metadata.mode & 0o7777) === artifact.mode) {
            if (artifact.kind === 'directory') valid = true;
            else if (metadata.links === 1 && auth && !(metadata.device === auth.device && metadata.inode === auth.inode)) {
              valid = Buffer.from(await filesystem.readFile(artifact.path)).equals(Buffer.from(artifact.content));
            }
          }
        }
      } catch { /* Fail closed without disclosing file content or filesystem errors. */ }
      checks.push({ id: `codex.artifact:${artifact.path}`, status: valid ? 'pass' : 'fail',
        message: valid ? 'Managed Codex artifact matches declaration.' : 'Managed Codex artifact is missing, unsafe, or differs from declaration.',
        ...(valid ? {} : { remediation: 'Inspect managed path, type, ownership, mode, content, and literal link target; preserve customized state.' }) });
    }
  } catch {
    checks.push({ id: 'codex.runtime', status: 'fail', message: 'Cannot establish expected Codex runtime.', remediation: 'Repeat read-only discovery and inspect canonical config compatibility and isolated role paths.' });
  }
  return checks;
}
