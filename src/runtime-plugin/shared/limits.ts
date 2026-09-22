/**
 * Size bounds for every strict runtime input (docs/design/runtime-coordination.md §3.4, D6).
 * Measured in UTF-8 bytes, not UTF-16 code units, so a limit means the same on every side.
 */
import { z } from 'zod';

export const MAX_AGGREGATE_BYTES = 64 * 1024;
export const MAX_ARRAY_ITEMS = 64;
export const MAX_STRING_BYTES = 8 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_GATE_TIMEOUT_SECONDS = 3_600;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/** A string of 1 byte up to `max` UTF-8 bytes. */
export function boundedString(max = MAX_STRING_BYTES): z.ZodString {
  return z.string().refine(value => {
    const bytes = utf8Bytes(value);
    return bytes >= 1 && bytes <= max;
  }, { message: `must be 1 byte to ${String(max)} bytes of UTF-8` });
}

export function boundedArray<T extends z.ZodType>(item: T): z.ZodArray<T> {
  return z.array(item).max(MAX_ARRAY_ITEMS);
}

/** True when the JSON form of `value` fits the aggregate bound; non-serialisable input does not. */
export function withinAggregateLimit(value: unknown): boolean {
  try {
    // Typed as string, but undefined and functions serialise to undefined at run time.
    const json = JSON.stringify(value) as string | undefined;
    return json !== undefined && utf8Bytes(json) <= MAX_AGGREGATE_BYTES;
  } catch {
    return false;
  }
}
