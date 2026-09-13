import type {
  ColourCounts,
  DayColourStats,
  LocalDate,
  WeightTrendChange,
  WeightTrendComparison,
  WeightTrendDay,
} from '@portionium/schemas';

import { shiftDate } from './db';

/**
 * The arithmetic behind the statistics screen: which range to ask for, what the numbers add up
 * to, what they are called, and where the line goes.
 *
 * Separate from ./statistics.tsx for the reason ./day.ts is separate from ./today.tsx: none of it
 * needs React, a DOM or IndexedDB, so all of it is testable as plain functions and the screen
 * itself is left to the browser tests.
 *
 * Nothing here computes a statistic. The server resolves the classifications, smooths the
 * trend and subtracts the previous period, and every number below is one of its answers sliced,
 * summed over a window or turned into a sentence. A second implementation of the smoothing on
 * this side would be a second answer to one question, which is the mistake ./food-search.ts
 * already refuses to make about ranking.
 */

/** The windows the colour distribution is shown over, in days. */
export const COLOUR_WINDOWS = [7, 30, 90] as const;

/**
 * How many days the chart covers, and the whole of what a wider screen buys.
 *
 * A desktop gets a longer history rather than a second arrangement of the same one: the content
 * is a line and three lists, which a phone reads top to bottom exactly as well, so the extra
 * room is worth more as more days than as columns. See useWide in ./stats.tsx.
 */
export const CHART_DAYS = { narrow: 30, wide: 90 };

/** The colour distribution is asked for over the widest window and sliced for the others. */
export const COLOUR_DAYS = COLOUR_WINDOWS.at(-1) ?? 90;

/** How many ISO weeks the summary lists. Two months, which is where a habit becomes visible. */
export const SUMMARY_WEEKS = 8;

/** The `from` and `to` of a window of days ending today, both inclusive as the API takes them. */
export function rangeEnding(today: LocalDate, days: number): { from: LocalDate; to: LocalDate } {
  return { from: shiftDate(today, -(days - 1)), to: today };
}

/**
 * The colours of the last `window` days, added up.
 *
 * The tail of the array rather than a date comparison, because the API answers with one entry
 * per date in the range and fills the gaps itself, so position is the date, see
 * computeDailyColourStats in api/src/domain/stats.ts.
 */
export function totalColours(days: readonly DayColourStats[], window: number): ColourCounts {
  const totals: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

  for (const day of days.slice(-window)) {
    totals.green += day.counts.green;
    totals.yellow += day.counts.yellow;
    totals.orange += day.counts.orange;
    totals.unclassified += day.counts.unclassified;
  }

  return totals;
}

/**
 * A set of counts as a sentence, which is what a screen reader is given wherever the colours
 * themselves are the only thing on screen.
 *
 * Colour never carries a meaning alone here, and this is the third channel: the letter inside
 * each disc is the second, for whoever cannot tell this palette's green from its orange, and
 * this is for whoever is not looking at it at all. The unclassified count is named only when
 * there is one, because "0 not classified yet" is a fact nobody needed.
 */
export function spokenCounts(counts: ColourCounts): string {
  return [
    `${counts.green} green`,
    `${counts.yellow} yellow`,
    `${counts.orange} orange`,
    ...(counts.unclassified > 0 ? [`${counts.unclassified} not classified yet`] : []),
  ].join(', ');
}

/**
 * Why the line should not be drawn, or nothing when it should.
 *
 * The judgement is the server's, not this file's. `trendKg` is null only before the first
 * reading anybody made, and `lowConfidence` is set when the value is real but thin, too few
 * readings behind it or too old ones, see WEIGHT_TREND.minEvidence in
 * api/src/domain/weight-trend.ts. Drawing a confident line through two readings a fortnight
 * apart is exactly the misleading picture this product exists to stop showing, so in both cases
 * the screen says what it does not know and shows the readings on their own.
 *
 * The last day of the range is the one asked, because a trend is a position and the position
 * that matters is today's. A range that opens with nothing and fills up later is a screen that
 * has enough data, and one that ends in three weeks of silence is not.
 */
export function trendCaveat(days: readonly WeightTrendDay[]): string | undefined {
  const latest = days.at(-1);

  if (latest === undefined || latest.trendKg === null) {
    return 'No weight recorded yet. Record one and the trend starts here.';
  }

  return latest.lowConfidence
    ? 'Not enough readings yet for a meaningful trend. The dots are what was on the scale.'
    : undefined;
}

