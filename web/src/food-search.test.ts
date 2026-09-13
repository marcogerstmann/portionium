import type { FoodResponse } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { isNewName, matchFoods, normalizeName } from './food-search';

/**
 * What the search field answers with before the server has been asked, and what it answers with
 * when there is nothing to ask. The field itself needs a browser and is covered by the Playwright
 * specs, the same split src/day.test.ts describes.
 */

/**
 * The cache as refreshFoods leaves it: the caller's most eaten entries, already in the server's
 * ranking order. That order is the thing matchFoods has to preserve, so these are deliberately
 * not alphabetical.
 */
const CACHE: FoodResponse[] = [
  { id: '1', name: 'Skyr', kind: 'ingredient', category: 'green' },
  { id: '2', name: 'Erdnussbutter', kind: 'ingredient', category: 'orange' },
  { id: '3', name: 'Banane', kind: 'ingredient', category: 'green' },
  // Eaten more often than plain Butter, and after it alphabetically, which is what makes the
  // ordering test below able to tell the two rules apart.
  { id: '4', name: 'Butterkeks', kind: 'ingredient', category: 'orange' },
  { id: '5', name: 'Butter', kind: 'ingredient', category: 'orange' },
];

const names = (foods: readonly FoodResponse[]) => foods.map((food) => food.name);

describe('normalizeName', () => {
  it('agrees with the server about when two names are one food', () => {
    // The same three rules normalizeFoodName applies, and it has to be the same three: this is
    // what decides whether the field offers to add a food the catalog already has.
    expect(normalizeName('  Skyr ')).toBe('skyr');
    expect(normalizeName('Peanut   Butter')).toBe('peanut butter');
    expect(normalizeName('SKYR')).toBe('skyr');
  });
});

describe('matchFoods', () => {
  it('answers an empty query with the whole cache, in the order it was ranked', () => {
    // What an autocomplete shows before anything is typed into it. The order is the server's
    // answer to "what does this person eat", so it must survive untouched.
    expect(names(matchFoods(CACHE, ''))).toEqual(names(CACHE));
    expect(names(matchFoods(CACHE, '   '))).toEqual(names(CACHE));
  });

  it('puts an exact name first, whatever it was ranked', () => {
    // Butter is fourth in the cache and two other entries contain the word. Typing it in full is
    // the least ambiguous thing a person can do and has to be answered as such.
    expect(names(matchFoods(CACHE, 'Butter'))[0]).toBe('Butter');
  });

  it('ranks a prefix of the name above a prefix of a later word, and both above a substring', () => {
    expect(names(matchFoods(CACHE, 'butter'))).toEqual(['Butter', 'Butterkeks', 'Erdnussbutter']);
  });

  it('matches inside a word, which is what makes a half typed name useful', () => {
    expect(names(matchFoods(CACHE, 'kyr'))).toEqual(['Skyr']);
  });

  it('ignores case and surrounding space, the same way the catalog does', () => {
    expect(names(matchFoods(CACHE, '  BaNaNe  '))).toEqual(['Banane']);
  });

  it('keeps the cached order between entries that answer equally well', () => {
    // Three entries begin with the letter and so answer it equally well, and Erdnussbutter only
    // contains it. Among the three the cache's frequency order wins over the alphabet, which is
    // the whole reason a cached food is stored with its rank, see CachedFood. A stable sort is
    // what carries that through.
    expect(names(matchFoods(CACHE, 'b'))).toEqual([
      'Banane',
      'Butterkeks',
      'Butter',
      'Erdnussbutter',
    ]);
  });

  it('answers a query nothing matches with nothing, rather than with everything', () => {
    expect(matchFoods(CACHE, 'zzz')).toEqual([]);
  });
});

describe('isNewName', () => {
  it('offers to add a name the results do not already have', () => {
    expect(isNewName(CACHE, 'Lachsfilet')).toBe(true);
  });

  it('does not offer to add one that is on screen under a different spelling', () => {
    // The server would answer this with the existing entry rather than a second one, so offering
    // it is a promise the catalog will not keep, see POST /foods.
    expect(isNewName(CACHE, ' skyr ')).toBe(false);
  });

  it('offers nothing for an empty query', () => {
    expect(isNewName(CACHE, '')).toBe(false);
    expect(isNewName([], '   ')).toBe(false);
  });
});
