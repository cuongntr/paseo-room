/**
 * The attention log (docs/design/runtime-coordination-attention.md A-D8, §11).
 *
 * Incidents, letters, feedback and sensor assessments are low-stakes records: a lost or
 * duplicated line is not a safety fault. They are appended to one owner-only JSONL file per day
 * and pruned by whole file, never replayed as a ledger. Nothing secret is ever written here.
 */
import { appendFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensurePrivateDirectory } from '../store/publish.js';

export const LOG_RETENTION_DAYS = 30;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export type LogRecord =
  | { readonly type: 'incident.opened' | 'incident.updated' | 'incident.closed'; readonly id: string; readonly kind: string; readonly level: string; readonly projectKey: string; readonly subjects: readonly string[]; readonly count: number; readonly text?: string }
  | { readonly type: 'letter.held' | 'letter.sent' | 'letter.failed'; readonly id: string; readonly supervisorAgentId?: string; readonly level: string; readonly items: readonly string[]; readonly reason?: string }
  | { readonly type: 'lead-turn'; readonly id: string; readonly projectKey: string; readonly leadAgentId: string; readonly decision: string; readonly reason: string }
  | { readonly type: 'feedback.recorded'; readonly id: string; readonly verdict: 'useful' | 'noise' | 'unknown'; readonly by: string }
  | { readonly type: 'assessment.recorded'; readonly id: string; readonly questionSet: string; readonly model: string; readonly mode: string; readonly state: unknown; readonly answers: unknown; readonly decision: string; readonly baseline: string; readonly latencyMs: number; readonly inputTokens?: number };

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
    const line = `${JSON.stringify({ at: at.toISOString(), ...record })}\n`;
    await appendFile(join(this.directory, `${at.toISOString().slice(0, 10)}.jsonl`), line, { mode: 0o600 });
  }

  /** Deletes whole day files older than the retention window. */
  async prune(days = LOG_RETENTION_DAYS): Promise<number> {
    const cutoff = new Date(this.now().getTime() - days * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10);
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
