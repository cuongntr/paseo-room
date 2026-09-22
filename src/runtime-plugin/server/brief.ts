/**
 * The first prompt a runtime-dispatched Peer receives: the complete assignment brief, verbatim
 * from Lead's fields, plus how this runtime expects the report. It restates no role authority;
 * the Peer's contract already carries that.
 */
import type { AssignmentCreateInputV1 } from './contracts/assignment.js';

function list(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`${title}:`, ...items.map(item => `- ${item}`), ''];
}

export function renderBrief(assignmentId: string, input: AssignmentCreateInputV1): string {
  return [
    `Assignment ${assignmentId} — ${input.kind}, ${input.mode}.`,
    '',
    'Outcome:',
    input.outcome,
    '',
    `Base commit: ${input.baseCommit}`,
    '',
    ...list('Prerequisites', input.prerequisites),
    ...list(input.mode === 'writable' ? 'Write scope' : 'Write scope (none: read-only)', input.writeScope),
    ...list('Excluded', input.exclusions),
    ...list('Invariants', input.invariants),
    ...list('Acceptance evidence', input.acceptanceEvidence),
    ...(input.gate === undefined ? [] : ['Verification gate (run exactly this after your last write and report its result):', input.gate.command, '']),
    ...list('Hand back', input.expectedHandoff),
    ...list('Reopen if', input.reopenConditions),
    'Report through the `ask` or `handoff` tool. A report exists only once the tool accepts it; prose in your final message is not a report.',
    input.mode === 'writable'
      ? 'A complete writable handoff needs a clean workspace whose HEAD is a commit descending from the base; the runtime reads the commit and changed paths itself.'
      : 'A read-only handoff is bound to the commit the runtime observes in your workspace.',
  ].join('\n');
}

export function renderContinuation(kind: 'answer' | 'rework' | 'follow-up', text: string): string {
  const heading = kind === 'answer' ? 'Answer from Lead' : kind === 'rework' ? 'Rework requested by Lead' : 'Follow-up from Lead';
  return [`${heading}:`, text, '', 'Report again through the `ask` or `handoff` tool.'].join('\n');
}
