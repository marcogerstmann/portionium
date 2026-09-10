import type { Category, ClassificationSource } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { resolveClassification, resolveClassifications } from './classification.js';

/**
 * The resolution rule, which is the one piece of this product that two people in one household
 * can visibly disagree with. Every case below is a disagreement: with the catalog, with the
 * model, with each other, or with themselves an hour ago.
 */

const USER_A = 'user-a';
const USER_B = 'user-b';

let sequence = 0;

/** `at` is minutes, because the only thing that matters about these instants is their order. */
function verdict(
  source: ClassificationSource,
  category: Category,
  options: { userId?: string | null; at?: number; foodId?: string } = {},
) {
  return {
    id: `row-${String(++sequence).padStart(4, '0')}`,
    foodId: options.foodId ?? 'food-1',
    userId: options.userId ?? null,
    category,
    source,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, options.at ?? 0)),
  };
}

describe('resolveClassification', () => {
  it('answers with nothing when nobody has judged the food', () => {
    expect(resolveClassification([], USER_A)).toBeUndefined();
  });

  it('falls back to what shipped with the catalog', () => {
    const seed = verdict('seed', 'green');

    expect(resolveClassification([seed], USER_A)?.category).toBe('green');
  });

  it('prefers a model verdict over the seeded one, whichever order they arrive in', () => {
    const seed = verdict('seed', 'green', { at: 10 });
    const ai = verdict('ai_text', 'yellow', { at: 1 });

    expect(resolveClassification([seed, ai], USER_A)?.category).toBe('yellow');
  });

  it('prefers the user over the model, which is the whole point of an override', () => {
    const rows = [
      verdict('seed', 'green'),
      verdict('ai_text', 'yellow', { at: 5 }),
      verdict('user', 'orange', { userId: USER_A, at: 2 }),
    ];

    expect(resolveClassification(rows, USER_A)?.category).toBe('orange');
  });

  it('takes the newest of two verdicts from the same user, so changing your mind works', () => {
    const rows = [
      verdict('user', 'orange', { userId: USER_A, at: 1 }),
      verdict('user', 'yellow', { userId: USER_A, at: 2 }),
      verdict('user', 'green', { userId: USER_A, at: 3 }),
    ];

    expect(resolveClassification(rows, USER_A)?.category).toBe('green');
  });

  it('never shows one household member the other one, even handed both', () => {
    const rows = [
      verdict('seed', 'green'),
      verdict('user', 'orange', { userId: USER_A, at: 5 }),
      verdict('user', 'yellow', { userId: USER_B, at: 6 }),
    ];

    expect(resolveClassification(rows, USER_A)?.category).toBe('orange');
    expect(resolveClassification(rows, USER_B)?.category).toBe('yellow');
  });

  it('breaks a same millisecond tie by id, so the winner is not whatever SQLite returned', () => {
    const first = verdict('seed', 'green', { at: 0 });
    const second = verdict('seed', 'orange', { at: 0 });

    expect(resolveClassification([first, second], USER_A)?.id).toBe(second.id);
    expect(resolveClassification([second, first], USER_A)?.id).toBe(second.id);
  });

  it('treats a vision verdict as a model verdict', () => {
    const rows = [verdict('seed', 'green'), verdict('ai_vision', 'orange', { at: 1 })];

    expect(resolveClassification(rows, USER_A)?.category).toBe('orange');
  });
});

describe('resolveClassifications', () => {
  it('resolves a page in one pass and leaves the unjudged out of the map', () => {
    const rows = [
      verdict('seed', 'green', { foodId: 'apple' }),
      verdict('user', 'orange', { foodId: 'apple', userId: USER_A, at: 1 }),
      verdict('seed', 'yellow', { foodId: 'bread' }),
      verdict('user', 'green', { foodId: 'cake', userId: USER_B, at: 1 }),
    ];

    const resolved = resolveClassifications(rows, USER_A);

    expect(resolved.get('apple')?.category).toBe('orange');
    expect(resolved.get('bread')?.category).toBe('yellow');
    // Only user B ever judged the cake, so for user A it is unclassified rather than green.
    expect(resolved.has('cake')).toBe(false);
  });

  it('agrees with the single food answer, which is what stops a list and a detail drifting', () => {
    const rows = [
      verdict('seed', 'green', { foodId: 'apple' }),
      verdict('ai_text', 'yellow', { foodId: 'apple', at: 3 }),
    ];

    expect(resolveClassifications(rows, USER_A).get('apple')).toEqual(
      resolveClassification(rows, USER_A),
    );
  });
});
