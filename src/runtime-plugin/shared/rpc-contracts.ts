/**
 * The runtime's plugin RPCs (docs/design/runtime-coordination.md §8.2). Shared by the server,
 * which answers them, and the panel, which is their only consumer. Inputs are strict; every
 * answer is a versioned envelope with a stable revision, or a versioned error naming a bounded
 * recovery action. Views are role-filtered on the server before they reach this contract.
 */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { boundedString } from './limits.js';
import { runtimeRpcErrorSchema, runtimeRpcResponseSchema } from './rpc.js';

const view = z.record(z.string(), z.unknown());
const projectId = z.uuid();
const assignmentId = z.string().regex(/^asg_[A-Za-z0-9_-]{8,64}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
const answer = <T extends z.ZodType>(data: T) => z.union([runtimeRpcResponseSchema(data), runtimeRpcErrorSchema]);

export const runtimeHealthRpc = defineRpc({
  name: 'runtime.health',
  input: z.strictObject({}),
  output: answer(z.strictObject({
    plugin: z.strictObject({ id: z.string(), manifest: z.enum(['ready', 'paused']), reason: z.string().optional() }),
    projects: z.array(z.strictObject({ projectId: z.string(), canonicalRoot: z.string(), health: z.string(), findings: z.number().int() })),
  })),
});

export const runtimeProjectRpc = defineRpc({
  name: 'runtime.project',
  input: z.strictObject({ projectId }),
  output: answer(view),
});

export const runtimeAssignmentRpc = defineRpc({
  name: 'runtime.assignment',
  input: z.strictObject({ projectId, assignmentId }),
  output: answer(view),
});

export const runtimeRecoverRpc = defineRpc({
  name: 'runtime.recover',
  input: z.strictObject({ projectId, idempotencyKey }),
  output: answer(z.strictObject({ actions: z.array(view) })),
});

export const runtimeAbandonRpc = defineRpc({
  name: 'runtime.abandon',
  input: z.strictObject({ projectId, assignmentId, reason: boundedString(), idempotencyKey }),
  output: answer(z.strictObject({ state: z.literal('abandoned') })),
});

export const runtimeResolveOwnershipRpc = defineRpc({
  name: 'runtime.resolve-ownership',
  input: z.strictObject({ projectId, keptLeadAgentId: z.string().min(1).max(128), idempotencyKey }),
  output: answer(z.strictObject({ resolved: z.literal(true) })),
});

export const runtimeQuarantineRpc = defineRpc({
  name: 'runtime.quarantine',
  input: z.strictObject({ projectId, file: z.string().regex(/^\d{12}\.json$/), idempotencyKey }),
  output: answer(z.strictObject({ quarantined: z.string() })),
});

export const RUNTIME_RPCS = [
  runtimeHealthRpc, runtimeProjectRpc, runtimeAssignmentRpc, runtimeRecoverRpc, runtimeAbandonRpc,
  runtimeResolveOwnershipRpc, runtimeQuarantineRpc,
] as const;
