import type { ColourCounts } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import type { DailyColourStats } from './stats.js';
import type { WeightTrendDay } from './weight-trend.js';
import { computeWeeklySummary, isoWeeksEnding, WEEKLY_SUMMARY } from './weekly-summary.js';

/**
 * Both `computeDailyColourStats` and `computeWeightTrend` are exercised against a database
 * elsewhere; what belongs here is grouping days already computed into weeks, over array
 * literals rather than fixtures, same reasoning as weight-trend.test.ts.
 */

const ZERO: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

function day(date: string, counts: Partial<ColourCounts> = {}): DailyColourStats {
  const merged = { ...ZERO, ...counts };
  const total = merged.green + merged.yellow + merged.orange + merged.unclassified;
  const share =
    total === 0
      ? ZERO
      : {
          green: merged.green / total,
          yellow: merged.yellow / total,
          orange: merged.orange / total,
          unclassified: merged.unclassified / total,
        };

  return { date, counts: merged, share };
}

function weightDay(date: string, trendGrams: number | null): WeightTrendDay {
  return {
    date,
    trendGrams,
    lowConfidence: false,
    movingAverageGrams: trendGrams,
    rawGrams: trendGrams,
  };
}

describe('isoWeeksEnding', () => {
  it('lists Monday to Sunday spans, oldest first, ending with the week `today` falls in', () => {
    // 2026-03-11 is a Wednesday, ISO week 11.
    const weeks = isoWeeksEnding('2026-03-11', 2);

    expect(weeks).toEqual([
      { isoYear: 2026, isoWeek: 10, startDate: '2026-03-02', endDate: '2026-03-08' },
      { isoYear: 2026, isoWeek: 11, startDate: '2026-03-09', endDate: '2026-03-15' },
    ]);
  });

  it('crosses a year boundary the way the ISO week calendar actually does, not the way a January week naively would', () => {
    // 2026-01-01 is a Thursday and belongs to ISO week 1 of 2026, whose Monday is in 2025.
    const weeks = isoWeeksEnding('2026-01-01', 2);

    expect(weeks).toEqual([
      { isoYear: 2025, isoWeek: 52, startDate: '2025-12-22', endDate: '2025-12-28' },
      { isoYear: 2026, isoWeek: 1, startDate: '2025-12-29', endDate: '2026-01-04' },
    ]);
  });
});

describe('computeWeeklySummary', () => {
  it("sums a week's days into one colour breakdown and counts how many had any logging", () => {
    const weeks = isoWeeksEnding('2026-03-08', 1); // Monday 2026-03-02 .. Sunday 2026-03-08
    const withComparisonWeek = [...isoWeeksEnding('2026-02-22', 1), ...weeks];

    const dailyColours = [
      day('2026-03-02', { green: 2 }),
      day('2026-03-03', { orange: 1 }),
      // The rest of the week logged nothing.
    ];

    const [week] = computeWeeklySummary(dailyColours, [], withComparisonWeek);

    expect(week).toMatchObject({
      startDate: '2026-03-02',
      endDate: '2026-03-08',
      counts: { green: 2, yellow: 0, orange: 1, unclassified: 0 },
      daysLogged: 2,
    });
  });

  it('flags a week sparse below the threshold and not at or above it', () => {
    const previous = isoWeeksEnding('2026-02-22', 1);
    const target = isoWeeksEnding('2026-03-08', 1);

    const sparseDays = [day('2026-03-02', { green: 1 }), day('2026-03-03', { green: 1 })];
    const fullDays = Array.from({ length: WEEKLY_SUMMARY.sparseThresholdDays }, (_, i) =>
      day(`2026-03-0${i + 2}`, { green: 1 }),
    );

    expect(computeWeeklySummary(sparseDays, [], [...previous, ...target])[0]?.sparse).toBe(true);
    expect(computeWeeklySummary(fullDays, [], [...previous, ...target])[0]?.sparse).toBe(false);
  });

  it('reports the difference against the previous week as a signed count, not a percentage', () => {
    const previous = isoWeeksEnding('2026-02-22', 1); // 2026-02-16 .. 2026-02-22
    const target = isoWeeksEnding('2026-03-08', 1); // 2026-03-02 .. 2026-03-08

    const dailyColours = [
      day('2026-02-16', { green: 1 }),
      day('2026-03-02', { green: 3 }),
      day('2026-03-03', { orange: 1 }),
    ];

    const [week] = computeWeeklySummary(dailyColours, [], [...previous, ...target]);

    expect(week?.versusPreviousWeek).toEqual({ green: 2, yellow: 0, orange: 1, unclassified: 0 });
  });

  it('drops the leading comparison week from the result, it is consumed rather than returned', () => {
    const previous = isoWeeksEnding('2026-02-22', 1);
    const target = isoWeeksEnding('2026-03-08', 2);

    const weeks = computeWeeklySummary([], [], [...previous, ...target]);

    expect(weeks).toHaveLength(2);
    expect(weeks.map((week) => week.startDate)).toEqual(target.map((week) => week.startDate));
  });

  it("carries the trend value at the week's first and last day, and the rate between them", () => {
    const previous = isoWeeksEnding('2026-02-22', 1);
    const target = isoWeeksEnding('2026-03-08', 1); // 2026-03-02 .. 2026-03-08

    const weightDays = [
      weightDay('2026-03-02', 80_000),
      weightDay('2026-03-03', 79_900),
      weightDay('2026-03-04', 79_800),
      weightDay('2026-03-05', 79_700),
      weightDay('2026-03-06', 79_600),
      weightDay('2026-03-07', 79_500),
      weightDay('2026-03-08', 79_400),
    ];

    const [week] = computeWeeklySummary([], weightDays, [...previous, ...target]);

    expect(week?.weight.startGrams).toBe(80_000);
    expect(week?.weight.endGrams).toBe(79_400);
    expect(week?.weight.changeGrams).toBe(-600);
    // A six day span, so per-week is not equal to the raw change.
    expect(week?.weight.changePerWeekGrams).toBeCloseTo((-600 / 6) * 7);
  });

  it('reports every weight field as null when the account has no trend at all', () => {
    const previous = isoWeeksEnding('2026-02-22', 1);
    const target = isoWeeksEnding('2026-03-08', 1);

    const weightDays = Array.from({ length: 7 }, (_, i) => weightDay(`2026-03-0${i + 2}`, null));

    const [week] = computeWeeklySummary([], weightDays, [...previous, ...target]);

    expect(week?.weight).toEqual({
      startGrams: null,
      endGrams: null,
      changeGrams: null,
      changePerWeekGrams: null,
    });
  });
});
