import { matchesGlob } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conforms, firstOverlap, normalizeScope, overlaps, parseScope, parseScopes, reaches, type ScopeEntry,
} from '../src/runtime-plugin/server/domain/scope.js';
import { MAX_STRING_BYTES } from '../src/runtime-plugin/shared/limits.js';

function entry(raw: string): ScopeEntry {
  const parsed = parseScope(raw);
  if (!parsed.ok) throw new Error(`${raw}: ${parsed.reason}`);
  return parsed.entry;
}

describe('scope grammar', () => {
  it.each([
    ['', 'empty'],
    ['/', 'empty'],
    ['/src/api', 'is absolute'],
    ['src/../etc', 'has a . or .. segment'],
    ['./src', 'has a . or .. segment'],
    ['src\\api', 'contains a backslash'],
    ['!src/api', 'is a negation'],
    ['src/{a,b}', 'uses brace expansion'],
    ['src/[ab]', 'uses a character class'],
    ['a'.repeat(MAX_STRING_BYTES + 1), `longer than ${String(MAX_STRING_BYTES)} bytes`],
  ])('refuses %j and names the item', (raw, reason) => {
    expect(parseScope(raw)).toEqual({ ok: false, item: raw, reason });
  });

  it('normalises NFC, repeated and trailing slashes', () => {
    expect(normalizeScope('src//api///')).toBe('src/api');
    expect(normalizeScope('cafe\u0301')).toBe('caf\u00e9');
    expect(entry('src//api/').text).toBe('src/api');
  });

  it('gives every entry an implicit trailing globstar', () => {
    expect(entry('src/api').segments).toEqual(['src', 'api', '**']);
    expect(entry('src/**').segments).toEqual(['src', '**']);
    expect(entry('src/***/a**b').segments).toEqual(['src', '**', 'a*b', '**']);
  });

  it('reads an empty list as the whole repository and stops at the first refused item', () => {
    const whole = parseScopes([]);
    expect(whole.ok && whole.entries.map(scope => scope.text)).toEqual(['**']);
    expect(parseScopes(['src', '/abs', '..'])).toEqual({ ok: false, item: '/abs', reason: 'is absolute' });
  });
});

describe('scope overlap', () => {
  const pair = (a: string, b: string): boolean => overlaps(entry(a), entry(b));

  it('treats an entry as owning its whole subtree', () => {
    expect(pair('src', 'src/api/handler.ts')).toBe(true);
    expect(pair('src/api', 'src/web')).toBe(false);
    expect(pair('src/api', 'src/apiary')).toBe(false);
    expect(pair('src/*.ts', 'src/a.ts/deep')).toBe(true); // the implicit /** reaches under a matching name
    expect(pair('src/*.ts', 'src/lib/deep')).toBe(false);
  });

  it('compares case-folded so a case-insensitive checkout cannot hide an overlap', () => {
    expect(pair('Src/API', 'src/api')).toBe(true);
    expect(pair('SRC/*.TS', 'src/a.ts')).toBe(true);
  });

  it('decides literal against pattern with a real matcher', () => {
    expect(pair('src/a.ts', 'src/*.ts')).toBe(true);
    expect(pair('src/a.md', 'src/*.ts/x')).toBe(false);
    expect(pair('src/ab', 'src/a?')).toBe(true);
    expect(pair('src/abc', 'src/a?/x')).toBe(false);
  });

  it('separates two patterns only by a provably different fixed prefix or suffix', () => {
    expect(pair('src/a*/x', 'src/b*/x')).toBe(false);
    expect(pair('src/*.ts/x', 'src/*.md/x')).toBe(false);
    expect(pair('src/a*/x', 'src/ab*/x')).toBe(true);
    expect(pair('src/*b/x', 'src/a*/x')).toBe(true);
    expect(pair('src/?/x', 'src/??/x')).toBe(true); // over-approximation, allowed
  });

  it('lets a globstar consume any number of segments on either side', () => {
    expect(pair('**/test', 'src/api')).toBe(true); // src/api/test lies under src/api
    expect(pair('a/**/z', 'a/b/c/z')).toBe(true);
    expect(pair('a/**/z', 'b/**')).toBe(false);
    expect(parseScopes([]).ok && pair('**', 'anything')).toBe(true);
  });

  it('names the first overlapping pair across two lists', () => {
    const left = [entry('docs'), entry('src/api')];
    const right = [entry('src/web'), entry('src/API/v2')];
    expect(firstOverlap(left, right)?.map(scope => scope.text)).toEqual(['src/api', 'src/API/v2']);
    expect(firstOverlap([entry('docs')], right)).toBeUndefined();
  });

  it('reaches a serial-only path exactly when the scope may write under it', () => {
    expect(reaches(entry('src'), entry('src/generated'))).toBe(true);
    expect(reaches(entry('src/generated/api.ts'), entry('src/generated'))).toBe(true);
    expect(reaches(entry('docs'), entry('src/generated'))).toBe(false);
  });
});

