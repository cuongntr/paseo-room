/**
 * The closed runtime event union (docs/design/runtime-coordination.md §4.2).
 *
 * Writers can emit only a declared `type` at its declared `payloadVersion`, with a strict
 * payload. Readers keep strict envelopes but ignore unknown additive fields at the top level of
 * a supported payload, and refuse an unknown type or an unsupported payload version — which
 * pauses that project rather than reading it as empty. A breaking payload change adds a new
 * payload version beside the old reader; it never edits a v1 shape in place.
 */
import { z } from 'zod';
import { boundedString, MAX_COMMAND_BYTES } from '../../shared/limits.js';
import { PEER_REPORTING_TOOLS, RUNTIME_ROLES } from '../../shared/policy.js';
import { assignmentIdSchema } from '../contracts/actions.js';
import { assignmentCreateSchema, candidateRefSchema, commitSchema, gateSpecSchema } from '../contracts/assignment.js';
import { PEER_REPORT_ERROR_CODES, peerReportReceiptSchema } from '../contracts/peer.js';

export const EVENT_SCHEMA = 'paseo-room.runtime-event';

const id = z.string().min(1).max(128);
const text = boundedString();
const reason = boundedString(1024);
const generation = z.number().int().min(1);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ offset: true });

export const gateResultSchema = z.strictObject({
  id,
  assignmentId: assignmentIdSchema,
  candidate: candidateRefSchema,
  command: boundedString(MAX_COMMAND_BYTES),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  exitCode: z.number().int().optional(),
  signal: z.string().min(1).max(32).optional(),
  timedOut: z.boolean(),
  termination: z.enum(['exited', 'signaled', 'killed', 'uncertain']),
  processContractVersion: z.literal(1),
  environmentPolicyVersion: z.literal(1),
  outputDigest: digest,
  outputTailAttachment: z.string().min(1).max(256).optional(),
  workspaceMoved: z.boolean(),
});
export type GateResultV1 = z.infer<typeof gateResultSchema>;

export const NOTICE_DISPOSITIONS = ['record', 'panel', 'lead-now', 'supervisor-digest', 'supervisor-now', 'operator-now', 'human-required'] as const;
export const NOTICE_CLASSES = ['record', 'owner', 'operator', 'page'] as const;

/**
 * Every Phase 1 payload, as a raw shape. Intent/result pairs share one `intentId` so replay can
 * find an intent that never reached a terminal result.
 */
export const EVENT_PAYLOADS = {
  // Project binding and Lead ownership (§4.1, §5.2).
  'project.bound': { canonicalRoot: z.string().min(1), gitCommonDir: z.string().min(1) },
  'project.rebound': { canonicalRoot: z.string().min(1), gitCommonDir: z.string().min(1), previousRoot: z.string().min(1) },
  'project.ownership-conflict': { leadAgentIds: z.array(id).min(2), leadProviderIds: z.array(id).min(1) },
  'project.ownership-resolved': { keptLeadAgentId: id, decidedBy: z.enum(['evidence', 'human']) },

  // Assignment lifecycle decided by Lead or Human (§5.1).
  'assignment.created': { input: assignmentCreateSchema, leadAgentId: id, leadProviderId: id },
  'assignment.dispatch-requested': { peerProviderId: id, workspaceId: id },
  'assignment.answered': { answer: text },
  'assignment.rework-requested': { instructions: text },
  'assignment.accepted': {
    candidate: candidateRefSchema.optional(),
    inspectedCommit: commitSchema.optional(),
    reason,
    override: z.strictObject({ reason, residualRiskAcknowledged: z.literal(true) }).optional(),
    gateResultId: id.optional(),
  },
  'assignment.rejected': { reason },
  'assignment.abandoned': { reason },
  'assignment.close-requested': {},

  // Writer ownership, independent of assignment state (§5.3).
  'ownership.reserved': { workspaceId: id, baseCommit: commitSchema },
  'ownership.held': { agentId: id },
  'ownership.releasing': { agentId: id },
  'ownership.released': { agentId: id, archivedAt: timestamp },
  'ownership.uncertain': { reason },

  // External effects: agent creation, turn delivery and archive (§6).
  'agent.create-requested': { intentId: id, peerProviderId: id, workspaceId: id, parentAgentId: id, label: id },
  'agent.create-succeeded': { intentId: id, agentId: id },
  'agent.create-failed': { intentId: id, reason },
  'agent.create-uncertain': { intentId: id, reason },
  // A created Peer whose fresh snapshot did not prove provider, parent, workspace, idleness
  // and no prior prompt. It is archived, never adopted or prompted (§3.3, §5.3).
  'binding.refused': { agentId: id, reason },
  'binding.published': {
    agentId: id, providerId: id, model: z.string().min(1).max(256), parentAgentId: id, workspaceId: id, roomGeneration: id,
  },
  'reporting.generation-opened': { generation, capabilityHash: digest, turn: z.enum(['initial', 'answer', 'rework', 'follow-up']) },
  'run.requested': { intentId: id, generation, promptDigest: digest },
  'run.succeeded': { intentId: id, generation },
  'run.failed': { intentId: id, generation, reason },
  'run.uncertain': { intentId: id, generation, reason },
  'archive.requested': { intentId: id, agentId: id },
  'archive.succeeded': { intentId: id, agentId: id, archivedAt: timestamp, liveStatus: z.literal('closed') },
  'archive.failed': { intentId: id, agentId: id, reason },
  'archive.uncertain': { intentId: id, agentId: id, reason },

  // Peer reporting (§3.4). Report content is evidence; identity and candidate are derived.
  'report.accepted': {
    generation,
    tool: z.enum(PEER_REPORTING_TOOLS),
    requestId: id,
    fingerprint: digest,
    receipt: peerReportReceiptSchema,
    report: z.record(z.string(), z.unknown()),
    candidate: candidateRefSchema.optional(),
    inspectedCommit: commitSchema.optional(),
  },
  'report.refused': { generation: generation.optional(), tool: z.string().min(1).max(64), requestId: id, code: z.enum(PEER_REPORT_ERROR_CODES), reason },
  'report.missing': { generation },
  'report.uncertain': { generation, requestId: id.optional(), reason },
  'permission.awaiting': { generation, permissionRequestId: id, tool: z.enum(PEER_REPORTING_TOOLS) },
  'permission.resolved': { generation, permissionRequestId: id, outcome: z.enum(['allowed', 'denied', 'other']) },

  // Independent runtime gate (D6).
  'gate.requested': {
    gateRunId: id, candidate: candidateRefSchema, command: boundedString(MAX_COMMAND_BYTES),
    timeoutSeconds: gateSpecSchema.shape.timeoutSeconds,
    processContractVersion: z.literal(1), environmentPolicyVersion: z.literal(1),
  },
  'gate.finished': { result: gateResultSchema },
  'gate.uncertain': { gateRunId: id, reason },

  // Deterministic notices (D9). Delivery is at least once with a stable id.
  'notice.pending': {
    noticeId: id, kind: z.string().min(1).max(64), class: z.enum(NOTICE_CLASSES), disposition: z.enum(NOTICE_DISPOSITIONS),
    recipientAgentId: id.optional(), recipientRole: z.enum(RUNTIME_ROLES).exclude(['peer']).optional(), text,
  },
  'notice.sent': { noticeId: id },
  'notice.failed': { noticeId: id, reason },
  'notice.uncertain': { noticeId: id, reason },
} as const satisfies Record<string, z.ZodRawShape>;

