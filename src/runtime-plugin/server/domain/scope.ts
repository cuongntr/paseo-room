/**
 * Canonical write-scope grammar and the conservative collision checks behind worktree dispatch
 * (docs/design/runtime-coordination-phase2.md §5).
 *
 * This decides scheduling, not access. Every approximation errs toward "overlapping": a false
 * overlap costs Lead one narrower brief, a false "disjoint" lets two writers meet on one path.
 * No dependency: glob libraries match a path against a pattern, and this needs the intersection
 * of two patterns (§5.5).
 */
import { MAX_STRING_BYTES, utf8Bytes } from '../../shared/limits.js';

/** One normalised scope entry. `segments` always ends in `**`: an entry owns everything below it. */
export interface ScopeEntry {
  readonly text: string;
  readonly segments: readonly string[];
}

export type ScopeParse =
  | { readonly ok: true; readonly entry: ScopeEntry }
  | { readonly ok: false; readonly item: string; readonly reason: string };

export type ScopesParse =
  | { readonly ok: true; readonly entries: readonly ScopeEntry[] }
  | { readonly ok: false; readonly item: string; readonly reason: string };

const GLOBSTAR = '**';
const WHOLE_REPOSITORY: ScopeEntry = { text: GLOBSTAR, segments: [GLOBSTAR] };

/** NFC, repeated `/` collapsed, trailing `/` stripped. Refusals are `parseScope`'s job. */
export function normalizeScope(raw: string): string {
  return raw.normalize('NFC').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
}

function refusal(raw: string, text: string): string | undefined {
  if (utf8Bytes(raw) > MAX_STRING_BYTES) return `longer than ${String(MAX_STRING_BYTES)} bytes`;
  if (text === '') return 'empty';
  if (text.includes('\\')) return 'contains a backslash';
  if (text.startsWith('/')) return 'is absolute';
  if (text.startsWith('!')) return 'is a negation';
  if (/[{}]/.test(text)) return 'uses brace expansion';
  if (/[[\]]/.test(text)) return 'uses a character class';
  if (text.split('/').some(segment => segment === '.' || segment === '..')) return 'has a . or .. segment';
  return undefined;
}

/** Parse one entry under the §5.1 grammar. A refusal names the entry as written. */
export function parseScope(raw: string): ScopeParse {
  const text = normalizeScope(raw);
  const reason = refusal(raw, text);
  if (reason !== undefined) return { ok: false, item: raw, reason };
  // A run of `*` inside a segment means the same as one; a whole-segment run is the globstar.
  const segments = text.split('/').map(segment => (/^\*+$/.test(segment) && segment.length > 1 ? GLOBSTAR : segment.replace(/\*{2,}/g, '*')));
  if (segments.at(-1) !== GLOBSTAR) segments.push(GLOBSTAR);
  return { ok: true, entry: { text, segments } };
}

/** Parse a scope list; an empty list is the whole repository. */
export function parseScopes(raws: readonly string[]): ScopesParse {
  if (raws.length === 0) return { ok: true, entries: [WHOLE_REPOSITORY] };
  const entries: ScopeEntry[] = [];
  for (const raw of raws) {
    const parsed = parseScope(raw);
    if (!parsed.ok) return parsed;
    entries.push(parsed.entry);
  }
  return { ok: true, entries };
}

/** Code points, not UTF-16 units: a `?` stands for one character, as it does for Git. */
const codePoints = (value: string): string[] => Array.from(value);

/**
 * Lower-case one code point at a time, keeping any code point whose lower case is longer, so a
 * `?` still counts the same characters on both sides of a comparison.
 */
function fold(value: string): string[] {
  return codePoints(value).map(point => {
    const lower = point.toLowerCase();
    return codePoints(lower).length === 1 ? lower : point;
  });
}

const isPattern = (segment: string): boolean => segment.includes('*') || segment.includes('?');

/** Whether a `*`/`?` segment pattern matches a literal segment, both already split into code points. */
function segmentMatches(pattern: readonly string[], literal: readonly string[]): boolean {
  let row = new Array<boolean>(literal.length + 1).fill(false);
  row[literal.length] = true;
  for (let i = pattern.length - 1; i >= 0; i--) {
    const next = new Array<boolean>(literal.length + 1).fill(false);
    for (let j = literal.length; j >= 0; j--) {
      const token = pattern[i];
      if (token === '*') next[j] = (row[j] ?? false) || (j < literal.length && (next[j + 1] ?? false));
      else next[j] = j < literal.length && (token === '?' || token === literal[j]) && (row[j + 1] ?? false);
    }
    row = next;
  }
  return row[0] ?? false;
}