describe('scope conformance', () => {
  it('returns the changed paths no entry covers, matched exactly', () => {
    const scopes = [entry('src/api'), entry('test/*.test.ts')];
    expect(conforms(['src/api/a.ts', 'test/api.test.ts', 'README.md', 'SRC/api/b.ts', 'src/apiary.ts'], scopes))
      .toEqual(['README.md', 'SRC/api/b.ts', 'src/apiary.ts']);
  });

  it('never reads a changed path as a pattern', () => {
    expect(conforms(['src/*', 'src/**'], [entry('src/a')])).toEqual(['src/*', 'src/**']);
  });

  it('covers every path under the whole-repository scope', () => {
    const whole = parseScopes([]);
    expect(whole.ok && conforms(['a', 'b/c/d'], whole.entries)).toEqual([]);
  });
});

describe('overlap soundness against node:path matchesGlob', () => {
  const SEGMENTS = ['a', 'b', 'ab', 'ba', 'x.ts'];
  const paths: string[] = [];
  let frontier = [''];
  for (let depth = 1; depth <= 4; depth++) {
    frontier = frontier.flatMap(prefix => SEGMENTS.map(segment => (prefix === '' ? segment : `${prefix}/${segment}`)));
    paths.push(...frontier);
  }

  const TOKENS = ['a', 'b', 'ab', '*', '?', 'a*', '*b', '?a', '*.ts', 'x.*', '**'];
  const patterns = [...TOKENS, ...TOKENS.flatMap(first => TOKENS.map(second => `${first}/${second}`))];

  /** The oracle's reading of a scope entry: the entry itself, and everything under it. */
  const covered = (pattern: string): Set<string> => new Set(paths.filter(path => matchesGlob(path, pattern) || matchesGlob(path, `${pattern}/**`)));

  it('never reports disjoint scopes that share a path', () => {
    const coverage = patterns.map(pattern => ({ pattern, paths: covered(pattern), scope: entry(pattern) }));
    const unsound: string[] = [];
    for (const [index, left] of coverage.entries()) {
      for (const right of coverage.slice(index)) {
        if (overlaps(left.scope, right.scope)) continue;
        const shared = [...left.paths].find(path => right.paths.has(path));
        if (shared !== undefined) unsound.push(`${left.pattern} vs ${right.pattern}: both match ${shared}`);
      }
    }
    expect(paths).toHaveLength(780);
    expect(unsound).toEqual([]);
  });

  it('agrees with the oracle on conformance for literal paths', () => {
    for (const pattern of patterns) {
      const scope = entry(pattern);
      const inside = covered(pattern);
      for (const path of paths) {
        if (inside.has(path)) expect(conforms([path], [scope]), `${pattern} covers ${path}`).toEqual([]);
      }
    }
  });
});
