/**
 * The sensor's question sets (docs/design/runtime-coordination-attention.md §6.2, §6.3).
 *
 * Questions are atomic and literal, in English, over a small named state; numbers reach the model
 * only as named buckets, because counting and arithmetic stay in code. A question set is versioned
 * by name: changing a question's wording is a new version, since thresholds are tuned per version.
 */
import type { QuestionSetId } from '../../shared/attention.js';
import type { LeadTurnFacts } from './triage.js';

export interface SystemOneQuestion {
  readonly type: 'choice' | 'noul';
  readonly instructions: string;
  readonly criteria?: Readonly<Record<string, string | null>>;
}

export interface SystemOneRequest {
  readonly state: Readonly<Record<string, unknown>>;
  readonly questions: Readonly<Record<string, SystemOneQuestion>>;
}

export const LEAD_TURN_V1: QuestionSetId = 'lead-turn-v1';
export const PEER_REPORT_V1: QuestionSetId = 'peer-report-v1';

export const LEAD_TURN_OUTCOMES = [
  'completed', 'needs_human_decision', 'waiting_for_peer', 'waiting_for_external', 'blocked_by_error', 'continuing', 'unclear',
] as const;

const LEAD_TURN_QUESTIONS: Readonly<Record<string, SystemOneQuestion>> = {
  outcome: {
    type: 'choice',
    instructions: 'What does `last_message` report about the Lead\'s work?',
    criteria: {
      completed: 'The requested work is finished and reported.',
      needs_human_decision: 'The Lead asks the Human to choose, approve or answer something before continuing.',
      waiting_for_peer: 'The Lead says it is waiting for a Peer or delegated agent to finish.',
      waiting_for_external: 'The Lead is waiting on something outside the room, such as a deploy, CI, quota or a person other than the Human.',
      blocked_by_error: 'The Lead cannot continue because of an error it has not resolved.',
      continuing: 'The Lead reports progress and says it will keep working.',
      unclear: 'None of the above fits.',
    },
  },
  asks_human: { type: 'noul', instructions: 'Does `last_message` ask the Human to decide, approve or answer something?' },
  done_unverified: { type: 'noul', instructions: 'Does `last_message` say work is finished without naming a check that was run and its result?' },
};

const bucket = (count: number): string => (count === 0 ? 'none' : count === 1 ? 'one' : 'several');

/** `lead-turn-v1` over an already masked, bounded message. */
export function leadTurnRequest(seat: string, message: string, facts: LeadTurnFacts): SystemOneRequest {
  return {
    state: {
      seat,
      last_message: message,
      facts: { peers_running: bucket(facts.peersRunning), permission_pending: facts.permissionPending ? 'yes' : 'no' },
    },
    questions: LEAD_TURN_QUESTIONS,
  };
}

const PEER_REPORT_QUESTIONS: Readonly<Record<string, SystemOneQuestion>> = {
  outcome: {
    type: 'choice',
    instructions: 'What does `report` say about the assigned work?',
    criteria: {
      delivered: 'The work the brief asked for is done.',
      blocked: 'The Peer could not continue and says why.',
      needs_decision: 'The Peer needs a decision from its Lead to continue.',
      partial: 'Some of the work is done and some is not.',
      failed: 'The work failed.',
      unclear: 'None of the above fits.',
    },
  },
  out_of_brief: { type: 'noul', instructions: 'Does `report` describe changes the `brief` did not ask for?' },
};

/** `peer-report-v1`, shadow-only in this phase (delta Q-A04). */
export function peerReportRequest(brief: string, report: string): SystemOneRequest {
  return { state: { brief, report }, questions: PEER_REPORT_QUESTIONS };
}