/** The fixed code points before the first and after the last wildcard. */
function fixedEnds(pattern: readonly string[]): { prefix: string[]; suffix: string[] } {
  const wildcards = pattern.flatMap((point, index) => (point === '*' || point === '?' ? [index] : []));
  return { prefix: pattern.slice(0, wildcards[0]), suffix: pattern.slice((wildcards.at(-1) ?? pattern.length) + 1) };
}

const agree = (a: readonly string[], b: readonly string[]): boolean => a.every((point, index) => index >= b.length || point === b[index]);

/** Whether two non-globstar segments could both match one path segment, case-folded. */
function segmentsIntersect(a: string, b: string): boolean {
  const left = fold(a);
  const right = fold(b);
  const leftPattern = isPattern(a);
  const rightPattern = isPattern(b);
  if (!leftPattern && !rightPattern) return left.join('') === right.join('');
  if (!rightPattern) return segmentMatches(left, right);
  if (!leftPattern) return segmentMatches(right, left);
  // Two patterns: disjoint only when a fixed prefix or a fixed suffix provably differs.
  const l = fixedEnds(left);
  const r = fixedEnds(right);
  const suffixesAgree = agree([...l.suffix].reverse(), [...r.suffix].reverse());
  return agree(l.prefix, r.prefix) && suffixesAgree;
}

/** Could some path match both segment lists? `**` consumes zero or more segments of the other side. */
function sequencesIntersect(a: readonly string[], b: readonly string[]): boolean {
  const width = b.length + 1;
  const table = new Uint8Array((a.length + 1) * width);
  const at = (i: number, j: number): boolean => table[i * width + j] === 1;
  for (let i = a.length; i >= 0; i--) {
    for (let j = b.length; j >= 0; j--) {
      let value: boolean;
      if (i === a.length && j === b.length) value = true;
      else if (i === a.length) value = b[j] === GLOBSTAR && at(i, j + 1);
      else if (j === b.length) value = a[i] === GLOBSTAR && at(i + 1, j);
      else if (a[i] === GLOBSTAR || b[j] === GLOBSTAR) value = at(i + 1, j) || at(i, j + 1);
      else value = segmentsIntersect(a[i] ?? '', b[j] ?? '') && at(i + 1, j + 1);
      table[i * width + j] = value ? 1 : 0;
    }
  }
  return at(0, 0);
}

/**
 * True when some path could belong to both entries. Case-folded, so a case-insensitive checkout
 * cannot hide an overlap.
 */
export function overlaps(a: ScopeEntry, b: ScopeEntry): boolean {
  return sequencesIntersect(a.segments, b.segments);
}

/** The first overlapping pair across two scope lists, for a refusal that names both entries. */
export function firstOverlap(as: readonly ScopeEntry[], bs: readonly ScopeEntry[]): readonly [ScopeEntry, ScopeEntry] | undefined {
  for (const a of as) for (const b of bs) if (overlaps(a, b)) return [a, b];
  return undefined;
}

/**
 * True when `scope` may write anything under the serial-only path. A serial path owns its whole
 * subtree like any entry, so this is overlap with it.
 */
export function reaches(scope: ScopeEntry, serialPath: ScopeEntry): boolean {
  return overlaps(scope, serialPath);
}

/** Whether a scope's segments match a literal path; the path side is never read as a pattern. */
function pathMatches(scope: readonly string[], path: readonly string[]): boolean {
  let row = new Array<boolean>(path.length + 1).fill(false);
  row[path.length] = true;
  for (let i = scope.length - 1; i >= 0; i--) {
    const segment = scope[i] ?? '';
    const next = new Array<boolean>(path.length + 1).fill(false);
    for (let j = path.length; j >= 0; j--) {
      if (segment === GLOBSTAR) next[j] = (row[j] ?? false) || (j < path.length && (next[j + 1] ?? false));
      else next[j] = j < path.length && segmentMatches(codePoints(segment), codePoints(path[j] ?? '')) && (row[j + 1] ?? false);
    }
    row = next;
  }
  return row[0] ?? false;
}

/**
 * The changed paths no scope entry covers, in input order. Matched exactly (after NFC), not
 * case-folded: a path that differs only in case is reported, which errs toward evidence.
 */
export function conforms(changedPaths: readonly string[], scopes: readonly ScopeEntry[]): string[] {
  return changedPaths.filter(path => {
    const segments = path.normalize('NFC').split('/').filter(segment => segment !== '');
    return !scopes.some(scope => pathMatches(scope.segments, segments));
  });
}
