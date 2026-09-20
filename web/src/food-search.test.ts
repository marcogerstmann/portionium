import type { FoodResponse } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { isNewName, matchFoods, normalizeName } from './food-search';

const CACHE: FoodResponse[] = [
  { id: '1', name: 'Skyr', kind: 'ingredient', category: 'green' },
  { id: '2', name: 'Erdnussbutter', kind: 'ingredient', category: 'orange' },
  { id: '3', name: 'Banane', kind: 'ingredient', category: 'green' },
  { id: '4', name: 'Butterkeks', kind: 'ingredient', category: 'orange' },
  { id: '5', name: 'Butter', kind: 'ingredient', category: 'orange' },
];

const names = (foods: readonly FoodResponse[]) => foods.map((food) => food.name);

describe('normalizeName', () => {
  it('agrees with the server about when two names are one food', () => {
    expect(normalizeName('  Skyr ')).toBe('skyr');
    expect(normalizeName('Peanut   Butter')).toBe('peanut butter');
    expect(normalizeName('SKYR')).toBe('skyr');
  });
});

describe('matchFoods', () => {
  it('answers an empty query with the whole cache, in the order it was ranked', () => {
    expect(names(matchFoods(CACHE, ''))).toEqual(names(CACHE));
    expect(names(matchFoods(CACHE, '   '))).toEqual(names(CACHE));
  });

  it('puts an exact name first, whatever it was ranked', () => {
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
    expect(isNewName(CACHE, ' skyr ')).toBe(false);
  });

  it('offers nothing for an empty query', () => {
    expect(isNewName(CACHE, '')).toBe(false);
    expect(isNewName([], '   ')).toBe(false);
  });
});
