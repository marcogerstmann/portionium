import { describe, expect, it } from 'vitest';

import { computeDailyColourStats, everyLocalDate } from './stats.js';

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
    const stats = computeDailyColourStats([], '2026-03-01', '2026-03-02');

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

  it('groups entries by local date and counts each into the colour it was logged with', () => {
    const stats = computeDailyColourStats(
      [
        { category: 'green', localDate: '2026-03-01' },
        { category: 'green', localDate: '2026-03-01' },
        { category: 'orange', localDate: '2026-03-01' },
        { category: 'orange', localDate: '2026-03-02' },
      ],
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

  it('counts an entry still waiting for a colour as unclassified, never as a colour', () => {
    const stats = computeDailyColourStats(
      [{ category: null, localDate: '2026-03-01' }],
      '2026-03-01',
      '2026-03-01',
    );

    expect(stats[0]?.counts).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 1 });
  });

  it('reports each count as a share of the day, and never divides by zero', () => {
    const stats = computeDailyColourStats(
      [
        { category: 'green', localDate: '2026-03-01' },
        { category: 'green', localDate: '2026-03-01' },
        { category: 'orange', localDate: '2026-03-01' },
        { category: null, localDate: '2026-03-02' },
      ],
      '2026-03-01',
      '2026-03-02',
    );

    expect(stats[0]?.share).toEqual({ green: 2 / 3, yellow: 0, orange: 1 / 3, unclassified: 0 });
    // A day of nothing but one unclassified entry is entirely unclassified, not a NaN.
    expect(stats[1]?.share).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 1 });
  });
});
