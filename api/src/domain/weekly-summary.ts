import { Temporal } from '@js-temporal/polyfill';
import type { ColourCounts, LocalDate } from '@portionium/schemas';

import { shareOf, type DailyColourStats } from './stats.js';
import { changeOver, type WeightTrendDay } from './weight-trend.js';

export const WEEKLY_SUMMARY = {
  /**
   * Under four logged days of seven, a week is flagged sparse rather than read next to a full one.
   */
  sparseThresholdDays: 4,
};

export interface IsoWeek {
  isoYear: number;
  isoWeek: number;
  startDate: LocalDate;
  endDate: LocalDate;
}

/**
 * Typed optional because Temporal supports calendars that do not number weeks; iso8601 always does.
 */
function requireIsoWeek(date: Temporal.PlainDate): Pick<IsoWeek, 'isoYear' | 'isoWeek'> {
  const { yearOfWeek, weekOfYear } = date;
  if (yearOfWeek === undefined || weekOfYear === undefined) {
    throw new Error(`no ISO week number for ${date.toString()}`);
  }

  return { isoYear: yearOfWeek, isoWeek: weekOfYear };
}

function weekFromMonday(monday: Temporal.PlainDate): IsoWeek {
  const end = monday.add({ days: 6 });

  return {
    ...requireIsoWeek(monday),
    startDate: monday.toString(),
    endDate: end.toString(),
  };
}

function mondayOf(date: LocalDate): Temporal.PlainDate {
  const current = Temporal.PlainDate.from(date);

  return current.subtract({ days: current.dayOfWeek - 1 });
}

export function isoWeekOf(date: LocalDate): IsoWeek {
  return weekFromMonday(mondayOf(date));
}

export function isoWeeksEnding(today: LocalDate, count: number): IsoWeek[] {
  const currentMonday = mondayOf(today);

  return Array.from({ length: count }, (_, index) =>
    weekFromMonday(currentMonday.subtract({ weeks: count - 1 - index })),
  );
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

function diffCounts(current: ColourCounts, previous: ColourCounts): ColourCounts {
  return {
    green: current.green - previous.green,
    yellow: current.yellow - previous.yellow,
    orange: current.orange - previous.orange,
    unclassified: current.unclassified - previous.unclassified,
  };
}

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
  daysLogged: number;
  sparse: boolean;
  weight: WeeklyWeightSummary;
  versusPreviousWeek: ColourCounts;
}

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
    versusPreviousWeek: diffCounts(week.counts, (weekly[index] ?? week).counts),
  }));
}
