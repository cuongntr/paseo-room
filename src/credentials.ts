import { lstat, readlink } from 'node:fs/promises';
import { warn, type Check } from './result.js';

export type CredentialPathState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file' }
  | { readonly kind: 'symlink'; readonly target: string }
  | { readonly kind: 'unsafe'; readonly fileType: string };

export interface CredentialDiagnostic {
  /** Credential paths are diagnostic-only and must never become managed entries. */
  readonly path: string;
  readonly checks: readonly Check[];
}

function fileType(stat: Awaited<ReturnType<typeof lstat>>): string {
  if (stat.isDirectory()) return 'directory';
  if (stat.isSocket()) return 'socket';
  if (stat.isFIFO()) return 'FIFO';
  if (stat.isCharacterDevice()) return 'character device';
  if (stat.isBlockDevice()) return 'block device';
  return 'unsupported file type';
}

/** Inspect only path metadata. Credential contents and link targets are never followed. */
export async function inspectCredentialPath(path: string): Promise<CredentialPathState> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unsafe', fileType: 'uninspectable path' };
  }
  if (stat.isFile()) return { kind: 'file' };
  if (!stat.isSymbolicLink()) return { kind: 'unsafe', fileType: fileType(stat) };
  try {
    return { kind: 'symlink', target: await readlink(path) };
  } catch {
    return { kind: 'unsafe', fileType: 'unreadable symbolic link' };
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function roleCommand(
  environment: Readonly<Record<string, string>>,
  executable: string,
  args: readonly string[] = [],
): string {
  const variables = Object.entries(environment).map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...variables, ...[executable, ...args].map(shellQuote)].join(' ');
}

export interface PreservedCredentialInput {
  readonly id: string;
  readonly agent: string;
  readonly role: string;
  readonly path: string;
  readonly state: Exclude<CredentialPathState, { readonly kind: 'missing' }>;
  readonly login: string;
  readonly status?: string;
}

/** Produce migration diagnostics for an existing path without claiming authentication. */
export function preservedCredentialCheck(input: PreservedCredentialInput): Check {
  const status = input.status ? ` Check status with: ${input.status}.` : '';
  if (input.state.kind === 'file') {
    return warn(`${input.id}.diverged-file-preserve`,
      `${input.agent} ${input.role} auth: configured structurally (diverged-file-preserve); a role-owned credential file exists at ${input.path} and is preserved. Token validity and freshness were not checked.`,
      `If authentication fails, close that role and authenticate it again with: ${input.login}.${status}`);
  }
  if (input.state.kind === 'symlink') {
    return warn(`${input.id}.legacy-shared-risk`,
      `${input.agent} ${input.role} auth: legacy-shared-risk; a credential symlink at ${input.path} -> ${input.state.target} is preserved. Its target was not inspected, followed, or changed.`,
      `Close that role. Remove only the legacy link with: rm -- ${shellQuote(input.path)}. Then create role-owned credentials with: ${input.login}.${status}`);
  }
  return warn(`${input.id}.manual-recovery`,
    `${input.agent} ${input.role} auth: diverged-file-preserve/manual-recovery; ${input.path} is a ${input.state.fileType}, not a credential file. It is preserved without inspection.`,
    `Close that role and inspect the path metadata yourself. Move or remove it manually only when safe, then authenticate with: ${input.login}.${status}`);
}

export function presentNames(names: ReadonlySet<string>, supported: readonly string[]): string[] {
  return supported.filter(name => names.has(name));
}

export function configuredByNamesCheck(id: string, agent: string, role: string, names: readonly string[]): Check {
  return warn(`${id}.configured-structurally`,
    `${agent} ${role} auth: configured structurally; ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} present by name. Values, token validity, and freshness were not checked.`);
}

export function ambientNamesCheck(id: string, agent: string, role: string, names: readonly string[]): Check {
  return warn(`${id}.ambient-auth-unverifiable`,
    `${agent} ${role} auth: ambient auth unverifiable; ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} present by name in the setup process. paseo-room does not copy credential values into providers, so availability to the Paseo-launched role, token validity, and freshness were not checked.`);
}
