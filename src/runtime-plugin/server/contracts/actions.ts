/**
 * Inputs of the Supervisor and Lead action tools (docs/design/runtime-coordination.md §3.4, D4).
 * Operation names come from the shared role-policy projection; this module only types payloads.
 */
import { z } from 'zod';
import { boundedString } from '../../shared/limits.js';
import type { LeadOperation, SupervisorOperation } from '../../shared/policy.js';
import { assignmentCreateSchema } from './assignment.js';

/** Runtime-minted assignment ids; never a Paseo agent id or a path. */
export const assignmentIdSchema = z.string().regex(/^asg_[A-Za-z0-9_-]{8,64}$/);
const reason = boundedString();
const assignment = { assignmentId: assignmentIdSchema };

export const SUPERVISOR_ACTION_SCHEMAS = {
  room_status: z.strictObject({}),
  runtime_findings: z.strictObject({}),
  message_lead: z.strictObject({ message: boundedString() }),
} as const satisfies Record<SupervisorOperation, z.ZodType>;

export const LEAD_ACTION_SCHEMAS = {
  assignment_create: assignmentCreateSchema,
  // An eligible exact Peer provider id from the room manifest; the model is never selectable.
  assignment_dispatch: z.strictObject({ ...assignment, peerProvider: z.string().min(1).max(128) }),
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
} as const satisfies Record<LeadOperation, z.ZodType>;
