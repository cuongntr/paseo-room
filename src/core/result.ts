import { z } from 'zod';
import { commandSchema } from './intent.js';
import { managedProviderIdSchema } from '../room/roles.js';

const text = z.string().min(1);
export const checkResultSchema = z.strictObject({
  id: text,
  status: z.enum(['pass', 'warn', 'fail', 'not-checked']),
  message: text,
  remediation: text.optional(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

/** Metadata only: never include file contents, environment values, or credentials. */
export const plannedOperationSchema = z.strictObject({
  action: z.enum(['create', 'update', 'remove', 'noop']),
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.enum(['file', 'symlink', 'directory']), path: text }),
    z.strictObject({ kind: z.literal('provider'), id: managedProviderIdSchema }),
  ]),
  description: text,
});
export type PlannedOperation = z.infer<typeof plannedOperationSchema>;
export const OUTCOMES = ['ok', 'changes-planned', 'conflict', 'failed', 'recovery-required'] as const;
export const commandResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  command: commandSchema,
  outcome: z.enum(OUTCOMES),
  changed: z.boolean(),
  checks: z.array(checkResultSchema),
  operations: z.array(plannedOperationSchema),
}).refine((result) => !result.changed || !['plan', 'verify', 'doctor'].includes(result.command), {
  message: 'Read-only commands cannot report mutations', path: ['changed'],
}).refine((result) => result.outcome !== 'changes-planned' || !result.changed, {
  message: 'A dry-run cannot report mutations', path: ['changed'],
});
export type CommandResult = z.infer<typeof commandResultSchema>;
