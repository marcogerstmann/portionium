import type { LocalDate } from '@portionium/schemas';

import { everyLocalDate } from './stats.js';
import { daysBetween } from './weight.js';

/** Judgement calls rather than facts, see docs/adr/008-weight-trend-smoothing.md. */
export const WEIGHT_TREND = {
  halfLifeDays: 10,
  movingAverageDays: 7,
  minEvidence: 2,
};

export interface WeightReading {
  localDate: LocalDate;
  weightGrams: number;
  recordedAt: Date;
}

export interface WeightTrendDay {
  date: LocalDate;
  trendGrams: number | null;
  lowConfidence: boolean;
  movingAverageGrams: number | null;
  rawGrams: number | null;
}

export interface WeightTrendChange {
  from: LocalDate | null;
  to: LocalDate | null;
  changeGrams: number | null;
  changePerWeekGrams: number | null;
}

export interface WeightTrendComparison {
  differenceGrams: number | null;
  differencePerWeekGrams: number | null;
}

export interface WeightTrend {
  days: WeightTrendDay[];
  change: WeightTrendChange;
  previous: WeightTrendChange;
  versusPrevious: WeightTrendComparison;
}

export interface WeightTrendOptions {
  from: LocalDate;
  to: LocalDate;
  halfLifeDays?: number | undefined;
}

function shiftLocalDate(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10);
}

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

function difference(current: number | null, previous: number | null): number | null {
  return current === null || previous === null ? null : current - previous;
}

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
      trend =
        trend === null
          ? reading.weightGrams
          : trend + (1 - decay(gap)) * (reading.weightGrams - trend);
      evidence = evidence * decay(gap) + 1;
      lastReading = date;
    }

    if (date < previousFrom) {
      continue;
    }

    const age = lastReading === null ? 0 : daysBetween(lastReading, date);
    series.push({
      date,
      // Held flat on a day with no reading rather than decayed: no reading is no news.
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
