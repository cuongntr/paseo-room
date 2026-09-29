/**
 * Seat context budgets (docs/design/runtime-coordination-seat-context.md K-D2, §5.3). Shared by the
 * server, which applies them, and the Room seats screen, which edits them through Paseo's host
 * settings store. Marks are set in percent, because that is what the operator reasons in, and
 * converted to tokens against each seat's own model window, because every agent's knob is in tokens.
 */
import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';
import type { RuntimeAgent, RuntimeRole } from './policy.js';

/** A Lead replacement's id (K-D5): how its record is named, and what the panel and Supervisor tools take. */
export const SUCCESSION_ID = /^suc_[A-Za-z0-9_-]{16}$/;
export const successionIdSchema = z.string().regex(SUCCESSION_ID);

/** Claude Code's variable for the window its auto-compaction works against, in tokens. */
export const COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';

/**
 * The smallest mark applied, in tokens (K-D2, amended 2026-09-29). A mark that comes to less on a
 * seat's window does not apply to that seat: it keeps its agent's own compaction and is not
 * reported. 150k is above where a Lead starts (25–50k fresh, 88k for a successor that checked its
 * handoff) with room left to work, and above the 100k where Claude's `autoCompactWindow` values start.
 */
export const MIN_MARK_TOKENS = 150_000;

export const MIN_MARK_PERCENT = 10;
export const MAX_MARK_PERCENT = 95;

const mark = (value: number | null) => z.number().int().min(MIN_MARK_PERCENT).max(MAX_MARK_PERCENT).nullable().default(value);

export const seatContextSettingsSchema = z.object({
  budgets: z.object({
    lead: z.object({
      /** Advisory: past it, the Lead's Supervisor is told once (K-D6). */
      rotateAtPercent: mark(30),
      compactAtPercent: mark(50),
    }).refine(
      budget => budget.rotateAtPercent === null || budget.compactAtPercent === null || budget.rotateAtPercent < budget.compactAtPercent,
      { message: 'The rotation mark must be below the compact mark.' },
    ).prefault({}),
    supervisor: z.object({ compactAtPercent: mark(null) }).prefault({}),
    peer: z.object({ compactAtPercent: mark(null) }).prefault({}),
  }).prefault({}),
});

export type SeatContextSettings = z.output<typeof seatContextSettingsSchema>;

export const SEAT_CONTEXT_SETTINGS = defineSettings({ id: 'context', scope: 'host', version: 1, schema: seatContextSettingsSchema });

export const DEFAULT_SEAT_CONTEXT_SETTINGS: SeatContextSettings = seatContextSettingsSchema.parse({});

/**
 * The compact mark that reaches a seat, in percent: its role's, for a Claude seat, whose agent reads
 * `COMPACT_WINDOW_ENV`; null for any other agent, which keeps its own compaction (K-D3, §4.3).
 * Whether it applies on the seat's window is `markTokens`'s to say.
 */
export function compactMarkFor(settings: SeatContextSettings, seat: { readonly agent: RuntimeAgent; readonly role: RuntimeRole }): number | null {
  return seat.agent === 'claude' ? settings.budgets[seat.role].compactAtPercent : null;
}

/** A role's rotation mark in percent; only a Lead has one. Whether it applies on its window is `appliedMark`'s to say. */
export function rotateMark(settings: SeatContextSettings, role: RuntimeRole): number | null {
  return role === 'lead' ? settings.budgets.lead.rotateAtPercent : null;
}

/**
 * A mark in tokens on a window, rounded down to a thousand; undefined when the window is unknown or
 * the mark comes to less than `MIN_MARK_TOKENS` on it.
 */
export function markTokens(percent: number, windowTokens: number | undefined): number | undefined {
  if (windowTokens === undefined || !Number.isFinite(windowTokens) || windowTokens <= 0) return undefined;
  // Integer arithmetic first: (29 / 100) * 1,000,000 is 289,999.99… in floating point.
  const tokens = Math.floor((percent * windowTokens) / 100_000) * 1_000;
  return tokens < MIN_MARK_TOKENS ? undefined : tokens;
}

/** `mark` where it applies on a window of `windowTokens`, and null where it does not. */
export function appliedMark(mark: number | null, windowTokens: number | undefined): number | null {
  return mark !== null && markTokens(mark, windowTokens) !== undefined ? mark : null;
}

/** Used context as a whole percent, rounded down so a figure shown at a mark has reached it. */
export function contextPercent(used: number, max: number): number {
  return Math.floor((used * 100) / max);
}

/** A token count as people say it: 1M, 200k, 312k. */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 100_000 === 0) return `${String(tokens / 1_000_000)}M`;
  return `${String(Math.round(tokens / 1_000))}k`;
}