export type EventType = keyof typeof EVENT_PAYLOADS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOADS) as EventType[];
/**
 * Payload versions this runtime can read. Phase 1 emits and reads only version 1 of every type;
 * a later breaking payload adds its version here beside the retained v1 reader.
 */
export const SUPPORTED_PAYLOAD_VERSIONS: Readonly<Record<EventType, readonly number[]>> = Object.fromEntries(
  EVENT_TYPES.map(type => [type, [1]] as const),
) as unknown as Record<EventType, readonly number[]>;

const actorSchema = z.strictObject({
  source: z.enum(['human', 'plugin', 'seat', 'paseo']),
  role: z.enum(RUNTIME_ROLES).optional(),
  agentId: id.optional(),
  providerId: id.optional(),
});

const envelope = {
  schema: z.literal(EVENT_SCHEMA),
  version: z.literal(1),
  id: z.string().regex(/^evt_[A-Za-z0-9_-]{8,64}$/),
  sequence: z.number().int().min(1),
  projectId: z.uuid(),
  assignmentId: assignmentIdSchema.optional(),
  actor: actorSchema,
  causationId: id.optional(),
  idempotencyKey: id.optional(),
  occurredAt: timestamp,
};

type Shapes = typeof EVENT_PAYLOADS;
type EnvelopeFields = z.infer<z.ZodObject<typeof envelope>>;
export type RuntimeEventV1 = {
  [K in EventType]: EnvelopeFields & { readonly type: K; readonly payloadVersion: 1; readonly data: z.infer<z.ZodObject<Shapes[K]>> }
}[EventType];
export type RuntimeEventOf<K extends EventType> = Extract<RuntimeEventV1, { type: K }>;

function variants(strict: boolean) {
  return EVENT_TYPES.map(type => z.strictObject({
    ...envelope,
    type: z.literal(type),
    payloadVersion: z.literal(1),
    data: strict ? z.strictObject(EVENT_PAYLOADS[type]) : z.object(EVENT_PAYLOADS[type]),
  }));
}

const [firstWriter, ...restWriters] = variants(true);
const [firstReader, ...restReaders] = variants(false);
if (firstWriter === undefined || firstReader === undefined) throw new Error('The runtime event union is empty.');
const writerSchema = z.discriminatedUnion('type', [firstWriter, ...restWriters]);
const readerSchema = z.discriminatedUnion('type', [firstReader, ...restReaders]);

/** Strict validation before persistence; a writer never publishes anything else. */
export function validateForWrite(event: unknown): RuntimeEventV1 {
  return writerSchema.parse(event) as RuntimeEventV1;
}

export type EventReadResult =
  | { readonly ok: true; readonly event: RuntimeEventV1 }
  | { readonly ok: false; readonly reason: 'unknown-type' | 'unsupported-version' | 'invalid'; readonly detail: string };

/** Forward-tolerant within a supported payload version; fail-closed everywhere else. */
export function readEvent(value: unknown): EventReadResult {
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'invalid', detail: 'Event is not an object.' };
  const { type, payloadVersion } = value as { type?: unknown; payloadVersion?: unknown };
  if (typeof type !== 'string' || !Object.hasOwn(EVENT_PAYLOADS, type)) {
    return { ok: false, reason: 'unknown-type', detail: `Unknown event type ${typeof type === 'string' ? type : typeof type}.` };
  }
  if (typeof payloadVersion !== 'number' || !SUPPORTED_PAYLOAD_VERSIONS[type as EventType].includes(payloadVersion)) {
    return { ok: false, reason: 'unsupported-version', detail: `Unsupported payload version ${String(payloadVersion)} for ${type}.` };
  }
  const parsed = readerSchema.safeParse(value);
  return parsed.success
    ? { ok: true, event: parsed.data as RuntimeEventV1 }
    : { ok: false, reason: 'invalid', detail: z.prettifyError(parsed.error) };
}
