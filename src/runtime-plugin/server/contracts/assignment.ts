/**
 * Assignment input and evidence shapes (docs/design/runtime-coordination.md §4.3, §4.4).
 * Structural only: semantic rules such as mode/kind compatibility or a writable gate belong to
 * the domain validator, so every refusal there carries an actionable reason.
 */
import { z } from 'zod';
import { boundedArray, boundedString, MAX_COMMAND_BYTES, MAX_GATE_TIMEOUT_SECONDS } from '../../shared/limits.js';

export const ASSIGNMENT_MODES = ['writable', 'read-only'] as const;
export const ASSIGNMENT_KINDS = ['engineer', 'architect', 'reviewer', 'scout'] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];
export type AssignmentKind = (typeof ASSIGNMENT_KINDS)[number];

/** A full Git object id: SHA-1 or SHA-256. Abbreviations are refused, never resolved. */
export const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const gateSpecSchema = z.strictObject({
  command: boundedString(MAX_COMMAND_BYTES),
  timeoutSeconds: z.number().int().min(1).max(MAX_GATE_TIMEOUT_SECONDS),
  runtimeRerun: z.enum(['none', 'optional', 'required']),
  processContractVersion: z.literal(1),
});
export type GateSpecV1 = z.infer<typeof gateSpecSchema>;

const items = boundedArray(boundedString());

export const assignmentCreateSchema = z.strictObject({
  mode: z.enum(ASSIGNMENT_MODES),
  kind: z.enum(ASSIGNMENT_KINDS),
  outcome: boundedString(),
  prerequisites: items,
  writeScope: items,
  exclusions: items,
  invariants: items,
  acceptanceEvidence: items,
  gate: gateSpecSchema.optional(),
  expectedHandoff: items,
  reopenConditions: items,
  baseCommit: commitSchema,
});
export type AssignmentCreateInputV1 = z.infer<typeof assignmentCreateSchema>;

export const candidateRefSchema = z.strictObject({
  kind: z.literal('git-commit'),
  commit: commitSchema,
  baseCommit: commitSchema,
  changedPaths: z.array(z.string().min(1)),
  workspaceId: z.string().min(1),
  branch: z.string().min(1).optional(),
});
export type CandidateRefV1 = z.infer<typeof candidateRefSchema>;
