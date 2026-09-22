/**
 * Assignment-creation validation (PRD REQ-004; docs/design/runtime-coordination.md §4.3).
 *
 * The schema proves shape; these rules prove the brief is complete enough to delegate. Each
 * refusal carries a stable code and the field to fix, so Lead can correct and resubmit.
 */
import { z } from 'zod';
import { assignmentCreateSchema, type AssignmentCreateInputV1, type AssignmentKind, type AssignmentMode } from '../contracts/assignment.js';

export const ASSIGNMENT_CREATE_ERROR_CODES = [
  'assignment_malformed', 'outcome_empty', 'mode_kind_mismatch', 'scope_missing', 'scope_on_read_only',
  'exclusions_missing', 'handoff_missing', 'gate_missing',
] as const;
export type AssignmentCreateErrorCode = (typeof ASSIGNMENT_CREATE_ERROR_CODES)[number];

export interface AssignmentCreateError {
  readonly code: AssignmentCreateErrorCode;
  readonly field: string;
  readonly message: string;
}

export type AssignmentCreateValidation =
  | { readonly ok: true; readonly input: AssignmentCreateInputV1 }
  | { readonly ok: false; readonly errors: readonly AssignmentCreateError[] };

/**
 * Lead's assignment vocabulary: Engineer is writable; Architect, Reviewer and Scout are
 * read-only (src/room/prompts/contract/lead.md). A brief may not re-pair them.
 */
export const KIND_MODE: Readonly<Record<AssignmentKind, AssignmentMode>> = {
  engineer: 'writable',
  architect: 'read-only',
  reviewer: 'read-only',
  scout: 'read-only',
};

const blank = (value: string): boolean => value.trim() === '';

export function validateAssignmentCreate(raw: unknown): AssignmentCreateValidation {
  const parsed = assignmentCreateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: [{ code: 'assignment_malformed', field: '(input)', message: z.prettifyError(parsed.error) }] };
  }
  const input = parsed.data;
  const errors: AssignmentCreateError[] = [];
  const refuse = (code: AssignmentCreateErrorCode, field: string, message: string): void => { errors.push({ code, field, message }); };

  if (blank(input.outcome)) refuse('outcome_empty', 'outcome', 'State the one outcome this assignment must deliver.');
  if (KIND_MODE[input.kind] !== input.mode) {
    refuse('mode_kind_mismatch', 'mode', `A ${input.kind} assignment is ${KIND_MODE[input.kind]}, not ${input.mode}.`);
  }
  const scope = input.writeScope.filter(item => !blank(item));
  if (input.mode === 'writable' && scope.length === 0) {
    refuse('scope_missing', 'writeScope', 'A writable assignment names the write scope it owns.');
  }
  if (input.mode === 'read-only' && scope.length > 0) {
    refuse('scope_on_read_only', 'writeScope', 'A read-only assignment owns no write scope; name what to inspect in the outcome instead.');
  }
  if (input.exclusions.filter(item => !blank(item)).length === 0) {
    refuse('exclusions_missing', 'exclusions', 'State what is excluded from the assignment, even if it is "no other change".');
  }
  if (input.expectedHandoff.filter(item => !blank(item)).length === 0) {
    refuse('handoff_missing', 'expectedHandoff', 'State what the Peer must hand back.');
  }
  if (input.mode === 'writable' && (input.gate === undefined || blank(input.gate.command))) {
    refuse('gate_missing', 'gate', 'A writable assignment carries the exact verification command; the runtime never invents one.');
  }
  return errors.length === 0 ? { ok: true, input } : { ok: false, errors };
}
