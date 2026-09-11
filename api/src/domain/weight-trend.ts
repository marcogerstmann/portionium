import type { LocalDate } from '@portionium/schemas';

import { everyLocalDate } from './stats.js';
import { daysBetween } from './weight.js';

/**
 * POR-37: what the scale is saying once the water is taken out of it.
 *
 * A daily weight is mostly noise. Salt, a late meal, how much of yesterday is still in the gut,
 * the time of day, all of it moves the number by more than a week of real change does. Showing
 * that number as the headline is what makes people conclude a good week failed, which is the
 * frustration this app exists to remove. So the raw reading is carried, and it is never the
 * primary field: the smoothed trend is.
 *
 * The trend is an exponentially weighted moving average whose smoothing factor is derived from
 * the days actually elapsed, `1 - 0.5 ** (gap / halfLife)`, rather than fixed per sample. That
 * is the whole of the gap handling: nothing is imputed, interpolated or carried into the
 * average, a reading after a fortnight's silence simply arrives against a trend that has decayed
 * to a fifth of its weight. Why this and not a plain moving average or a Kalman filter, where
 * the half life comes from, and the lag it costs, are in
 * docs/adr/008-weight-trend-smoothing.md.
 *
 * Pure, and deliberately so. Everything it needs is passed in, so the interesting cases, a flat
 * series with noise, a steady decline, a fortnight nobody weighed, are a literal array in a unit
 * test rather than a fixture in a database.
 */

/** The knobs. Exported because they are judgement calls, not facts, see the ADR for each. */
export const WEIGHT_TREND = {
  /**
   * How long it takes a reading to lose half its influence on the trend. Ten days keeps a
   * fortnight of real change visible while a single heavy dinner moves the line by grams. The
   * default a caller gets when it passes none, see WEIGHT_TREND_HALF_LIFE_DAYS in config.ts for
   * where an operator overrides it.
   */
  halfLifeDays: 10,
  /**
   * The window of the plain moving average carried beside the trend. Seven days because it
   * covers exactly one of everyone's weekly cycle of eating, which is the pattern a shorter
   * window shows as a wave and a longer one buries.
   */
  movingAverageDays: 7,
  /**
   * How much evidence a trend needs before it stops being flagged as low confidence, counted in
   * readings discounted by their age, see the loop below. Two is reached by the third
   * consecutive daily weigh-in, or the third weekly one, and is lost again after roughly three
   * weeks of not weighing at all.
   */
  minEvidence: 2,
};

/** The little a trend needs of a reading. A record from the database satisfies it. */
export interface WeightReading {
  localDate: LocalDate;
  weightGrams: number;
  recordedAt: Date;
}

/**
 * One day of the line. `trendGrams` is the answer and is null only before the first reading
 * anybody made; `rawGrams` is the reading itself, present on the days somebody weighed and null
 * on the days they did not.
 */
export interface WeightTrendDay {
  date: LocalDate;
  trendGrams: number | null;
  /** The value is real but thin: too few readings behind it, or too old ones. */
  lowConfidence: boolean;
  movingAverageGrams: number | null;
  rawGrams: number | null;
}

/**
 * Movement over a stretch of days, measured on the trend rather than on the raw readings, so
 * the answer does not depend on whether the last day of a range happened to be a salty one.
 *
 * `from` and `to` are the days actually measured between, which are the first and last days in
 * the stretch that carry a trend at all, not necessarily its edges. A range that starts a week
 * before anybody weighed still reports the change over the part that has data, and says which
 * part that was.
 */
export interface WeightTrendChange {
  from: LocalDate | null;
  to: LocalDate | null;
  changeGrams: number | null;
  /**
   * The same change expressed per week, which is the timescale people reason about: nobody has
   * a feel for grams per day, and everybody has a feel for half a kilo a week. Null when the
   * stretch measured is a single day, where a rate would be a division by zero.
   */
  changePerWeekGrams: number | null;
}

/**
 * The range against the stretch before it, subtracted here rather than left to a client: one
 * number of kilos is not an answer on its own, and every client that drew a comparison itself
 * would be a second place this arithmetic could be got wrong.
 *
 * Both are this period's figure minus the previous one's, so the sign says which way the
 * movement itself moved. Negative is downward against the period before, which is a loss that
 * got faster or a gain that slowed; positive is the reverse. Null when either period has no
 * trend to compare, or when the rate is missing on either side because it spans a single day.
 */
export interface WeightTrendComparison {
  differenceGrams: number | null;
  differencePerWeekGrams: number | null;
}

export interface WeightTrend {
  days: WeightTrendDay[];
  change: WeightTrendChange;
  /** The same measurement over the equally long stretch of days immediately before the range. */
  previous: WeightTrendChange;
  versusPrevious: WeightTrendComparison;
}

export interface WeightTrendOptions {
  from: LocalDate;
  to: LocalDate;
  halfLifeDays?: number | undefined;
}

