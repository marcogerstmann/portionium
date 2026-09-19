import type { WeeklyBudgets } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { computeBudgetStatus } from './budget.js';
import type { DateRangeEntry } from './stats.js';

/**
 * The arithmetic behind the soft lock. The interesting cases are all about what the numbers are
 * allowed to be rather than about counting: null against zero, and a negative remaining.
 */

const UNLIMITED: WeeklyBudgets = { green: null, yellow: null, orange: null };

function entries(...categories: (DateRangeEntry['category'] | 'unclassified')[]): DateRangeEntry[] {
  return categories.map((category) => ({
    category: category === 'unclassified' ? null : category,
    localDate: '2026-09-14',
  }));
}

describe('computeBudgetStatus', () => {
  it('counts what was logged against the limit and reports what is left', () => {
    const status = computeBudgetStatus(entries('yellow', 'yellow', 'orange'), {
      green: null,
      yellow: 12,
      orange: 4,
    });

    expect(status.yellow).toEqual({ limit: 12, count: 2, remaining: 10 });
    expect(status.orange).toEqual({ limit: 4, count: 1, remaining: 3 });
  });

  /**
   * The whole product principle in one assertion. Past the allowance is a negative number and
   * nothing else: no flag, no clamp at zero, and nothing in the shape that reads as a verdict.
   */
  it('lets remaining go negative rather than clamping or flagging it', () => {
    const status = computeBudgetStatus(entries('orange', 'orange', 'orange'), {
      ...UNLIMITED,
      orange: 1,
    });

    expect(status.orange).toEqual({ limit: 1, count: 3, remaining: -2 });
    expect(Object.keys(status.orange).sort()).toEqual(['count', 'limit', 'remaining']);
  });

  it('answers a null limit with a null remaining, never a stand-in ceiling', () => {
    const status = computeBudgetStatus(entries('green', 'green'), UNLIMITED);

    expect(status.green).toEqual({ limit: null, count: 2, remaining: null });
  });

  /** Zero is an intention and null is the absence of one, so the two cannot collapse. */
  it('treats a limit of zero as none this week rather than as unlimited', () => {
    const status = computeBudgetStatus(entries('orange'), { ...UNLIMITED, orange: 0 });

    expect(status.orange).toEqual({ limit: 0, count: 1, remaining: -1 });
    expect(status.green).toEqual({ limit: null, count: 0, remaining: null });
  });

  /**
   * An entry nobody has judged yet has no colour to charge. Counting it towards one would make
   * confirming a food in the review queue silently move a number about what was eaten.
   */
  it('counts unclassified entries separately and charges them to no category', () => {
    const status = computeBudgetStatus(entries('unclassified', 'unclassified', 'green'), {
      green: 1,
      yellow: 1,
      orange: 1,
    });

    expect(status.unclassified).toBe(2);
    expect(status.green.count).toBe(1);
    expect(status.yellow.count).toBe(0);
    expect(status.orange.count).toBe(0);
  });

  it('reports a week with nothing logged as zeroes rather than as nothing', () => {
    const status = computeBudgetStatus([], { ...UNLIMITED, yellow: 5 });

    expect(status.yellow).toEqual({ limit: 5, count: 0, remaining: 5 });
    expect(status.unclassified).toBe(0);
  });
});
