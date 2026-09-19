import type { WeeklyBudgetStatus } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { budgetPositions, hasAnyLimit, spokenBudget } from './budget';

/**
 * The row's arithmetic and its sentence. Nothing here counts anything: the server does that and
 * this only decides what is worth showing and how it is said, see ./budget.ts.
 */

function status(overrides: Partial<WeeklyBudgetStatus> = {}): WeeklyBudgetStatus {
  return {
    green: { limit: null, count: 0, remaining: null },
    yellow: { limit: null, count: 0, remaining: null },
    orange: { limit: null, count: 0, remaining: null },
    unclassified: 0,
    ...overrides,
  };
}

describe('hasAnyLimit', () => {
  /** Nothing is drawn for an account that never asked for this, which is most of them. */
  it('is false when every category is unlimited, however much was logged', () => {
    expect(hasAnyLimit(status({ green: { limit: null, count: 14, remaining: null } }))).toBe(false);
  });

  it('is true for one limit among three', () => {
    expect(hasAnyLimit(status({ orange: { limit: 4, count: 0, remaining: 4 } }))).toBe(true);
  });

  /** Zero is an intention, not the absence of one, so it has to show a row like any other. */
  it('is true for a limit of zero', () => {
    expect(hasAnyLimit(status({ orange: { limit: 0, count: 0, remaining: 0 } }))).toBe(true);
  });
});

describe('budgetPositions', () => {
  it('reads the traffic light in order whatever order the response happens to be in', () => {
    expect(budgetPositions(status()).map((position) => position.category)).toEqual([
      'green',
      'yellow',
      'orange',
    ]);
  });

  it('marks a category at its limit, and again past it', () => {
    const positions = budgetPositions(
      status({
        green: { limit: null, count: 30, remaining: null },
        yellow: { limit: 12, count: 12, remaining: 0 },
        orange: { limit: 4, count: 7, remaining: -3 },
      }),
    );

    expect(positions.map((position) => position.atLimit)).toEqual([false, true, true]);
  });

  it('leaves a category under its limit unmarked', () => {
    const [, yellow] = budgetPositions(status({ yellow: { limit: 12, count: 11, remaining: 1 } }));

    expect(yellow?.atLimit).toBe(false);
  });

  /** An unlimited category is never at a limit, however large the count gets. */
  it('never marks an unlimited category', () => {
    const [green] = budgetPositions(
      status({ green: { limit: null, count: 999, remaining: null } }),
    );

    expect(green).toMatchObject({ limit: null, count: 999, atLimit: false });
  });
});

describe('spokenBudget', () => {
  /**
   * The only channel that does not depend on telling this palette's green from its orange, so
   * every category is named in words and the position is a position rather than a verdict.
   */
  it('names every category and reads a limit as a position', () => {
    const spoken = spokenBudget(
      status({
        green: { limit: null, count: 14, remaining: null },
        yellow: { limit: 12, count: 7, remaining: 5 },
        orange: { limit: 4, count: 3, remaining: 1 },
      }),
      'en-US',
    );

    expect(spoken).toBe('This week: 14 green, 7 of 12 yellow, 3 of 4 orange.');
  });

  it('says a category past its limit as the numbers, with no verdict word', () => {
    const spoken = spokenBudget(status({ orange: { limit: 4, count: 7, remaining: -3 } }), 'en-US');

    expect(spoken).toContain('7 of 4 orange');
    expect(spoken.toLowerCase()).not.toContain('exceed');
    expect(spoken.toLowerCase()).not.toContain('over');
  });

  it('speaks the active language rather than the dictionary it was written in', () => {
    const spoken = spokenBudget(status({ yellow: { limit: 12, count: 7, remaining: 5 } }), 'de');

    expect(spoken).toBe('Diese Woche: 0 grün, 7 von 12 gelb, 0 orange.');
  });
});
