/**
 * Versioned envelopes for the runtime's plugin RPCs (docs/design/runtime-coordination.md §8.2).
 * Concrete read and mutation contracts are defined against these envelopes.
 */
import { z } from 'zod';
import { boundedString } from './limits.js';

export const runtimeWarningSchema = z.strictObject({
  code: z.string().min(1).max(64),
  message: boundedString(1024),
});
export type RuntimeWarningV1 = z.infer<typeof runtimeWarningSchema>;

export function runtimeRpcResponseSchema<T extends z.ZodType>(data: T) {
  return z.strictObject({
    schema: z.literal(1),
    revision: z.string().min(1).max(128),
    data,
    warnings: z.array(runtimeWarningSchema),
  });
}

export const runtimeRpcErrorSchema = z.strictObject({
  schema: z.literal(1),
  revision: z.string().min(1).max(128),
  error: z.strictObject({
    code: z.string().min(1).max(64),
    message: boundedString(1024),
    recoveryAction: boundedString(1024),
    retryable: z.boolean(),
  }),
  warnings: z.array(runtimeWarningSchema),
});
export type RuntimeRpcErrorV1 = z.infer<typeof runtimeRpcErrorSchema>;
