import { describe, expect, it } from 'vitest';

import { normalizeFoodName } from './food.js';

describe('normalizeFoodName', () => {
  it('makes one food out of the three spellings three people type', () => {
    const forms = ['Skyr', 'skyr', '  Skyr  ', 'SKYR'];

    expect(new Set(forms.map(normalizeFoodName)).size).toBe(1);
  });

  it('collapses a run of spaces, which no index expression could do in SQL', () => {
    expect(normalizeFoodName('Peanut  Butter')).toBe(normalizeFoodName('Peanut Butter'));
    expect(normalizeFoodName('Peanut\tButter')).toBe('peanut butter');
  });

  it('folds the vowels this catalog is full of, which SQLite lower() would not', () => {
    expect(normalizeFoodName('MÜSLI')).toBe(normalizeFoodName('Müsli'));
  });

  it('leaves accents alone, so a near miss costs a duplicate and never a wrong colour', () => {
    expect(normalizeFoodName('Müsli')).not.toBe(normalizeFoodName('Muesli'));
  });

  it('keeps distinct foods distinct', () => {
    expect(normalizeFoodName('Skyr')).not.toBe(normalizeFoodName('Skyr Vanille'));
  });
});
