import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { valid, gte } from 'semver';
import { z } from 'zod';
import type { CheckResult } from '../core/result.js';
import type { ProcessRunner, ReadonlyFileSystem } from '../core/seams.js';

export class PaseoAdmissionError extends Error {
  readonly check: CheckResult;
  constructor(id: string, remediation: string) {
    super(remediation);
    this.check = { id: `paseo.${id}`, status: 'fail', message: 'Paseo local admission failed.', remediation };
  }
}
export function fail(id: string, remediation: string): never {
  throw new PaseoAdmissionError(id, remediation);
}
export function normalizeListen(input: string): string {
  // Reject URL parser's permissive IPv4 and path normalization aliases.
  const match = /^(?:(ws|wss):\/\/)?(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]+))?(\/(?:ws\/?)?)?$/.exec(input);
  if (!match) return fail('remote', 'Select a loopback WebSocket listen endpoint without credentials, query, or path.');
  const scheme = match[1] ?? 'ws';
  const port = Number(match[3] ?? (scheme === 'ws' ? 80 : 443));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('listen', 'Select a valid local listen port.');
  return `${scheme}://${match[2] === '[::1]' ? '[::1]' : '127.0.0.1'}:${String(port)}`;
}
export function endpointIdentitySha256(localHome: string, listen: string): string {
  return createHash('sha256').update(JSON.stringify([localHome, listen])).digest('hex');
}
const statusSchema = z.object({
  home: z.string().min(1), listen: z.string().min(1),
  localDaemon: z.enum(['running', 'stopped', 'stale_pid', 'unresponsive']),
  connectedDaemon: z.enum(['reachable', 'unreachable', 'not_probed', 'auth_required', 'auth_failed']),
  pid: z.number().int().positive().nullable(), owner: z.string().nullable(), hostname: z.string().nullable(),
  cliVersion: z.string(), daemonVersion: z.string().nullable(),
});
// Require endpoint evidence; never allow the CLI's config/sockPath fallback.
const pidSchema = z.strictObject({
  pid: z.number().int().positive(), uid: z.number().int().nonnegative(),
  hostname: z.string().min(1), listen: z.string().min(1),
  startedAt: z.string().optional(), desktopManaged: z.boolean().optional(), heartbeat: z.literal(true).optional(),
});
export interface LocalAdmission {
  readonly localHome: string;
  readonly listen: string;
  readonly endpointIdentitySha256: string;
  readonly cliVersion: string;
  readonly daemonVersion: string;
}
export interface ProbeInput {
  readonly executable: string;
  readonly localHome: string;
  readonly home: string;
  readonly paseoUrl?: string;
  readonly timeoutMs?: number;
}
export interface ProbeDependencies {
  readonly filesystem: ReadonlyFileSystem;
  readonly runner: ProcessRunner;
  readonly uid: number;
  readonly hostname: string;
  readonly platform?: NodeJS.Platform;
  /** Must inspect the live process, not just trust the PID file. */
  processUid(pid: number): Promise<number | null>;
}
export function timeoutValue(value = 5000): number {
  if (!Number.isInteger(value) || value < 1 || value > 30_000) fail('timeout', 'Use a timeout between 1 and 30000 ms.');
  return value;
}
export async function probePaseo(input: ProbeInput, deps: ProbeDependencies, password?: string): Promise<LocalAdmission> {
  try { return await probe(input, deps, password); }
  catch (error) {
    if (error instanceof PaseoAdmissionError) throw error;
    return fail('read', 'Check local Paseo filesystem permissions and process availability, then retry.');
  }
}
async function probe(input: ProbeInput, deps: ProbeDependencies, password: string | undefined): Promise<LocalAdmission> {
  const timeoutMs = timeoutValue(input.timeoutMs);
  const requestedListen = input.paseoUrl === undefined ? undefined : normalizeListen(input.paseoUrl);
  const fs = deps.filesystem;
  if (!isAbsolute(input.executable)) fail('missing', 'Select an installed absolute Paseo executable with --paseo-bin.');
  const binary = await fs.lstat(input.executable);
  if (!binary || binary.kind !== 'file' || binary.links !== 1 ||
      (binary.uid !== deps.uid && binary.uid !== 0) || (binary.mode & 0o7022) !== 0 || !(binary.mode & 0o111)) fail('missing', 'Install Paseo yourself and select its absolute executable.');
  if (resolve(input.executable) !== input.executable || await fs.realpath(input.executable) !== input.executable) {
    fail('launcher', 'Select a canonical Paseo executable without link aliases.');
  }
  const macosDesktopLauncher = (deps.platform ?? process.platform) === 'darwin' &&
    input.executable === '/Applications/Paseo.app/Contents/Resources/bin/paseo';
  let parent = dirname(input.executable);
  for (;;) {
    const metadata = await fs.lstat(parent);
    const ordinarySafe = metadata?.kind === 'directory' && (metadata.uid === deps.uid || metadata.uid === 0) &&
      ((metadata.mode & 0o022) === 0 || (metadata.mode & 0o1000) !== 0);
    let parentSafe = ordinarySafe;
    if (macosDesktopLauncher && parent === '/Applications' && metadata !== null && (metadata.mode & 0o022) !== 0) {
      try { parentSafe = metadata.kind === 'directory' && metadata.uid === 0 && await fs.realpath(parent) === parent; }
      catch { fail('launcher', 'Select Paseo under safe directory-only parents.'); }
    }
    if (!parentSafe) fail('launcher', 'Select Paseo under safe directory-only parents.');
    if (dirname(parent) === parent) break;
    parent = dirname(parent);
  }
  const launcher = Buffer.from(await fs.readFile(input.executable));
  const shebang = launcher.subarray(0, 256).toString('utf8').split('\n')[0];
  // The pinned npm distribution uses this fixed warning flag; never interpret
  // arbitrary env -S arguments or permit preload/inspect/eval options.
  const nodeArgs = shebang === '#!/usr/bin/env -S node --disable-warning=DEP0040' ? ['--disable-warning=DEP0040'] : [];
  const nodeScript = shebang === '#!/usr/bin/env node' || nodeArgs.length > 0;
  // The Desktop bundle uses one fixed shell launcher; no other shell wrapper is accepted.
  const desktopScript = macosDesktopLauncher && shebang === '#!/bin/sh';
  const native = ['7f454c46', 'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(launcher.subarray(0, 4).toString('hex'));
  if (!nodeScript && !native && !desktopScript) {
    fail('launcher', 'Select a native Paseo executable or a supported fixed launcher.');
  }
  if (!isAbsolute(input.localHome) || resolve(input.localHome) !== input.localHome) fail('home', 'Select an existing canonical absolute Paseo home.');
  let cursor = input.localHome;
  for (;;) {
    const metadata = await fs.lstat(cursor);
    if (metadata?.kind !== 'directory' || (metadata.uid !== deps.uid && metadata.uid !== 0) ||
        (metadata.mode & 0o022) !== 0 && !(metadata.mode & 0o1000)) fail('home', 'Use safe directory-only Paseo home parents without links or foreign ownership.');
    if (cursor === input.localHome && metadata.uid !== deps.uid) fail('owner', 'Use a Paseo home owned by the current user.');
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  if (await fs.realpath(input.localHome) !== input.localHome) fail('home', 'Use the canonical Paseo home without aliases.');
  // Status creates missing identities and resolves a network target before returning JSON.
  // Validate every file before reading any identity, and never create or repair state.
  for (const name of ['server-id', 'cli-client-id', 'paseo.pid', 'config.json']) {
    const metadata = await fs.lstat(join(input.localHome, name));
    if (!metadata || metadata.kind !== 'file' || metadata.links !== 1 || metadata.uid !== deps.uid || (metadata.mode & 0o022) !== 0 || (name !== 'paseo.pid' && (metadata.mode & 0o7777) !== 0o600)) {
      fail('home', 'Initialize/start Paseo yourself; its existing identity, config and PID files must be safe current-user regular files.');
    }
  }
  for (const name of ['server-id', 'cli-client-id']) {
    if (!Buffer.from(await fs.readFile(join(input.localHome, name))).toString('utf8').trim()) {
      fail('home', 'Initialize Paseo identities yourself before probing; empty identities would be regenerated by status.');
    }
  }
  let pidBytes: unknown;
  try { pidBytes = JSON.parse(Buffer.from(await fs.readFile(join(input.localHome, 'paseo.pid'))).toString('utf8')); }
  catch { fail('pid', 'Use an existing valid Paseo PID file; initialize/start Paseo yourself.'); }
  const pidResult = pidSchema.safeParse(pidBytes);
  if (!pidResult.success) fail('pid', 'Paseo PID evidence must contain a valid PID, UID, hostname, and listen endpoint.');
  const evidence = pidResult.data;
  const persistedListen = normalizeListen(evidence.listen);
  if (requestedListen !== undefined && requestedListen !== persistedListen) fail('listen', '--paseo-url must match the persisted local daemon listen endpoint.');
  if (evidence.uid !== deps.uid || evidence.hostname !== deps.hostname || await deps.processUid(evidence.pid) !== deps.uid) {
    fail('owner', 'Select a running local daemon whose persisted PID and owner belong to the current user and host.');
  }
  const env = { HOME: input.home, PASEO_HOME: input.localHome, PATH: desktopScript ? '/usr/bin:/bin' : '/dev/null',
    ...(password === undefined ? {} : { PASEO_PASSWORD: password }) };
  let output: Awaited<ReturnType<ProcessRunner['run']>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      output = await deps.runner.run({ executable: nodeScript ? process.execPath : input.executable, args: [...(nodeScript ? [...nodeArgs, input.executable] : []), 'daemon', 'status', '--json'], env, shell: false, timeoutMs });
      break;
    } catch (error) {
      const transient = error instanceof Error && 'code' in error && ['EAGAIN', 'EINTR', 'ETIMEDOUT'].includes(String(error.code));
      if (!transient || attempt === 1) fail('read', 'Paseo status could not complete; check executable availability and timeout.');
    }
  }
  if (!output || output.exitCode !== 0) fail('read', 'Paseo status failed; run daemon status yourself to diagnose.');
  let parsed: unknown;
  try { parsed = JSON.parse(output.stdout); } catch { fail('status', 'Paseo status must return one valid JSON document.'); }
  const result = statusSchema.safeParse(parsed);
  if (!result.success) fail('status', 'Paseo status has missing or invalid required fields; use a supported CLI.');
  const status = result.data;
  if (status.home !== input.localHome) fail('home', 'Selected Paseo status home differs from the canonical local home.');
  const listen = normalizeListen(status.listen);
  if (listen !== persistedListen) fail('listen', 'Paseo status listen differs from the preflight PID endpoint.');
  if (status.pid !== evidence.pid || status.hostname !== evidence.hostname || status.owner !== `${String(evidence.uid)}@${evidence.hostname}`) {
    fail('owner', 'Paseo status PID, owner, or hostname differs from preflight evidence.');
  }
  if (status.connectedDaemon === 'auth_required' || status.connectedDaemon === 'auth_failed') fail(status.connectedDaemon, 'Authenticate Paseo yourself; check PASEO_PASSWORD and retry.');
  if (status.localDaemon === 'stopped' || status.localDaemon === 'stale_pid') fail('stopped', 'Start the selected local Paseo daemon yourself.');
  if (status.localDaemon !== 'running' || status.connectedDaemon !== 'reachable') fail('unreachable', 'Check the selected local daemon is running and reachable.');
  if (!status.pid || status.hostname !== deps.hostname || status.owner !== `${String(deps.uid)}@${deps.hostname}` || await deps.processUid(status.pid) !== deps.uid) fail('owner', 'Select a running local daemon whose PID and owner belong to the current user and host.');
  const cliVersion = valid(status.cliVersion);
  const daemonVersion = status.daemonVersion === null ? null : valid(status.daemonVersion);
  if (!cliVersion || !daemonVersion) fail('version', 'Use valid semver CLI and daemon versions.');
  if (cliVersion !== daemonVersion) fail('version_mismatch', 'Restart/upgrade Paseo yourself so CLI and daemon versions are identical.');
  if (!gte(cliVersion, '0.8.0-beta.1')) fail('old', 'Upgrade Paseo yourself to at least 0.8.0-beta.1.');
  return { localHome: input.localHome, listen, endpointIdentitySha256: endpointIdentitySha256(input.localHome, listen), cliVersion, daemonVersion };
}
