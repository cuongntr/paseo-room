/**
 * The independent runtime gate (docs/design/runtime-coordination.md D6).
 *
 * An explicitly requested rerun of the assignment's exact command against an already validated
 * candidate. It is enforced evidence about its own bounded process only: it never substitutes
 * for the Peer's verification and a pass is never acceptance. The process contract is fixed —
 * `/bin/sh -c`, its own process group, stdin closed, a versioned minimal environment, a digest
 * over all output and a bounded owner-only tail — and a result is published only once the
 * owned process group is known to be gone. A restart never signals a PID read back from state.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_COMMAND_BYTES, utf8Bytes } from '../shared/limits.js';
import type { CandidateRefV1 } from './contracts/assignment.js';
import { gateResultSchema, type GateResultV1 } from './events/schema.js';
import type { GitEvidence } from './git.js';
import { ensurePrivateDirectory, publishOnce } from './store/publish.js';

export const PROCESS_CONTRACT_VERSION = 1;
export const ENVIRONMENT_POLICY_VERSION = 1;
export const TAIL_BYTES = 64 * 1024;
export const TERMINATION_GRACE_MS = 5_000;

/** Environment-policy v1: start empty, copy only these, then mark the run as CI. Values are never persisted. */
const COPIED = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ'] as const;

export function gateEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of COPIED) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, CI: '1', PASEO_ROOM_GATE: '1' };
}

/** Best-effort masking of the retained tail only. The digest always covers the raw output. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /((?:token|secret|password|passwd|api[_-]?key|authorization|credential)[\w-]*\s*[=:]\s*)\S+/gi,
  /(bearer\s+)[\w.~+/-]+=*/gi,
  /\b(?:sk|ghp|gho|ghs|github_pat|xox[abp])[-_][\w-]{10,}/g,
];

export function maskTail(text: string): string {
  let masked = text;
  for (const pattern of SECRET_PATTERNS) masked = masked.replace(pattern, (...groups: unknown[]) => (typeof groups[1] === 'string' ? `${groups[1]}[masked]` : '[masked]'));
  return masked;
}

export interface GateRequest {
  readonly gateRunId: string;
  readonly assignmentId: string;
  readonly candidate: CandidateRefV1;
  readonly command: string;
  readonly timeoutSeconds: number;
  /** The assigned workspace directory. */
  readonly cwd: string;
  readonly gitCommonDir: string;
}

export type GateEvent =
  | { readonly type: 'gate.requested'; readonly data: { gateRunId: string; candidate: CandidateRefV1; command: string; timeoutSeconds: number; processContractVersion: 1; environmentPolicyVersion: 1 } }
  | { readonly type: 'gate.finished'; readonly data: { result: GateResultV1 } }
  | { readonly type: 'gate.uncertain'; readonly data: { gateRunId: string; reason: string } };

export interface GateDependencies {
  readonly git: GitEvidence;
  readonly gatesDirectory: string;
  /** Persists one event before the runner moves on; the runner never writes the ledger itself. */
  readonly publish: (event: GateEvent) => Promise<void>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly graceMs?: number;
}

export type GateOutcome =
  | { readonly status: 'refused'; readonly code: 'command-too-long' | 'timeout-invalid' | 'workspace-mismatch'; readonly message: string }
  | { readonly status: 'finished'; readonly result: GateResultV1 }
  | { readonly status: 'uncertain'; readonly reason: string };

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* already gone */ }
}

const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });

/** Waits until nothing in the group remains, escalating to SIGKILL after the grace period. */
async function reapGroup(pgid: number, graceMs: number): Promise<{ readonly terminal: boolean; readonly killed: boolean }> {
  const settle = async (ms: number): Promise<boolean> => {
    for (let waited = 0; waited <= ms; waited += 50) {
      if (!groupAlive(pgid)) return true;
      await delay(50);
    }
    return !groupAlive(pgid);
  };
  if (await settle(100)) return { terminal: true, killed: false };
  signalGroup(pgid, 'SIGTERM');
  if (await settle(graceMs)) return { terminal: true, killed: false };
  signalGroup(pgid, 'SIGKILL');
  return { terminal: await settle(1_000), killed: true };
}

export function gateRequestedData(request: GateRequest): Extract<GateEvent, { type: 'gate.requested' }>['data'] {
  return {
    gateRunId: request.gateRunId, candidate: request.candidate, command: request.command, timeoutSeconds: request.timeoutSeconds,
    processContractVersion: 1, environmentPolicyVersion: 1,
  };
}

function sidecarName(gateRunId: string): string {
  return `${gateRunId}.result.json`;
}

/**
 * Runs one gate. Workspace identity is proven before `gate.requested` is ever recorded. A caller
 * that has already proven the workspace and recorded the request itself — atomically with its
 * own checks — passes `alreadyRequested` so neither step happens twice.
 */
