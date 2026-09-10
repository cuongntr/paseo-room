import { execFile } from 'node:child_process';
import { access, constants, realpath } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Resolve a command to an absolute, executable, canonical path on `searchPath`. */
export async function which(command: string, searchPath: string): Promise<string | undefined> {
  const candidates = isAbsolute(command) || command.includes('/')
    ? [resolve(command)]
    : searchPath.split(delimiter).filter(Boolean).map(entry => join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
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
