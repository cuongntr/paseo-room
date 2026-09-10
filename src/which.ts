import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Resolve a command to an absolute executable path on `searchPath`.
 *
 * Deliberately not canonicalised. Version managers point a stable name at a
 * versioned file — `~/.local/bin/claude` at `versions/2.1.267`, mise's
 * `node/latest` at `node/24.15.0` — and the resolved target is deleted by the
 * next upgrade. Providers store this path, so following the link would pin every
 * seat to a binary that stops existing.
 */
export async function which(command: string, searchPath: string): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(command)]
    : searchPath.split(delimiter).filter(Boolean).map(entry => join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return undefined;
}

export interface CommandOutput {
  readonly ok: boolean;
  readonly stdout: string;
}
/** Bounded, shell-free probe. Failures are reported, never thrown. */
export async function probe(executable: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CommandOutput> {
  try {
    const { stdout } = await run(executable, [...args], { env, timeout: 20_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}