/** Calendar arithmetic on a zoneless date, the same idiom everyLocalDate uses. */
function shiftLocalDate(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One reading per day, oldest first. People weigh themselves twice and both readings are real,
 * see the comment on weight_entry, but a day contributes one point to a trend: the most recently
 * recorded one, the same reading GET /days/{date} calls the day's weight.
 *
 * Readings after `to` are dropped rather than smoothed in. The answer to "how did the fortnight
 * to the 14th go" must not change because somebody later backfilled the 20th.
 */
function dailyReadings(readings: readonly WeightReading[], to: LocalDate): WeightReading[] {
  const byDate = new Map<LocalDate, WeightReading>();
  for (const reading of readings) {
    if (reading.localDate > to) {
      continue;
    }

    const kept = byDate.get(reading.localDate);
    if (kept === undefined || kept.recordedAt <= reading.recordedAt) {
      byDate.set(reading.localDate, reading);
    }
  }

  return [...byDate.values()].sort((a, b) => a.localDate.localeCompare(b.localDate));
}

/**
 * The mean of whatever readings fall in the trailing window, and null when none do. It averages
 * what is there rather than demanding a full week, because demanding one would blank the line
 * for anybody who weighs on weekdays. That it is an average of three readings on one day and of
 * seven on another is exactly why it is not the primary field.
 *
 * ponytail: rescans the readings per day, so a range costs days times readings. A year against
 * a few hundred readings is well under a millisecond; make it a sliding window if ranges ever
 * run to decades.
 */
function movingAverage(
  daily: readonly WeightReading[],
  date: LocalDate,
  windowDays: number,
): number | null {
  const window = daily.filter(
    (reading) => reading.localDate <= date && daysBetween(reading.localDate, date) < windowDays,
  );
  if (window.length === 0) {
    return null;
  }

  return window.reduce((sum, reading) => sum + reading.weightGrams, 0) / window.length;
}

/** Subtracts two figures that may each be missing. See WeightTrendComparison for the sign. */
function difference(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous;
}

/**
 * Trend first and last, over the days that have one. See WeightTrendChange for why not the
 * edges. Exported for POR-38's weekly summary, which calls this once per week over a slice of
 * the same days computeWeightTrend already produced, rather than a second trend calculation.
 */
export function changeOver(days: readonly WeightTrendDay[]): WeightTrendChange {
  const trended = days.filter(
    (day): day is WeightTrendDay & { trendGrams: number } => day.trendGrams !== null,
  );

  const first = trended[0];
  const last = trended.at(-1);
  if (first === undefined || last === undefined) {
    return { from: null, to: null, changeGrams: null, changePerWeekGrams: null };
  }

  const span = daysBetween(first.date, last.date);
  const changeGrams = last.trendGrams - first.trendGrams;

  return {
    from: first.date,
    to: last.date,
    changeGrams,
    changePerWeekGrams: span === 0 ? null : (changeGrams / span) * 7,
  };
}

/**
 * The whole answer for a range: one entry per day, the movement across it, and the movement
 * across the equally long stretch before it.
 *
 * Readings from before the range are not optional and are not an optimisation. A trend is a
 * position, not a function of the window it is looked at through, so the walk starts at the
 * first reading on record and only begins emitting days once it reaches the previous period.
 * Starting it at `from` instead would reset the line to whatever was on the scale that morning
 * and report a fortnight of somebody's noise as their progress.
 */
export function computeWeightTrend(
  readings: readonly WeightReading[],
  options: WeightTrendOptions,
): WeightTrend {
  const { from, to } = options;
  const halfLifeDays = options.halfLifeDays ?? WEIGHT_TREND.halfLifeDays;
  const decay = (days: number): number => 0.5 ** (days / halfLifeDays);

  const daily = dailyReadings(readings, to);
  const previousFrom = shiftLocalDate(from, -(daysBetween(from, to) + 1));
  const earliest = daily[0]?.localDate;
  const start = earliest !== undefined && earliest < previousFrom ? earliest : previousFrom;

  const series: WeightTrendDay[] = [];
  let trend: number | null = null;
  let evidence = 0;
  let lastReading: LocalDate | null = null;
  let cursor = 0;

  for (const date of everyLocalDate(start, to)) {
    const reading = daily[cursor]?.localDate === date ? daily[cursor++] : undefined;

    if (reading !== undefined) {
      const gap = lastReading === null ? 0 : daysBetween(lastReading, date);
      // The first reading is the trend outright. There is nothing behind it to pull towards, and
      // seeding from zero would spend a month climbing to a number the user already told us.
      trend =
        trend === null
          ? reading.weightGrams
          : trend + (1 - decay(gap)) * (reading.weightGrams - trend);
      // Same decay, so evidence answers "too few readings" and "too old readings" with one
      // number: each reading adds one and every day since erodes what was already there.
      evidence = evidence * decay(gap) + 1;
      lastReading = date;
    }

    if (date < previousFrom) {
      continue;
    }

    const age = lastReading === null ? 0 : daysBetween(lastReading, date);
    series.push({
      date,
      // Held flat on a day with no reading rather than decayed towards nothing. No reading is
      // no news, and the last thing known is still the best estimate of today.
      trendGrams: trend,
      lowConfidence: trend === null || evidence * decay(age) < WEIGHT_TREND.minEvidence,
      movingAverageGrams: movingAverage(daily, date, WEIGHT_TREND.movingAverageDays),
      rawGrams: reading?.weightGrams ?? null,
    });
  }

  const days = series.filter((day) => day.date >= from);
  const change = changeOver(days);
  const previous = changeOver(series.filter((day) => day.date < from));

  return {
    days,
    change,
    previous,
    versusPrevious: {
      differenceGrams: difference(change.changeGrams, previous.changeGrams),
      differencePerWeekGrams: difference(change.changePerWeekGrams, previous.changePerWeekGrams),
    },
  };
}
