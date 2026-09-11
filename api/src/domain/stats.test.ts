import type { Category } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { computeDailyColourStats, everyLocalDate } from './stats.js';

const GREEN_FOOD = 'green-food';
const ORANGE_FOOD = 'orange-food';
const UNJUDGED_FOOD = 'unjudged-food';

function resolved(entries: Record<string, Category>): Map<string, { category: Category }> {
  return new Map(Object.entries(entries).map(([foodId, category]) => [foodId, { category }]));
}

describe('everyLocalDate', () => {
  it('lists every date from `from` to `to`, both included', () => {
    expect(everyLocalDate('2026-03-01', '2026-03-03')).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
    ]);
  });

  it('returns exactly one date when `from` equals `to`', () => {
    expect(everyLocalDate('2026-03-01', '2026-03-01')).toEqual(['2026-03-01']);
  });

  it('crosses a month boundary correctly, since a LocalDate is calendar arithmetic and not a fixed-width string', () => {
    expect(everyLocalDate('2026-01-30', '2026-02-02')).toEqual([
      '2026-01-30',
      '2026-01-31',
      '2026-02-01',
      '2026-02-02',
    ]);
  });
});

describe('computeDailyColourStats', () => {
  it('fills every day in the range with zero counts when nothing was logged', () => {
    const stats = computeDailyColourStats([], new Map(), '2026-03-01', '2026-03-02');

    expect(stats).toEqual([
      {
        date: '2026-03-01',
        counts: { green: 0, yellow: 0, orange: 0, unclassified: 0 },
        share: { green: 0, yellow: 0, orange: 0, unclassified: 0 },
      },
      {
        date: '2026-03-02',
        counts: { green: 0, yellow: 0, orange: 0, unclassified: 0 },
        share: { green: 0, yellow: 0, orange: 0, unclassified: 0 },
      },
    ]);
  });

  it('groups items by local date and counts each into its resolved colour', () => {
    const stats = computeDailyColourStats(
      [
        { foodId: GREEN_FOOD, localDate: '2026-03-01' },
        { foodId: GREEN_FOOD, localDate: '2026-03-01' },
        { foodId: ORANGE_FOOD, localDate: '2026-03-01' },
        { foodId: ORANGE_FOOD, localDate: '2026-03-02' },
      ],
      resolved({ [GREEN_FOOD]: 'green', [ORANGE_FOOD]: 'orange' }),
      '2026-03-01',
      '2026-03-02',
    );

    expect(stats[0]).toMatchObject({
      date: '2026-03-01',
      counts: { green: 2, yellow: 0, orange: 1, unclassified: 0 },
    });
    expect(stats[1]).toMatchObject({
      date: '2026-03-02',
      counts: { green: 0, yellow: 0, orange: 1, unclassified: 0 },
    });
  });

  it('counts a food with no resolved verdict as unclassified, never as a colour', () => {
    const stats = computeDailyColourStats(
      [{ foodId: UNJUDGED_FOOD, localDate: '2026-03-01' }],
      new Map(),
      '2026-03-01',
      '2026-03-01',
    );

    expect(stats[0]?.counts).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 1 });
  });

  it('reports each count as a share of the day, and never divides by zero', () => {
    const stats = computeDailyColourStats(
      [
        { foodId: GREEN_FOOD, localDate: '2026-03-01' },
        { foodId: GREEN_FOOD, localDate: '2026-03-01' },
        { foodId: ORANGE_FOOD, localDate: '2026-03-01' },
        { foodId: UNJUDGED_FOOD, localDate: '2026-03-02' },
      ],
      resolved({ [GREEN_FOOD]: 'green', [ORANGE_FOOD]: 'orange' }),
      '2026-03-01',
      '2026-03-02',
    );

    expect(stats[0]?.share).toEqual({ green: 2 / 3, yellow: 0, orange: 1 / 3, unclassified: 0 });
    // A day of nothing but one unclassified item is entirely unclassified, not a NaN.
    expect(stats[1]?.share).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 1 });
  });
});
