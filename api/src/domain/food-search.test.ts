import { describe, expect, it } from 'vitest';

import {
  looselyMatches,
  rankSearchResults,
  toFtsMatch,
  withinOneEdit,
  type SearchCandidate,
} from './food-search.js';

describe('turning a query into an FTS5 expression', () => {
  it('wraps it in a phrase, so what a user typed is never parsed as syntax', () => {
    expect(toFtsMatch('skyr AND quark')).toBe('"skyr and quark"');
    expect(toFtsMatch('milk*')).toBe('"milk*"');
  });

  it('escapes a quote the way FTS5 does, by doubling it', () => {
    expect(toFtsMatch('7" pizza')).toBe('"7"" pizza"');
  });

  it('normalises the query the same way a stored name is compared', () => {
    expect(toFtsMatch('  Peanut   BUTTER ')).toBe('"peanut butter"');
  });

  it('gives up below three characters, because a trigram index cannot answer that', () => {
    expect(toFtsMatch('sk')).toBeUndefined();
    expect(toFtsMatch('')).toBeUndefined();
  });
});

describe('a single edit apart', () => {
  it('accepts the four mistakes somebody makes typing a short name', () => {
    expect(withinOneEdit('skyr', 'skyr')).toBe(true);
    // Substitution, deletion, insertion, and the transposition no trigram would catch.
    expect(withinOneEdit('skyr', 'skyz')).toBe(true);
    expect(withinOneEdit('skyr', 'syr')).toBe(true);
    expect(withinOneEdit('skyr', 'skyyr')).toBe(true);
    expect(withinOneEdit('skyr', 'sykr')).toBe(true);
  });

  it('refuses two of them', () => {
    expect(withinOneEdit('skyr', 'sykz')).toBe(false);
    expect(withinOneEdit('skyr', 'sr')).toBe(false);
    expect(withinOneEdit('abcd', 'xbd')).toBe(false);
    expect(withinOneEdit('magerquark', 'quark')).toBe(false);
  });

  it('refuses on length before comparing anything', () => {
    expect(withinOneEdit('skyr', 'skyrmion')).toBe(false);
  });
});

describe('matching what the index could not', () => {
  it('matches a prefix of the name, and of any word in it', () => {
    expect(looselyMatches('Peanut Butter', 'pea')).toBe(true);
    expect(looselyMatches('Peanut Butter', 'but')).toBe(true);
  });

  it('matches a prefix shorter than a trigram, which is the point of the scan', () => {
    expect(looselyMatches('Skyr', 'sk')).toBe(true);
    expect(looselyMatches('Skyr', 's')).toBe(true);
  });

  it('forgives one typo in the name or in a word of it', () => {
    expect(looselyMatches('Skyr', 'sykr')).toBe(true);
    expect(looselyMatches('Peanut Butter', 'buttrer')).toBe(true);
  });

  it('does not forgive a typo below three characters, which would match everything', () => {
    expect(looselyMatches('Skyr', 'xk')).toBe(false);
  });

  it('leaves substring matching to the index rather than doing it twice', () => {
    expect(looselyMatches('Magerquark', 'quark')).toBe(false);
  });

  it('never matches an empty query', () => {
    expect(looselyMatches('Skyr', '   ')).toBe(false);
  });
});

describe('ranking what came back', () => {
  const at = (iso: string) => new Date(iso);

  function candidate(name: string, overrides: Partial<SearchCandidate> = {}): SearchCandidate {
    return { name, lastUsedAt: null, uses: 0, ...overrides };
  }

  function names(candidates: readonly SearchCandidate[], query: string): string[] {
    return rankSearchResults(candidates, query).map((result) => result.name);
  }

  it('puts an exact match above a food the caller eats every day', () => {
    const results = names(
      [
        candidate('Skyr Vanilla', { lastUsedAt: at('2026-09-09T08:00:00Z'), uses: 400 }),
        candidate('Skyr'),
      ],
      'skyr',
    );

    expect(results).toEqual(['Skyr', 'Skyr Vanilla']);
  });

  it('matches exactly on the normalised name, not the stored one', () => {
    expect(names([candidate('Aa Skyr'), candidate('  SKYR  ')], 'skyr')[0]).toBe('  SKYR  ');
  });

  it("prefers the caller's own foods, most recently eaten first", () => {
    const results = names(
      [
        candidate('Skyr Plain', { uses: 900 }),
        candidate('Skyr Vanilla', { lastUsedAt: at('2026-09-01T08:00:00Z'), uses: 1 }),
        candidate('Skyr Mango', { lastUsedAt: at('2026-09-09T08:00:00Z'), uses: 1 }),
      ],
      'skyr',
    );

    expect(results).toEqual(['Skyr Mango', 'Skyr Vanilla', 'Skyr Plain']);
  });

  it('falls back to how much the instance eats a food', () => {
    expect(
      names([candidate('Skyr B', { uses: 2 }), candidate('Skyr A', { uses: 9 })], 'skyr'),
    ).toEqual(['Skyr A', 'Skyr B']);
  });

  it('then to lexical relevance: a prefix, a word, a substring, a typo', () => {
    const results = names(
      [candidate('Magerquark'), candidate('Bio Quark'), candidate('Quarkx'), candidate('Quark')],
      'quark',
    );

    expect(results).toEqual(['Quark', 'Quarkx', 'Bio Quark', 'Magerquark']);
  });

  it('orders the rest deterministically, so a dropdown does not reshuffle between keystrokes', () => {
    const catalog = [candidate('Skyr Zebra'), candidate('Skyr Apple'), candidate('Skyr Ox')];

    expect(names(catalog, 'skyr')).toEqual(names([...catalog].reverse(), 'skyr'));
    expect(names(catalog, 'skyr')).toEqual(['Skyr Ox', 'Skyr Apple', 'Skyr Zebra']);
  });
});
