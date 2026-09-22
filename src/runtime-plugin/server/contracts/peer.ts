/**
 * The Peer reporting tools, `ask` and `handoff` (docs/design/runtime-coordination.md §3.4).
 *
 * No schema here accepts a room, project, assignment, agent, parent, provider, model,
 * recipient, candidate or lifecycle identifier: the server derives every identity from its own
 * binding. The one `handoff` detail variant a Peer may use is chosen by the server from the
 * bound assignment's work kind; a Peer can neither choose nor change it.
 */
import { z } from 'zod';
import { boundedArray, boundedString, MAX_COMMAND_BYTES, withinAggregateLimit } from '../../shared/limits.js';
import type { PeerReportingTool } from '../../shared/policy.js';
import type { AssignmentKind } from './assignment.js';

const text = boundedString();
const texts = boundedArray(text);

export const verificationReportSchema = z.strictObject({
  command: boundedString(MAX_COMMAND_BYTES),
  outcome: z.enum(['passed', 'failed', 'not-run']),
  note: text.optional(),
});
export type VerificationReportV1 = z.infer<typeof verificationReportSchema>;

export const askInputSchema = z.strictObject({
  question: text,
  blockingContext: text,
  evidence: texts,
});
export type AskInputV1 = z.infer<typeof askInputSchema>;

export const HANDOFF_DETAILS = {
  engineer: z.strictObject({ kind: z.literal('engineer') }),
  architect: z.strictObject({
    kind: z.literal('architect'),
    alternatives: texts,
    strongestCounterargument: text,
    reversalConditions: texts,
    evidence: texts,
  }),
  reviewer: z.strictObject({
    kind: z.literal('reviewer'),
    findings: boundedArray(z.strictObject({ claim: text, evidence: texts })),
  }),
  scout: z.strictObject({
    kind: z.literal('scout'),
    evidence: texts,
    remainingUnknowns: texts,
    confidence: z.enum(['low', 'medium', 'high']),
  }),
} as const satisfies Record<AssignmentKind, z.ZodType>;

const handoffBase = {
  summary: text,
  deliverables: texts,
  verification: boundedArray(verificationReportSchema),
  residualRisks: texts,
  evidence: texts,
};

/** The strict `handoff` input for exactly one bound work kind. */
export function handoffInputSchema<K extends AssignmentKind>(kind: K) {
  return z.discriminatedUnion('completion', [
    z.strictObject({ ...handoffBase, completion: z.literal('blocked'), blocker: text }),
    z.strictObject({ ...handoffBase, completion: z.literal('partial'), blocker: text }),
    z.strictObject({ ...handoffBase, completion: z.literal('complete'), details: HANDOFF_DETAILS[kind] }),
  ]);
}
export type HandoffInputV1 = z.infer<ReturnType<typeof handoffInputSchema>>;

export const PEER_REPORT_ERROR_CODES = [
  'report_malformed', 'report_unauthorized', 'report_stale', 'report_conflict',
  'report_state', 'report_precondition', 'report_uncertain',
] as const;
export type PeerReportErrorCodeV1 = (typeof PEER_REPORT_ERROR_CODES)[number];

export const peerReportReceiptSchema = z.strictObject({
  schema: z.literal(1),
  receipt: z.string().min(1).max(128),
  tool: z.enum(['ask', 'handoff']),
  status: z.literal('accepted'),
  assignmentState: z.enum(['questioned', 'blocked', 'handed-back']),
});
export type PeerReportReceiptV1 = z.infer<typeof peerReportReceiptSchema>;

export const peerReportErrorSchema = z.strictObject({
  schema: z.literal(1),
  error: z.strictObject({
    code: z.enum(PEER_REPORT_ERROR_CODES),
    message: boundedString(1024),
    retryable: z.boolean(),
  }),
});
export type PeerReportErrorV1 = z.infer<typeof peerReportErrorSchema>;

export type PeerToolParse =
  | { readonly ok: true; readonly tool: 'ask'; readonly input: AskInputV1 }
  | { readonly ok: true; readonly tool: 'handoff'; readonly input: HandoffInputV1 }
  | { readonly ok: false; readonly message: string };

/**
 * Parses raw Peer tool input for the bound work kind. The aggregate bound is checked on the raw
 * value first, so an oversize payload is refused before any field is interpreted.
 */
export function parsePeerToolInput(tool: PeerReportingTool, kind: AssignmentKind, raw: unknown): PeerToolParse {
  if (!withinAggregateLimit(raw)) return { ok: false, message: 'Report exceeds the 64 KiB aggregate limit.' };
  if (tool === 'ask') {
    const parsed = askInputSchema.safeParse(raw);
    return parsed.success ? { ok: true, tool, input: parsed.data } : { ok: false, message: z.prettifyError(parsed.error) };
  }
  const parsed = handoffInputSchema(kind).safeParse(raw);
  return parsed.success ? { ok: true, tool, input: parsed.data } : { ok: false, message: z.prettifyError(parsed.error) };
}