/** The most recent thing that was actually on the scale, which is what an entry field offers. */
export function lastReading(days: readonly WeightTrendDay[]): number | undefined {
  return days.findLast((day) => day.rawKg !== null)?.rawKg ?? undefined;
}

/** A signed weight movement, or the honest absence of one. Never an em dash, never a zero. */
export function changeLabel(changeKg: number | null): string {
  if (changeKg === null) {
    return 'no trend yet';
  }

  // toFixed on a negative already carries the sign, so only the upward case needs one added.
  return `${changeKg > 0 ? '+' : ''}${changeKg.toFixed(1)} kg`;
}

/**
 * What the range did, in words.
 *
 * Measured on the trend rather than on the readings, which is the server's doing: `change` is
 * the difference between the first and last day of the range that carry a trend at all, so this
 * sentence cannot swing on whether the last day happened to be a salty one.
 */
export function changeSentence(change: WeightTrendChange, days: number): string {
  if (change.changeKg === null) {
    return `Nothing to report over ${days} days yet.`;
  }

  const direction = change.changeKg < 0 ? 'Down' : change.changeKg > 0 ? 'Up' : 'Level over';
  const moved = `${direction} ${Math.abs(change.changeKg).toFixed(1)} kg over ${days} days`;

  return change.changePerWeekKg === null
    ? `${moved}.`
    : `${moved}, ${Math.abs(change.changePerWeekKg).toFixed(2)} kg a week.`;
}

/**
 * The same movement against the stretch of days before it, which is the comparison that makes a
 * number mean something: half a kilo down is good news or bad news entirely depending on what
 * the fortnight before it did.
 *
 * Already subtracted by the server, so the sign is read rather than derived, see
 * weightTrendComparisonSchema. Negative is downward against the period before, a loss that got
 * faster or a gain that slowed.
 */
export function versusSentence(versus: WeightTrendComparison): string | undefined {
  const difference = versus.differencePerWeekKg;

  if (difference === null || difference === 0) {
    return difference === 0 ? 'The same rate as the period before.' : undefined;
  }

  const rate = `${Math.abs(difference).toFixed(2)} kg a week`;

  return difference < 0
    ? `${rate} further down than the period before.`
    : `${rate} further up than the period before.`;
}

/** What one ISO week is called on screen. */
export function weekLabel(week: { startDate: LocalDate; endDate: LocalDate }): string {
  // In UTC, the same rule dayLabel follows: a LocalDate has already had a timezone applied to
  // it and carries none of its own, so rendering it anywhere else moves it across a boundary.
  // formatRange is the platform's own range formatting, which collapses a shared month by
  // itself and orders the parts the way the reader's locale does.
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).formatRange(new Date(`${week.startDate}T00:00:00Z`), new Date(`${week.endDate}T00:00:00Z`));
}

/**
 * The chart, as coordinates.
 *
 * `width` grows with the number of days rather than being fixed, which is what keeps the drawn
 * scale close to one at both phone and desktop width: a fixed viewBox stretched to a wide screen
 * would inflate every dot and every stroke with it, and the line is supposed to be the prominent
 * thing at any size rather than the fattest.
 */
export const CHART = { step: 8, height: 120, pad: 10 };

export interface ChartGeometry {
  width: number;
  height: number;
  /** The trend, as a polyline's `points`. Empty when no day in the range carries one. */
  line: string;
  /** What was actually on the scale, on the days somebody stood on it. */
  raw: { x: number; y: number }[];
}

export function chartGeometry(days: readonly WeightTrendDay[]): ChartGeometry {
  const width = Math.max(1, days.length - 1) * CHART.step + 2 * CHART.pad;
  const { height, pad } = CHART;

  const values = days.flatMap((day) => [day.trendKg, day.rawKg].filter((v) => v !== null));
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A flat series, a single reading, or none at all. Anything divided by that span is infinite,
  // so the whole line sits on the middle instead, which is what a chart of one value looks like.
  const span = high - low;

  const x = (index: number) =>
    days.length < 2 ? width / 2 : pad + (index * (width - 2 * pad)) / (days.length - 1);
  const y = (value: number) =>
    span > 0 ? height - pad - ((value - low) / span) * (height - 2 * pad) : height / 2;

  return {
    width,
    height,
    line: days
      .flatMap((day, index) => (day.trendKg === null ? [] : [`${x(index)},${y(day.trendKg)}`]))
      .join(' '),
    raw: days.flatMap((day, index) =>
      day.rawKg === null ? [] : [{ x: x(index), y: y(day.rawKg) }],
    ),
  };
}
