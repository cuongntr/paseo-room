/**
 * The runtime's plugin RPCs (docs/design/runtime-coordination.md §8.2). Shared by the server,
 * which answers them, and the panel, which is their only consumer. Inputs are strict; every
 * answer is a versioned envelope with a stable revision, or a versioned error naming a bounded
 * recovery action. Views are role-filtered on the server before they reach this contract.
 */
import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { boundedString } from './limits.js';
import { RUNTIME_AGENTS, RUNTIME_ROLES } from './policy.js';
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

/** Human closes a retained worktree (Phase 2 delta P2-D7); discarding its work needs a reason. */
export const runtimeWorkspaceCloseRpc = defineRpc({
  name: 'runtime.workspace-close',
  input: z.strictObject({ projectId, assignmentId, discardUncommitted: z.literal(true).optional(), reason: boundedString().optional(), idempotencyKey })
    .refine(input => input.discardUncommitted !== true || input.reason !== undefined, { message: 'discardUncommitted needs a reason', path: ['reason'] }),
  output: answer(z.strictObject({ directoryRemoved: z.boolean() })),
});

/** Human reclaims a lease whose Peer cannot continue (Phase 2 delta P2-D6). */
export const runtimeLeaseReclaimRpc = defineRpc({
  name: 'runtime.lease-reclaim',
  input: z.strictObject({ projectId, assignmentId, reason: boundedString(), idempotencyKey }),
  output: answer(z.strictObject({ epoch: z.number().int(), agentId: z.string(), generation: z.number().int() })),
});

const seatAccount = z.strictObject({
  providerId: z.string().min(1).max(128),
  agent: z.enum(RUNTIME_AGENTS),
  role: z.enum(RUNTIME_ROLES),
  status: z.enum(['signed-in', 'signed-out', 'present', 'unknown']),
  method: z.string().max(200).optional(),
  email: z.string().max(200).optional(),
  plan: z.string().max(200).optional(),
  organization: z.string().max(200).optional(),
  shared: z.literal(true).optional(),
  note: z.string().max(1_000).optional(),
});

/** Which account each room seat is signed in to, from the seat's own vendor status command. */
export const runtimeSeatsRpc = defineRpc({
  name: 'runtime.seats',
  input: z.strictObject({}),
  output: answer(z.strictObject({ checkedAt: z.string(), seats: z.array(seatAccount) })),
});

export const RUNTIME_RPCS = [
  runtimeHealthRpc, runtimeProjectRpc, runtimeAssignmentRpc, runtimeRecoverRpc, runtimeAbandonRpc,
  runtimeResolveOwnershipRpc, runtimeQuarantineRpc, runtimeWorkspaceCloseRpc, runtimeLeaseReclaimRpc,
  runtimeSeatsRpc,
] as const;