export async function runGate(request: GateRequest, deps: GateDependencies, options: { readonly alreadyRequested?: boolean } = {}): Promise<GateOutcome> {
  if (utf8Bytes(request.command) < 1 || utf8Bytes(request.command) > MAX_COMMAND_BYTES) {
    return { status: 'refused', code: 'command-too-long', message: `The gate command must be 1 byte to ${String(MAX_COMMAND_BYTES)} bytes.` };
  }
  if (!Number.isInteger(request.timeoutSeconds) || request.timeoutSeconds < 1 || request.timeoutSeconds > 3_600) {
    return { status: 'refused', code: 'timeout-invalid', message: 'The gate timeout must be a whole number of seconds from 1 to 3600.' };
  }
  const now = deps.now ?? (() => new Date());
  const graceMs = deps.graceMs ?? TERMINATION_GRACE_MS;
  if (options.alreadyRequested !== true) {
    const precondition = await deps.git.dispatchPrecondition(request.cwd, { gitCommonDir: request.gitCommonDir, baseCommit: request.candidate.commit });
    if (!precondition.ok) return { status: 'refused', code: 'workspace-mismatch', message: precondition.message };
    await deps.publish({ type: 'gate.requested', data: gateRequestedData(request) });
  }
  const root = (await deps.git.identity(request.cwd)).canonicalRoot;
  await ensurePrivateDirectory(deps.gatesDirectory);

  const startedAt = now().toISOString();
  const digest = createHash('sha256');
  let tail = Buffer.alloc(0);
  const child = spawn('/bin/sh', ['-c', request.command], {
    cwd: root, env: gateEnvironment(deps.environment ?? process.env), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const pgid = child.pid;
  if (pgid === undefined) {
    const reason = 'The gate process could not be started.';
    await deps.publish({ type: 'gate.uncertain', data: { gateRunId: request.gateRunId, reason } });
    return { status: 'uncertain', reason };
  }
  const collect = (chunk: Buffer): void => {
    digest.update(chunk);
    tail = Buffer.concat([tail, chunk]);
    if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  // Mutated from timer callbacks, so held in an object rather than narrowed locals.
  const deadline = { timedOut: false, escalated: false };
  const timer = setTimeout(() => {
    deadline.timedOut = true;
    signalGroup(pgid, 'SIGTERM');
    setTimeout(() => {
      if (groupAlive(pgid)) { deadline.escalated = true; signalGroup(pgid, 'SIGKILL'); }
    }, graceMs).unref();
  }, request.timeoutSeconds * 1_000);

  // A descendant can keep the output pipes open after the shell exits, so wait for `exit`,
  // then reap the group, and only then for the streams to drain.
  const streamsClosed = new Promise<void>(resolve => { child.once('close', () => { resolve(); }); });
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => { resolve({ code, signal }); });
  });
  clearTimeout(timer);
  // Descendants may outlive the shell; the result is published only once the group is gone.
  const reaped = await reapGroup(pgid, graceMs);
  const drained = reaped.terminal && await Promise.race([streamsClosed.then(() => true), delay(2_000).then(() => false)]);
  if (!reaped.terminal || !drained) {
    const reason = `Process group ${String(pgid)} did not terminate; the gate outcome is unknown.`;
    await deps.publish({ type: 'gate.uncertain', data: { gateRunId: request.gateRunId, reason } });
    return { status: 'uncertain', reason };
  }

  const attachment = `${request.gateRunId}.log`;
  await publishOnce(deps.gatesDirectory, attachment, maskTail(tail.toString('utf8')));
  const head = await deps.git.head(root).catch(() => undefined);
  const clean = await deps.git.isClean(root).catch(() => false);
  const termination: GateResultV1['termination'] = deadline.escalated || reaped.killed || exit.signal === 'SIGKILL' ? 'killed' : exit.signal !== null ? 'signaled' : 'exited';
  const result = gateResultSchema.parse({
    id: request.gateRunId,
    assignmentId: request.assignmentId,
    candidate: request.candidate,
    command: request.command,
    startedAt,
    finishedAt: now().toISOString(),
    ...(exit.code === null ? {} : { exitCode: exit.code }),
    ...(exit.signal === null ? {} : { signal: exit.signal }),
    timedOut: deadline.timedOut,
    termination,
    processContractVersion: 1,
    environmentPolicyVersion: 1,
    outputDigest: `sha256:${digest.digest('hex')}`,
    outputTailAttachment: attachment,
    workspaceMoved: head !== request.candidate.commit || !clean,
  });
  await publishOnce(deps.gatesDirectory, sidecarName(request.gateRunId), `${JSON.stringify(result)}\n`);
  await deps.publish({ type: 'gate.finished', data: { result } });
  return { status: 'finished', result };
}

/**
 * Settles a gate whose intent survived a restart. Only an atomically published sidecar is
 * evidence; a missing or unreadable one is uncertain. No process is ever signalled here.
 */
export async function recoverGate(gateRunId: string, gatesDirectory: string): Promise<GateOutcome> {
  let raw: string;
  try { raw = await readFile(join(gatesDirectory, sidecarName(gateRunId)), 'utf8'); } catch {
    return { status: 'uncertain', reason: 'The plugin restarted before the gate published a terminal result.' };
  }
  const parsed = gateResultSchema.safeParse(JSON.parse(raw));
  return parsed.success && parsed.data.id === gateRunId
    ? { status: 'finished', result: parsed.data }
    : { status: 'uncertain', reason: `The gate result sidecar is unreadable: ${parsed.success ? 'id mismatch' : z.prettifyError(parsed.error)}` };
}
