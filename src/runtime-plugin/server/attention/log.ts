/**
 * The attention log (docs/design/runtime-coordination-attention.md A-D8, §11).
 *
 * Incidents, letters, feedback and Lead turns are low-stakes records: a lost or
 * duplicated line is not a safety fault. They are appended to one owner-only JSONL file per day
 * and pruned by whole file, never replayed as a ledger. Nothing secret is ever written here.
 */
import { appendFile, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LetterTally } from '../../shared/panel.js';
import { ensurePrivateDirectory } from '../store/publish.js';

export const LOG_RETENTION_DAYS = 30;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** A day file larger than this is not read back for the panel's tally; the tally says so. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1_000;
/** The head `append` writes on every line: its time, then its type. */
const LINE_HEAD = /^\{"at":"([^"]+)","type":"([^"]+)"/;
/** The record types a letter tally counts. */
export const TALLIED: ReadonlySet<LogRecord['type']> = new Set(['letter.sent', 'letter.failed', 'incident.opened', 'lead-turn', 'feedback.recorded']);

export type LogRecord =
  | { readonly type: 'incident.opened' | 'incident.updated' | 'incident.closed'; readonly id: string; readonly kind: string; readonly level: string; readonly projectKey: string; readonly subjects: readonly string[]; readonly count: number; readonly text?: string }
  | { readonly type: 'letter.held' | 'letter.sent' | 'letter.failed'; readonly id: string; readonly supervisorAgentId?: string; readonly level: string; readonly items: readonly string[]; readonly reason?: string;
    /** A sent letter's item lines, already masked, for the panel's Supervisor view. */
    readonly lines?: readonly string[] }
  | { readonly type: 'lead-turn'; readonly id: string; readonly projectKey: string; readonly leadAgentId: string; readonly decision: string; readonly reason: string }
  | { readonly type: 'feedback.recorded'; readonly id: string; readonly verdict: 'useful' | 'noise' | 'unknown'; readonly by: string }
  /** A Lead succession's step (seat context delta §5.4); never its handoff text. */
  | {
    readonly type: `succession.${'started' | 'handoff-received' | 'archived' | 'created' | 'delivered' | 'completed' | 'cancelled' | 'failed'}`;
    readonly successionId: string; readonly projectKey: string; readonly fromAgentId: string; readonly toAgentId?: string;
    readonly reason: string; readonly step: string; readonly bytes?: number; readonly code?: string;
  };

const bump = (counts: Record<string, number>, key: string): void => { counts[key] = (counts[key] ?? 0) + 1; };

/** Counts letters, incidents, Lead turn decisions and feedback among `records`. */
export function tallyLetters(records: readonly LogRecord[], hours: number, partial = false): LetterTally {
  const sent: Record<string, number> = {};
  const leadTurns: Record<string, number> = {};
  const verdicts = new Map<string, string>();
  let failed = 0;
  let incidents = 0;
  for (const record of records) {
    if (record.type === 'letter.sent') bump(sent, record.level);
    else if (record.type === 'letter.failed') failed += 1;
    else if (record.type === 'incident.opened') incidents += 1;
    else if (record.type === 'lead-turn') bump(leadTurns, record.decision);
    else if (record.type === 'feedback.recorded') verdicts.set(record.id, record.verdict);
  }
  const rated = [...verdicts.values()];
  return {
    hours, sent, failed, incidents, leadTurns,
    useful: rated.filter(verdict => verdict === 'useful').length, noise: rated.filter(verdict => verdict === 'noise').length,
    ...(partial ? { partial: true as const } : {}),
  };
}

export class AttentionLog {
  private ready: Promise<void> | undefined;

  constructor(readonly directory: string, private readonly now: () => Date = () => new Date()) {}

  static at(runtimeRoot: string, now?: () => Date): AttentionLog {
    return new AttentionLog(join(runtimeRoot, 'attention', 'log'), now);
  }

  /** Appends one record; a failure is reported to the caller's log, never thrown into delivery. */
  async append(record: LogRecord): Promise<void> {
    this.ready ??= ensurePrivateDirectory(this.directory);
    await this.ready;
    const at = this.now();
    // Time, then type, lead every line, whatever order the caller built the record in: `recent` reads them from there.
    const { type, ...rest } = record;
    const line = `${JSON.stringify({ at: at.toISOString(), type, ...rest })}\n`;
    await appendFile(join(this.directory, `${at.toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 });
  }

  /**
   * The records of the last `hours` whose type is in `types`, oldest first; unreadable lines are
   * skipped. A line's time and type are read from its head, as `append` writes it, so a large
   * record of another type is never parsed.
   */
  async recent(hours: number, types: ReadonlySet<LogRecord['type']>): Promise<{ readonly records: LogRecord[]; readonly partial: boolean }> {
    const now = this.now().getTime();
    const from = new Date(now - hours * 60 * 60 * 1_000).toISOString();
    const days = new Set<string>();
    for (let at = Date.parse(from.slice(0, 10)); at <= now; at += DAY_MS) days.add(new Date(at).toISOString().slice(0, 10));
    const records: LogRecord[] = [];
    let partial = false;
    for (const day of [...days].sort()) {
      const file = join(this.directory, `${day}.jsonl`);
      const size = (await stat(file).catch(() => undefined))?.size;
      if (size === undefined) continue;
      if (size > MAX_READ_BYTES) { partial = true; continue; }
      for (const line of (await readFile(file, 'utf8').catch(() => '')).split('\n')) {
        const head = LINE_HEAD.exec(line);
        if (head === null || (head[1] ?? '') < from || !types.has(head[2] as LogRecord['type'])) continue;
        try {
          const record = JSON.parse(line) as LogRecord & { readonly at?: unknown };
          if (typeof record.at === 'string' && record.at >= from) records.push(record);
        } catch {
          // A torn last line from a crash is not a fault here.
        }
      }
    }
    return { records, partial };
  }

  /** Deletes whole day files older than the retention window. */
  async prune(days = LOG_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(this.now().getTime() - days * DAY_MS).toISOString().slice(0, 10);
    const names = await readdir(this.directory).catch(() => [] as string[]);
    let removed = 0;
    for (const name of names) {
      const day = DAY_FILE.exec(name)?.[1];
      if (day !== undefined && day < cutoff) {
        await rm(join(this.directory, name), { force: true });
        removed += 1;
      }
    }
    return removed;
  }
}
