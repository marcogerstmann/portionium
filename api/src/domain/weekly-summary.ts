import { Temporal } from '@js-temporal/polyfill';
import type { ColourCounts, LocalDate } from '@portionium/schemas';

import { shareOf, type DailyColourStats } from './stats.js';
import { changeOver, type WeightTrendDay } from './weight-trend.js';

/**
 * POR-38: the two signals side by side, one row per ISO week, which is the entire thesis of the
 * product. This file does no querying and no trend maths of its own: it groups what POR-36's
 * `computeDailyColourStats` and POR-37's `computeWeightTrend` already produced into weeks, so
 * the endpoint stays the query POR-36 already made plus the trend calculation POR-37 already
 * made, not one of either per week.
 *
 * ISO week numbering comes from `Temporal.PlainDate`'s own `weekOfYear`/`yearOfWeek`, which are
 * already the ISO 8601 week date for the `iso8601` calendar this app uses throughout, so there
 * is no hand rolled week arithmetic here. And since every `local_date` this grouping reads is
 * already a user's calendar day, resolved once at write time (see local-date.ts), grouping it
 * by week is all that is needed for a week to respect the user's local dates too.
 */

export const WEEKLY_SUMMARY = {
  /**
   * Fewer logged days than this and a week is flagged sparse: a judgement call about coverage,
   * not about the week itself, see WeeklySummaryWeek.sparse. Four is a majority of seven, the
   * example the ticket itself gives, two logged days, sits well under it.
   */
  sparseThresholdDays: 4,
};

/** A Monday to Sunday span and the ISO 8601 week number it is. */
export interface IsoWeek {
  isoYear: number;
  isoWeek: number;
  startDate: LocalDate;
  endDate: LocalDate;
}

/**
 * `weekOfYear`/`yearOfWeek` are typed optional because Temporal supports calendars that do not
 * number weeks. `iso8601` is the only calendar this app ever creates a PlainDate in (see
 * local-date.ts) and always numbers them, so an undefined pair here would mean the polyfill
 * changed calendars under us, not a date this function was ever meant to handle.
 */
function requireIsoWeek(date: Temporal.PlainDate): Pick<IsoWeek, 'isoYear' | 'isoWeek'> {
  const { yearOfWeek, weekOfYear } = date;
  if (yearOfWeek === undefined || weekOfYear === undefined) {
    throw new Error(`no ISO week number for ${date.toString()}`);
  }

  return { isoYear: yearOfWeek, isoWeek: weekOfYear };
}

/**
 * `count` ISO weeks ending with the week `today` falls in, oldest first. `today` is the
 * caller's local date, not a UTC one, so the current week always includes today even when the
 * account is far enough from UTC that the server's own calendar date has already turned over.
 */
export function isoWeeksEnding(today: LocalDate, count: number): IsoWeek[] {
  const current = Temporal.PlainDate.from(today);
  const currentMonday = current.subtract({ days: current.dayOfWeek - 1 });

  return Array.from({ length: count }, (_, index) => {
    const start = currentMonday.subtract({ weeks: count - 1 - index });
    const end = start.add({ days: 6 });

    return {
      ...requireIsoWeek(start),
      startDate: start.toString(),
      endDate: end.toString(),
    };
  });
}

const ZERO_COUNTS: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };

function sumCounts(days: readonly DailyColourStats[]): ColourCounts {
  return days.reduce(
    (sum, day) => ({
      green: sum.green + day.counts.green,
      yellow: sum.yellow + day.counts.yellow,
      orange: sum.orange + day.counts.orange,
      unclassified: sum.unclassified + day.counts.unclassified,
    }),
    ZERO_COUNTS,
  );
}

/**
 * Signed, current minus previous week: negative is fewer this week, positive is more. Never a
 * percentage, since a week going from zero orange items to one is an infinite percentage change
 * and tells a reader nothing a percentage of a count this small ever does.
 */
function diffCounts(current: ColourCounts, previous: ColourCounts): ColourCounts {
  return {
    green: current.green - previous.green,
    yellow: current.yellow - previous.yellow,
    orange: current.orange - previous.orange,
    unclassified: current.unclassified - previous.unclassified,
  };
}

/** The weight side of one week: the smoothed trend on its first and last day, and the same
 * weekly rate computeWeightTrend reports for any stretch, reused rather than redone. */
export interface WeeklyWeightSummary {
  startGrams: number | null;
  endGrams: number | null;
  changeGrams: number | null;
  changePerWeekGrams: number | null;
}

function weeklyWeight(days: readonly WeightTrendDay[]): WeeklyWeightSummary {
  const trended = days.filter(
    (day): day is WeightTrendDay & { trendGrams: number } => day.trendGrams !== null,
  );
  const { changeGrams, changePerWeekGrams } = changeOver(days);

  return {
    startGrams: trended[0]?.trendGrams ?? null,
    endGrams: trended.at(-1)?.trendGrams ?? null,
    changeGrams,
    changePerWeekGrams,
  };
}

export interface WeeklySummaryWeek extends IsoWeek {
  counts: ColourCounts;
  share: ColourCounts;
  /** How many of the week's days had anything logged at all. */
  daysLogged: number;
  /** Too little logging behind the week's numbers to read it next to a full one. A fact about
   * coverage, never a verdict on the week, see WEEKLY_SUMMARY.sparseThresholdDays. */
  sparse: boolean;
  weight: WeeklyWeightSummary;
  versusPreviousWeek: ColourCounts;
}

/**
 * One entry per week in `weeks`, oldest first, except the first element of `weeks` itself: that
 * one is expected to be one extra week before the first the caller wants back, present purely
 * so it in turn has something to compare against, and is consumed here rather than returned.
 * `dailyColours` and `weightDays` are expected to already cover every date `weeks` spans, which
 * is what POR-36's gap filling and POR-37's held-flat trend already guarantee, so this is
 * grouping, never a second query or a second trend calculation.
 */
export function computeWeeklySummary(
  dailyColours: readonly DailyColourStats[],
  weightDays: readonly WeightTrendDay[],
  weeks: readonly IsoWeek[],
): WeeklySummaryWeek[] {
  const weekly = weeks.map((week) => {
    const days = dailyColours.filter(
      (day) => day.date >= week.startDate && day.date <= week.endDate,
    );
    const weightWeek = weightDays.filter(
      (day) => day.date >= week.startDate && day.date <= week.endDate,
    );
    const counts = sumCounts(days);
    const daysLogged = days.filter(
      (day) =>
        day.counts.green + day.counts.yellow + day.counts.orange + day.counts.unclassified > 0,
    ).length;

    return {
      ...week,
      counts,
      share: shareOf(counts),
      daysLogged,
      sparse: daysLogged < WEEKLY_SUMMARY.sparseThresholdDays,
      weight: weeklyWeight(weightWeek),
    };
  });

  return weekly.slice(1).map((week, index) => ({
    ...week,
    // `weekly[index]` is the week directly before `week`, offset by the slice(1) above. Falls
    // back to itself only if `weeks` was called with fewer than two entries, which the route
    // never does; a guard rather than an assertion, same reasoning as computeDailyColourStats.
    versusPreviousWeek: diffCounts(week.counts, (weekly[index] ?? week).counts),
  }));
}
