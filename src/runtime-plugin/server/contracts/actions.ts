/**
 * Inputs of the Supervisor and Lead action tools (docs/design/runtime-coordination.md §3.4, D4).
 * Operation names come from the shared role-policy projection; this module only types payloads.
 */
import { z } from 'zod';
import { boundedArray, boundedString } from '../../shared/limits.js';
import type { LeadOperation, SupervisorOperation } from '../../shared/policy.js';
import { assignmentCreateSchema } from './assignment.js';

/** Runtime-minted assignment ids; never a Paseo agent id or a path. */
export const assignmentIdSchema = z.string().regex(/^asg_[A-Za-z0-9_-]{8,64}$/);
const reason = boundedString();
const assignment = { assignmentId: assignmentIdSchema };

export const SUPERVISOR_ACTION_SCHEMAS = {
  room_status: z.strictObject({}),
  runtime_findings: z.strictObject({}),
  // `project` names a project in the caller's portfolio: a runtime project id, the project key or
  // the repository's name. Omitted, it is the caller's own working project, or its only project.
  message_lead: z.strictObject({ message: boundedString(), project: z.string().min(1).max(4_096).optional() }),
  attention_feedback: z.strictObject({ id: z.string().regex(/^att_[A-Za-z0-9_-]{8,32}$/), verdict: z.enum(['useful', 'noise', 'unknown']) }),
} as const satisfies Record<SupervisorOperation, z.ZodType>;

export const LEAD_ACTION_SCHEMAS = {
  assignment_create: assignmentCreateSchema,
  // An eligible exact Peer provider id from the room manifest; the model is never selectable.
  // `worktree` asks the runtime for an isolated worktree; the default is Phase 1's shared
  // workspace. `serialOnly` names paths that admit one writer at a time, quoted from the
  // repository's own protocol (docs/design/runtime-coordination-phase2.md P2-D1, §5.3).
  assignment_dispatch: z.strictObject({
    ...assignment,
    peerProvider: z.string().min(1).max(128),
    isolation: z.enum(['lead-workspace', 'worktree']).optional(),
    serialOnly: boundedArray(boundedString()).optional(),
    // A thinking option the operator allows for that Peer provider, and why; omitted, the Peer
    // launches on its profile's option (docs/design/runtime-coordination-peer-effort.md E-D2).
    thinking: z.string().min(1).max(64).optional(),
    thinkingReason: boundedString(1024).optional(),
  }),
  assignment_answer: z.strictObject({ ...assignment, answer: boundedString() }),
  assignment_rework: z.strictObject({ ...assignment, instructions: boundedString() }),
  assignment_accept: z.strictObject({
    ...assignment,
    reason,
    // Required by the domain when the Peer gate or a required rerun is red; never a waiver of
    // a missing gate.
    override: z.strictObject({ reason, residualRiskAcknowledged: z.literal(true) }).optional(),
  }),
  assignment_reject: z.strictObject({ ...assignment, reason }),
  assignment_abandon: z.strictObject({ ...assignment, reason }),
  assignment_close: z.strictObject(assignment),
  assignment_status: z.strictObject({ assignmentId: assignmentIdSchema.optional() }),
  gate_run: z.strictObject(assignment),
  // Discarding a retained worktree's uncommitted work is Lead's explicit decision, with a reason.
  workspace_close: z.strictObject({ ...assignment, discardUncommitted: z.literal(true).optional(), reason: reason.optional() })
    .refine(input => input.discardUncommitted !== true || input.reason !== undefined, { message: 'discardUncommitted needs a reason', path: ['reason'] }),
  lease_reclaim: z.strictObject({ ...assignment, reason }),
} as const satisfies Record<LeadOperation, z.ZodType>;
