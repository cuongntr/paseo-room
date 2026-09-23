/**
 * Which account each room seat is signed in to, for the Room seats settings screen.
 *
 * Credentials stay the vendor's: the runtime never opens, copies or parses a credential file. It
 * asks the seat's own CLI for its status — `claude auth status`, `codex login status` — with that
 * seat's role home, exactly as Paseo would launch it, and keeps only the account fields below.
 * Pi has no status command, so for Pi it reports only whether a credential file exists. A provider
 * whose home is not this room's role home is reported, never queried.
 */
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeAgent, RuntimeRole } from '../shared/policy.js';
import type { ProviderCommand } from './paseo-port.js';

export const SEAT_STATUS_MS = 15_000;

/** The home variables each agent's launch sets; the first is the role home itself. */
const HOME_ENV: Readonly<Record<RuntimeAgent, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR', 'CLAUDE_SECURESTORAGE_CONFIG_DIR'],
  codex: ['CODEX_HOME'],
  pi: ['PI_CODING_AGENT_DIR'],
};

/** Credential files whose presence (never content) is reported. */
const CREDENTIAL_FILE: Readonly<Partial<Record<RuntimeAgent, string>>> = { codex: 'auth.json', pi: 'auth.json' };

export interface SeatProvider {
  readonly providerId: string;
  readonly agent: RuntimeAgent;
  readonly role: RuntimeRole;
}

export interface SeatAccount {
  readonly providerId: string;
  readonly agent: RuntimeAgent;
  readonly role: RuntimeRole;
  /** `present`: a credential file exists but the agent has no command to confirm it. */
  readonly status: 'signed-in' | 'signed-out' | 'present' | 'unknown';
  readonly method?: string;
  readonly email?: string;
  readonly plan?: string;
  readonly organization?: string;
  /** The credential is a link to another home — a legacy shared login. */
  readonly shared?: boolean;
  readonly note?: string;
}

export type RunStatus = (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{ readonly exitCode: number; readonly output: string }>;

export interface SeatDependencies {
  readonly roomHome: string;
  readonly command: (providerId: string) => Promise<ProviderCommand | undefined>;
  readonly run: RunStatus;
  readonly lstat: (path: string) => Promise<{ isSymbolicLink(): boolean } | undefined>;
}

/** Runs a status command without a shell, bounded in time and output. */
export const runStatus: RunStatus = (binary, args, env) => new Promise(resolve => {
  execFile(binary, [...args], { env, timeout: SEAT_STATUS_MS, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
    resolve({ exitCode: code, output: `${stdout}\n${stderr}` });
  });
});

export async function lstatOrUndefined(path: string): Promise<{ isSymbolicLink(): boolean } | undefined> {
  return await lstat(path).catch(() => undefined);
}

const text = (value: unknown, max = 200): string | undefined => (typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined);

function claudeAccount(output: string): Partial<SeatAccount> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output.slice(output.indexOf('{'), output.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    return { status: 'unknown', note: 'Claude did not report a readable status.' };
  }
  if (parsed.loggedIn !== true) return { status: 'signed-out' };
  const fields = { method: text(parsed.authMethod), email: text(parsed.email), plan: text(parsed.subscriptionType), organization: text(parsed.orgName) };
  return { status: 'signed-in', ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
}

/** Codex prints prose, and for an API key part of the key: keep only the method, never the text. */
function codexAccount(output: string): Partial<SeatAccount> {
  if (/not logged in/i.test(output)) return { status: 'signed-out' };
  if (/logged in using chatgpt/i.test(output)) return { status: 'signed-in', method: 'chatgpt' };
  if (/logged in using an? api key/i.test(output)) return { status: 'signed-in', method: 'api-key' };
  return { status: 'unknown', note: 'Codex did not report a recognised status.' };
}

async function seatAccount(deps: SeatDependencies, seat: SeatProvider): Promise<SeatAccount> {
  const base = { providerId: seat.providerId, agent: seat.agent, role: seat.role };
  const launch = await deps.command(seat.providerId).catch(() => undefined);
  const names = HOME_ENV[seat.agent];
  const home = launch?.env[names[0] as string];
  if (launch === undefined || home === undefined) return { ...base, status: 'unknown', note: 'Paseo has no launch entry for this provider.' };
  if (home !== join(deps.roomHome, 'roles', seat.agent, seat.role)) return { ...base, status: 'unknown', note: 'The provider home is not this room\'s role home; run paseo-room verify.' };

  const file = CREDENTIAL_FILE[seat.agent];
  const credential = file === undefined ? undefined : await deps.lstat(join(home, file));
  const shared = credential?.isSymbolicLink() === true ? { shared: true } : {};
  if (seat.agent === 'pi') {
    return credential === undefined ? { ...base, status: 'signed-out' } : { ...base, status: 'present', ...shared, note: 'Pi has no status command; only the file\'s presence is known.' };
  }

  // The seat's own homes, and never an operator value inherited from the daemon.
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !names.includes(name)));
  for (const name of names) {
    const value = launch.env[name];
    if (value !== undefined) env[name] = value;
  }
  const args = seat.agent === 'claude' ? ['auth', 'status'] : ['login', 'status'];
  const result = await deps.run(launch.binary, args, env);
  const account = seat.agent === 'claude' ? claudeAccount(result.output) : codexAccount(result.output);
  return { ...base, status: 'unknown', ...account, ...shared };
}

/** Every seat's account, queried in parallel; one seat's failure never hides another's answer. */
export async function readSeatAccounts(deps: SeatDependencies, seats: readonly SeatProvider[]): Promise<readonly SeatAccount[]> {
  return await Promise.all(seats.map(seat => seatAccount(deps, seat)));
}
