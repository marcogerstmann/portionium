import type { LocalDate } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { computeWeightTrend, WEIGHT_TREND, type WeightReading } from './weight-trend.js';

/**
 * Synthetic series, because the cases worth testing are the ones a database fixture cannot
 * state: a month of pure noise, a decline of a known slope, a fortnight nobody weighed. The
 * function takes readings and returns numbers, so every one of them is an array literal.
 */

const DAY = 86_400_000;

/** One entry per day from `start`, null for a day nobody stood on the scale. */
function series(start: LocalDate, grams: readonly (number | null)[]): WeightReading[] {
  return grams.flatMap((weightGrams, index) => {
    if (weightGrams === null) {
      return [];
    }

    const localDate = new Date(Date.parse(start) + index * DAY).toISOString().slice(0, 10);
    return [{ localDate, weightGrams, recordedAt: new Date(`${localDate}T07:00:00.000Z`) }];
  });
}

function shift(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(date) + days * DAY).toISOString().slice(0, 10);
}

/** The whole series as one range, so a test asserts about days rather than about a window. */
function trendOver(readings: readonly WeightReading[], days: number, halfLifeDays?: number) {
  return computeWeightTrend(readings, {
    from: '2026-03-01',
    to: shift('2026-03-01', days - 1),
    ...(halfLifeDays === undefined ? {} : { halfLifeDays }),
  });
}

