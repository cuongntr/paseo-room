/**
 * The Paseo daemon hosting this plugin process (docs/design/runtime-coordination-phase2.md §8).
 *
 * Paseo forks each plugin process from a script inside its own `@getpaseo/server` package and
 * hands the plugin no version, so the version is read from that package. Anything else — a test
 * runner, a moved install, an unreadable manifest — is unknown, and worktree dispatch refuses.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function hostPaseoVersion(entry: string | undefined = process.argv[1]): string | undefined {
  if (entry === undefined) return undefined;
  let directory = dirname(entry);
  for (let depth = 0; depth < 12; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === '@getpaseo/server') return typeof manifest.version === 'string' ? manifest.version : undefined;
    } catch {
      // No readable manifest here; keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}
