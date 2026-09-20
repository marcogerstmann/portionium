import type { WeeklyBudgets } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { computeBudgetStatus } from './budget.js';
import type { DateRangeEntry } from './stats.js';

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

  it('treats a limit of zero as none this week rather than as unlimited', () => {
    const status = computeBudgetStatus(entries('orange'), { ...UNLIMITED, orange: 0 });

    expect(status.orange).toEqual({ limit: 0, count: 1, remaining: -1 });
    expect(status.green).toEqual({ limit: null, count: 0, remaining: null });
  });

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