describe('computeWeightTrend', () => {
  it('produces a trend from the very first reading, flagged as low confidence', () => {
    const { days } = trendOver(series('2026-03-02', [80_000]), 3);

    expect(days.map((day) => day.trendGrams)).toEqual([null, 80_000, 80_000]);
    expect(days.map((day) => day.lowConfidence)).toEqual([true, true, true]);
    // The day before the first reading has no trend, and no raw value either.
    expect(days[0]?.rawGrams).toBeNull();
  });

  it('stops flagging low confidence on the third consecutive daily reading', () => {
    const { days } = trendOver(series('2026-03-01', [80_000, 80_000, 80_000, 80_000]), 4);

    expect(days.map((day) => day.lowConfidence)).toEqual([true, true, false, false]);
  });

  it('flags low confidence again once the value behind it has gone stale', () => {
    // Ten daily readings, then silence. Nothing new is wrong, it is just old.
    const readings = series(
      '2026-03-01',
      Array.from({ length: 10 }, () => 80_000),
    );
    const { days } = trendOver(readings, 40);

    expect(days[9]?.lowConfidence).toBe(false);
    expect(days[20]?.lowConfidence).toBe(false);
    expect(days[35]?.lowConfidence).toBe(true);
  });

  it('holds a flat series flat, whatever the daily noise does', () => {
    // Up to seven hundred grams either side of 80 kg and summing to nothing, which is the
    // ordinary swing of water, salt and a late dinner around a weight that is not moving.
    const noise = [600, -500, 300, -700, 400, 200, -600, 500, -300, 700, -400, -200];
    const readings = series(
      '2026-03-01',
      Array.from({ length: 36 }, (_, index) => 80_000 + (noise[index % noise.length] ?? 0)),
    );

    const { days, change } = trendOver(readings, 36);

    // From two half lives in, once the first reading has stopped being most of the answer.
    for (const day of days.slice(20)) {
      expect(day.trendGrams).toBeGreaterThan(79_800);
      expect(day.trendGrams).toBeLessThan(80_200);
    }

    // The point of the whole exercise: a month of noise reads as a month of nothing. What is
    // left is the first reading, which happened to be a heavy one, washing out of the average.
    expect(Math.abs(change.changePerWeekGrams ?? 0)).toBeLessThan(150);
  });

  it('reports a steady decline at its real rate per week, lagging behind the raw reading', () => {
    // A hundred grams a day, which is seven hundred a week.
    const readings = series(
      '2026-03-01',
      Array.from({ length: 60 }, (_, index) => 80_000 - index * 100),
    );

    // Measured over the second month, the way the endpoint measures any range: the trend
    // entering it has already been warmed by everything before it. Over the first month the
    // same series reads as roughly -540 a week, because a trend that starts on the first
    // reading starts with no lag and spends a half life acquiring it.
    const { days, change } = computeWeightTrend(readings, {
      from: '2026-03-31',
      to: '2026-04-29',
    });
    const last = days.at(-1);

    expect(change.changePerWeekGrams).toBeGreaterThan(-700);
    expect(change.changePerWeekGrams).toBeLessThan(-600);

    // The cost of the smoothing, stated rather than hidden: on a steady slope the trend sits
    // about a half life behind, roughly 1.4 kg at this rate. See the ADR.
    expect((last?.trendGrams ?? 0) - (last?.rawGrams ?? 0)).toBeGreaterThan(1_200);
    expect((last?.trendGrams ?? 0) - (last?.rawGrams ?? 0)).toBeLessThan(1_500);
  });

  it('carries the trend flat across a two week gap and lets the reading that ends it move most of the way', () => {
    const readings = [
      ...series(
        '2026-03-01',
        Array.from({ length: 10 }, () => 80_000),
      ),
      ...series('2026-03-25', [78_000]),
    ];

    const { days } = trendOver(readings, 25);

    // Nothing is imputed into the gap. The last thing known stays the best estimate of today.
    for (const day of days.slice(10, 24)) {
      expect(day.rawGrams).toBeNull();
      expect(day.trendGrams).toBeCloseTo(80_000, 0);
    }

    // The moving average, which has no such memory, goes blank a week after the last reading.
    expect(days[15]?.movingAverageGrams).toBe(80_000);
    for (const day of days.slice(16, 24)) {
      expect(day.movingAverageGrams).toBeNull();
    }

    // Fourteen days is not quite a half life and a half, so the new reading carries about
    // sixty percent of the weight: the trend lands near 78.8 rather than crawling from 80.
    expect(days.at(-1)?.trendGrams).toBeGreaterThan(78_600);
    expect(days.at(-1)?.trendGrams).toBeLessThan(79_000);
  });

  it('averages whatever readings the trailing week holds, and nothing when it holds none', () => {
    const readings = series('2026-03-01', [80_000, null, null, 81_000, null, null, null, 82_000]);
    const { days } = trendOver(readings, 16);

    expect(days[0]?.movingAverageGrams).toBe(80_000);
    expect(days[3]?.movingAverageGrams).toBe(80_500);
    // The 1st has fallen out of the seven day window by the 8th, the 4th and the 8th have not.
    expect(days[7]?.movingAverageGrams).toBe(81_500);
    expect(days[14]?.movingAverageGrams).toBeNull();
  });

  it('measures the previous period over an equally long stretch immediately before the range', () => {
    // A fortnight losing a hundred grams a day, then a fortnight holding steady.
    const readings = series('2026-03-01', [
      ...Array.from({ length: 14 }, (_, index) => 82_000 - index * 100),
      ...Array.from({ length: 14 }, () => 80_600),
    ]);

    const { change, previous } = computeWeightTrend(readings, {
      from: '2026-03-22',
      to: '2026-03-28',
    });

    expect(previous.from).toBe('2026-03-15');
    expect(previous.to).toBe('2026-03-21');

    // Both weeks are flat in the raw readings and both still fall, because the trend is paying
    // off the lag it took on during the decline. The comparison is the answer: this week fell
    // less than the week before it, which is the decline levelling out.
    expect(change.changeGrams ?? 0).toBeLessThan(0);
    expect(previous.changeGrams ?? 0).toBeLessThan(0);
    expect(change.changeGrams ?? 0).toBeGreaterThan(previous.changeGrams ?? 0);
  });

  it('subtracts the two periods itself, so nothing downstream has to', () => {
    const readings = series('2026-03-01', [
      ...Array.from({ length: 14 }, (_, index) => 82_000 - index * 100),
      ...Array.from({ length: 14 }, () => 80_600),
    ]);

    const { change, previous, versusPrevious } = computeWeightTrend(readings, {
      from: '2026-03-22',
      to: '2026-03-28',
    });

    expect(versusPrevious.differenceGrams).toBeCloseTo(
      (change.changeGrams ?? 0) - (previous.changeGrams ?? 0),
      6,
    );
    expect(versusPrevious.differencePerWeekGrams).toBeCloseTo(
      (change.changePerWeekGrams ?? 0) - (previous.changePerWeekGrams ?? 0),
      6,
    );

    // Both weeks fell and this one fell less, so the movement moved upward against the week
    // before it: the decline is levelling out rather than reversing.
    expect(versusPrevious.differenceGrams ?? 0).toBeGreaterThan(0);
  });

  it('reads a loss that got faster as a negative difference', () => {
    // Flat for a fortnight, then a hundred grams a day off for a fortnight.
    const readings = series('2026-03-01', [
      ...Array.from({ length: 14 }, () => 82_000),
      ...Array.from({ length: 14 }, (_, index) => 82_000 - (index + 1) * 100),
    ]);

    const { versusPrevious } = computeWeightTrend(readings, {
      from: '2026-03-22',
      to: '2026-03-28',
    });

    expect(versusPrevious.differenceGrams ?? 0).toBeLessThan(0);
    expect(versusPrevious.differencePerWeekGrams ?? 0).toBeLessThan(0);
  });

  it('has no comparison when the period before the range has no trend behind it', () => {
    // The first reading lands inside the range, so there is nothing to compare it against.
    const { previous, versusPrevious } = computeWeightTrend(series('2026-03-08', [80_000]), {
      from: '2026-03-08',
      to: '2026-03-14',
    });

    expect(previous.changeGrams).toBeNull();
    expect(versusPrevious).toEqual({ differenceGrams: null, differencePerWeekGrams: null });
  });

  it('measures the change between the days that have a trend, not the edges of the range', () => {
    const { change } = computeWeightTrend(series('2026-03-05', [80_000, 79_000]), {
      from: '2026-03-01',
      to: '2026-03-10',
    });

    expect(change.from).toBe('2026-03-05');
    expect(change.to).toBe('2026-03-10');
  });

  it('answers a range with no readings behind it at all with nulls rather than zeroes', () => {
    const { days, change, previous } = trendOver([], 3);

    expect(days.map((day) => day.trendGrams)).toEqual([null, null, null]);
    expect(change).toEqual({ from: null, to: null, changeGrams: null, changePerWeekGrams: null });
    expect(previous.changeGrams).toBeNull();
    expect(trendOver([], 3).versusPrevious.differenceGrams).toBeNull();
  });

  it('has no rate per week for a single day, where a rate would be a division by zero', () => {
    const { change } = computeWeightTrend(series('2026-03-01', [80_000]), {
      from: '2026-03-01',
      to: '2026-03-01',
    });

    expect(change.changeGrams).toBe(0);
    expect(change.changePerWeekGrams).toBeNull();
  });

  it('takes the most recently recorded reading when somebody weighed twice in a day', () => {
    const readings: WeightReading[] = [
      {
        localDate: '2026-03-01',
        weightGrams: 80_000,
        recordedAt: new Date('2026-03-01T07:00:00Z'),
      },
      {
        localDate: '2026-03-01',
        weightGrams: 81_000,
        recordedAt: new Date('2026-03-01T19:00:00Z'),
      },
    ];

    expect(trendOver(readings, 1).days[0]?.rawGrams).toBe(81_000);
  });

  it('ignores readings after the end of the range, so backfilling later cannot rewrite it', () => {
    const readings = series('2026-03-01', [80_000, 70_000]);
    const { days } = computeWeightTrend(readings, { from: '2026-03-01', to: '2026-03-01' });

    expect(days).toHaveLength(1);
    expect(days[0]?.trendGrams).toBe(80_000);
  });

  it('tracks the raw reading more closely as the half life shortens', () => {
    const readings = series('2026-03-01', [80_000, 80_000, 80_000, 80_000, 78_000]);

    const slow = trendOver(readings, 5, 20).days.at(-1)?.trendGrams ?? 0;
    const fast = trendOver(readings, 5, 2).days.at(-1)?.trendGrams ?? 0;
    const standard = trendOver(readings, 5).days.at(-1)?.trendGrams ?? 0;

    expect(fast).toBeLessThan(standard);
    expect(standard).toBeLessThan(slow);
    expect(WEIGHT_TREND.halfLifeDays).toBe(10);
  });
});
