/**
 * Lead succession records and handoffs (docs/design/runtime-coordination-seat-context.md K-D5, K-D7).
 *
 * One small JSON record per succession, replaced whole as its steps advance, and the handoff text
 * beside it. Both are owner-only and stay on this machine: a handoff routinely names hosts and
 * procedures, so it is never masked, logged, exported or sent to the sensor. Records of finished
 * successions are pruned with the attention log; one that still waits to be finished is kept.
 */
import { randomBytes } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SUCCESSION_ID, successionIdSchema } from '../../shared/seat-context.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from '../store/publish.js';
import { LOG_RETENTION_DAYS } from './log.js';

export const SUCCESSION_STEPS = ['requested', 'received', 'archived', 'created', 'completed', 'cancelled', 'failed'] as const;
export const SUCCESSION_REASONS = ['context', 'contract', 'other'] as const;
export type SuccessionStep = (typeof SUCCESSION_STEPS)[number];
export type SuccessionReason = (typeof SUCCESSION_REASONS)[number];

/** Steps after which nothing more happens. */
export const TERMINAL_STEPS: readonly SuccessionStep[] = ['completed', 'cancelled', 'failed'];

const recordSchema = z.object({
  schema: z.literal(1),
  id: successionIdSchema,
  projectKey: z.string().min(1),
  root: z.string().min(1),
  name: z.string().min(1),
  fromAgentId: z.string().min(1),
  fromTitle: z.string().nullable(),
  provider: z.string().min(1),
  supervisorAgentId: z.string().min(1).nullable(),
  reason: z.enum(SUCCESSION_REASONS),
  /** Who asked for it; absent on a record made before K-D9, which only Human could start. */
  initiator: z.discriminatedUnion('role', [
    z.object({ role: z.literal('human') }),
    z.object({ role: z.literal('supervisor'), agentId: z.string().min(1) }),
  ]).optional(),
  note: z.string().optional(),
  step: z.enum(SUCCESSION_STEPS),
  toAgentId: z.string().min(1).optional(),
  receivedBytes: z.number().int().nonnegative().optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SuccessionRecord = Readonly<z.infer<typeof recordSchema>>;
export type SuccessionInitiator = NonNullable<SuccessionRecord['initiator']>;

export function successionId(): string {
  return `suc_${randomBytes(12).toString('base64url')}`;
}

export class SuccessionStore {
  constructor(readonly directory: string, private readonly now: () => Date = () => new Date()) {}

  static at(runtimeRoot: string, now?: () => Date): SuccessionStore {
    return new SuccessionStore(join(runtimeRoot, 'attention', 'successions'), now);
  }

  private path(id: string, suffix: '.json' | '.handoff.md'): string {
    if (!SUCCESSION_ID.test(id)) throw new Error(`${id} is not a succession id.`);
    return join(this.directory, `${id}${suffix}`);
  }

  /** Every readable record; a torn, foreign or unreadable file is skipped. */
  async list(): Promise<SuccessionRecord[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const records: SuccessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || !SUCCESSION_ID.test(name.slice(0, -'.json'.length))) continue;
      const read = await readFile(join(this.directory, name), 'utf8').then(text => JSON.parse(text) as unknown).catch(() => undefined);
      const parsed = recordSchema.safeParse(read);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  /** Writes the record whole, replacing the previous one atomically. */
  async save(record: SuccessionRecord): Promise<void> {
    await this.replace(this.path(record.id, '.json'), `${JSON.stringify(record)}\n`);
  }

  async writeHandoff(id: string, text: string): Promise<void> {
    await this.replace(this.path(id, '.handoff.md'), text);
  }

  async readHandoff(id: string): Promise<string | undefined> {
    return await readFile(this.path(id, '.handoff.md'), 'utf8').catch(() => undefined);
  }

  private async replace(path: string, content: string): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const temporary = `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
    await writeFile(temporary, content, { mode: PRIVATE_FILE_MODE });
    await rename(temporary, path);
  }

  /** Deletes finished successions, and their handoffs, not updated within the retention window. */
  async prune(days = LOG_RETENTION_DAYS): Promise<number> {
    const cutoff = this.now().getTime() - days * 24 * 60 * 60 * 1_000;
    let removed = 0;
    for (const record of await this.list()) {
      const updated = Date.parse(record.updatedAt);
      if (!TERMINAL_STEPS.includes(record.step) || Number.isNaN(updated) || updated >= cutoff) continue;
      await rm(this.path(record.id, '.handoff.md'), { force: true });
      await rm(this.path(record.id, '.json'), { force: true });
      removed += 1;
    }
    return removed;
  }
}
