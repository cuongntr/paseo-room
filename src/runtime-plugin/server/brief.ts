/**
 * The first prompt a runtime-dispatched Peer receives: the complete assignment brief, verbatim
 * from Lead's fields, plus how this runtime expects the report. It restates no role authority;
 * the Peer's contract already carries that.
 */
import type { AssignmentCreateInputV1 } from './contracts/assignment.js';

/** Characters of an assignment's outcome kept where it names the assignment. */
const GIST = 48;

/** The part of an assignment that names it for a reader: its disposition and its outcome. */
export interface Nameable {
  readonly id: string;
  readonly input: Pick<AssignmentCreateInputV1, 'kind' | 'outcome'>;
}

/** An assignment's outcome, cut to a short phrase on one line, at a word boundary where one is near. */
function gist(outcome: string): string {
  const flat = outcome.replace(/\s+/g, ' ').trim();
  if (flat.length <= GIST) return flat;
  const cut = flat.slice(0, GIST - 1);
  const words = cut.replace(/\s+\S*$/, '');
  return `${words.length >= GIST / 2 ? words : cut.trimEnd()}…`;
}

function disposition(kind: string): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}

/**
 * How notices and the panel name an assignment: what kind of work, what it is for, and its id —
 * readable without remembering the id. For example `Engineer "Add the feature" (asg_…)`.
 */
export function assignmentName(assignment: Nameable): string {
  return `${disposition(assignment.input.kind)} "${gist(assignment.input.outcome)}" (${assignment.id})`;
}

/**
 * The runtime Peer's seat title, for example `Engineer · Add the feature · asg_…`. The id keeps it
 * unique per assignment, which the create correlation relies on.
 */
export function peerTitle(assignment: Nameable): string {
  return `${disposition(assignment.input.kind)} · ${gist(assignment.input.outcome)} · ${assignment.id}`;
}

function list(title: string, items: readonly string[]): string[] {
  return items.length === 0 ? [] : [`${title}:`, ...items.map(item => `- ${item}`), ''];
}

/** The runtime-created worktree a Peer works in, when it was dispatched with isolation. */
export interface BriefWorktree {
  readonly path: string;
  readonly branch: string;
  readonly serialOnly: readonly string[];
}

export function renderBrief(assignmentId: string, input: AssignmentCreateInputV1, worktree?: BriefWorktree): string {
  return [
    `Assignment ${assignmentId} — ${input.kind}, ${input.mode}.`,
    '',
    ...(worktree === undefined ? [] : [
      `Workspace: your own worktree ${worktree.path} on branch ${worktree.branch}. Other Peers may be writing in their own worktrees at the same time; stay inside your write scope.`,
      '',
      ...list('Serial-only paths (one writer at a time)', worktree.serialOnly),
    ]),
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
