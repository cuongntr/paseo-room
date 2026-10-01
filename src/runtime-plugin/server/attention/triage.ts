/**
 * Triage of edge candidates (docs/design/runtime-coordination-attention.md §6).
 *
 * Code decides alone: a Lead's marker lines give its turn a class, an answer to the Supervisor's
 * message goes at once, and any other Lead turn the Supervisor was not already told about is a
 * digest line. No model ranks a turn.
 */

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

/** A marker line, after any list, quote, heading, numbering, emphasis or code prefix. */
const MARKER = /^[ \t>*_#`-]*(?:\d+[.)][ \t]*)?[*_`]*(INCIDENT|NEEDS-HUMAN)[*_`]*:[*_` \t]*(\S.*)$/gm;
/** A filled-in template ("INCIDENT: none") is not a report; a real one is never matched by a prefix. */
const EMPTY_MARKER = /^(?:none|nothing|n\/a|no|không(?: có)?|—|–|-)(?: to report)?(?: this turn)?[.!]?$/i;
/** Markers kept per turn, incidents first. */
const MAX_MARKERS = 20;
export const MAX_MARKER_TEXT = 500;

/** The marker lines of a Lead's words, incidents first so no number of questions crowds one out. */
export function leadMarkers(text: string): readonly Marker[] {
  const found: Marker[] = [];
  for (const match of text.matchAll(MARKER)) {
    // Emphasis closing the line is formatting, not what Lead said; inline code may be what it said.
    const said = (match[2] ?? '').replace(/[\s*_]+$/, '').replace(/\s+/g, ' ');
    if (said === '' || EMPTY_MARKER.test(said.replace(/`/g, ''))) continue;
    // One character over the bound, so a quote cut to it still shows that it was cut.
    found.push({ kind: match[1] as MarkerKind, text: said.slice(0, MAX_MARKER_TEXT + 1) });
  }
  return [...found.filter(marker => marker.kind === 'INCIDENT'), ...found.filter(marker => marker.kind !== 'INCIDENT')].slice(0, MAX_MARKERS);
}

/** The class a Lead's marker lines give its turn: an incident pages, a Human question wakes. */
export function markedLeadTurn(markers: readonly Marker[]): Triaged<'page' | 'now'> | undefined {
  if (markers.length === 0) return undefined;
  const kinds = [...new Set(markers.map(marker => marker.kind))];
  return { decision: kinds.includes('INCIDENT') ? 'page' : 'now', reason: `Lead marked the turn ${kinds.join(' and ')}` };
}

export interface LeadTurnFacts {
  readonly peersRunning: number;
  readonly permissionPending: boolean;
}

export interface Triaged<D extends string = Decision> {
  readonly decision: D;
  readonly reason: string;
}

export const BASELINE: Triaged = { decision: 'digest', reason: 'baseline: a Lead turn the Supervisor was not told about' };
/** A Lead turn that read its Supervisor's message: the Supervisor waits for this answer (§7.2). */
export const ANSWER: Triaged = { decision: 'now', reason: 'Lead answers its Supervisor\'s message' };

