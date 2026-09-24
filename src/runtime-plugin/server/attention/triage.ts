/**
 * Triage of edge candidates (docs/design/runtime-coordination-attention.md §6).
 *
 * The baseline decides alone when the sensor is off or has no answer: a Lead turn the Supervisor
 * was not already told about is a digest line. The sensor, when it may assist, can raise a Lead turn
 * to `now` or lower a `continuing` one to `record` — nothing else — and only above its confidence
 * floor. Code keeps the audience, the class and every transition.
 */
import type { QuestionSetId } from '../../shared/attention.js';

export type Decision = 'record' | 'digest' | 'now';

/**
 * The lines the Lead contract asks for when a turn needs the Human or reports an incident. Code,
 * not a model, turns them into a class: an incident pages, a Human question wakes.
 */
export type MarkerKind = 'INCIDENT' | 'NEEDS-HUMAN';

export interface Marker {
  readonly kind: MarkerKind;
  readonly text: string;
}

const MARKER = /^[ \t>*_-]*(INCIDENT|NEEDS-HUMAN)[*_]*:[*_ \t]*(\S.*)$/gm;
/** A filled-in template ("INCIDENT: none") is not a report. */
const EMPTY_MARKER = /^(?:none|n\/a|no|không(?: có)?)[.!]?$/i;
const MAX_MARKERS = 5;
const MAX_MARKER_TEXT = 500;

/** The marker lines of a Lead's words, in order, bounded. */
export function leadMarkers(text: string): readonly Marker[] {
  const found: Marker[] = [];
  for (const match of text.matchAll(MARKER)) {
    const kind = match[1] as MarkerKind;
    const said = (match[2] ?? '').trim();
    if (EMPTY_MARKER.test(said)) continue;
    found.push({ kind, text: said.slice(0, MAX_MARKER_TEXT) });
    if (found.length === MAX_MARKERS) break;
  }
  return found;
}

export interface LeadTurnFacts {
  readonly peersRunning: number;
  readonly permissionPending: boolean;
}

/** A typed, probabilistic answer set for one question set, as the sensor adapter returns it. */
export interface Assessment {
  readonly questionSet: QuestionSetId;
  readonly model: string;
  readonly choice?: { readonly value: string; readonly confidence: number };
  readonly nouls: Readonly<Record<string, number>>;
  readonly probabilities?: Readonly<Record<string, number>>;
  readonly latencyMs: number;
  readonly inputTokens?: number;
}

export interface Triaged {
  readonly decision: Decision;
  readonly reason: string;
  /** Set when the sensor's outcome should arm the `project-quiet` backstop. */
  readonly continuing?: boolean;
}

export const CONFIDENCE_FLOOR = 0.6;
export const NOUL_THRESHOLD = 0.7;

export const BASELINE: Triaged = { decision: 'digest', reason: 'baseline: a Lead turn the Supervisor was not told about' };

/** The delta §6.4 assist table for `lead-turn-v1`. */
export function assistLeadTurn(assessment: Assessment, facts: LeadTurnFacts): Triaged {
  const outcome = assessment.choice;
  if (outcome === undefined || outcome.confidence < CONFIDENCE_FLOOR) return { ...BASELINE, reason: 'sensor below confidence floor; baseline' };
  const asksHuman = (assessment.nouls.asks_human ?? 0) >= NOUL_THRESHOLD;
  const unverified = (assessment.nouls.done_unverified ?? 0) >= NOUL_THRESHOLD;
  switch (outcome.value) {
    case 'waiting_for_peer':
      return facts.peersRunning === 0
        ? { decision: 'now', reason: 'dead wait: Lead waits for a Peer and none is running' }
        : { decision: 'digest', reason: 'Lead waits for a running Peer' };
    case 'needs_human_decision':
      return { decision: 'now', reason: 'Lead needs a Human decision' };
    case 'blocked_by_error':
      return { decision: 'now', reason: 'Lead is blocked by an error' };
    case 'waiting_for_external':
      return asksHuman ? { decision: 'now', reason: 'Lead asks the Human' } : { decision: 'digest', reason: 'Lead waits on something outside the room' };
    case 'completed':
      return asksHuman ? { decision: 'now', reason: 'Lead asks the Human' } : { decision: 'digest', reason: unverified ? 'completed; status-as-acceptance?' : 'completed' };
    case 'continuing':
      if (asksHuman) return { decision: 'now', reason: 'Lead asks the Human' };
      return facts.peersRunning > 0 || facts.permissionPending
        ? { decision: 'record', reason: 'Lead continues with work running', continuing: true }
        : { decision: 'digest', reason: 'Lead says it continues, but nothing runs' };
    default:
      return asksHuman ? { decision: 'now', reason: 'Lead asks the Human' } : { ...BASELINE, reason: 'sensor unclear; baseline' };
  }
}
