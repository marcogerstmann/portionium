import type {
  ColourCounts,
  DayColourStats,
  Locale,
  LocalDate,
  WeightTrendChange,
  WeightTrendComparison,
  WeightTrendDay,
} from '@portionium/schemas';

import { shiftDate } from './db';
import { translate } from './i18n';

export const COLOUR_WINDOWS = [7, 30, 90] as const;

export const CHART_DAYS = { narrow: 30, wide: 90 };

export const COLOUR_DAYS = COLOUR_WINDOWS.at(-1) ?? 90;

export const SUMMARY_WEEKS = 8;

export function formatKg(
  value: number,
  locale: Locale,
  options: { signed?: boolean; digits?: number } = {},
): string {
  const { signed = false, digits = 1 } = options;

  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    ...(signed && { signDisplay: 'exceptZero' }),
  }).format(value);
}

export function rangeEnding(today: LocalDate, days: number): { from: LocalDate; to: LocalDate } {
  return { from: shiftDate(today, -(days - 1)), to: today };
}

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

export function spokenCounts(counts: ColourCounts, locale: Locale): string {
  return [
    translate(locale, 'statsSpokenGreen', { count: counts.green }),
    translate(locale, 'statsSpokenYellow', { count: counts.yellow }),
    translate(locale, 'statsSpokenOrange', { count: counts.orange }),
    ...(counts.unclassified > 0
      ? [translate(locale, 'statsSpokenUnclassified', { count: counts.unclassified })]
      : []),
  ].join(', ');
}

export function trendCaveat(days: readonly WeightTrendDay[], locale: Locale): string | undefined {
  const latest = days.at(-1);

  if (latest === undefined || latest.trendKg === null) {
    return translate(locale, 'statsNoTrend');
  }

  return latest.lowConfidence ? translate(locale, 'statsLowConfidence') : undefined;
}

export function lastReading(days: readonly WeightTrendDay[]): number | undefined {
  return days.findLast((day) => day.rawKg !== null)?.rawKg ?? undefined;
}

export function changeLabel(changeKg: number | null, locale: Locale): string {
  return changeKg === null
    ? translate(locale, 'statsNoTrendYet')
    : `${formatKg(changeKg, locale, { signed: true })} kg`;
}

export function changeSentence(change: WeightTrendChange, days: number, locale: Locale): string {
  if (change.changeKg === null) {
    return translate(locale, 'statsNothingToReport', { days });
  }

  const amount = formatKg(Math.abs(change.changeKg), locale);
  const movedKey =
    change.changeKg < 0
      ? 'statsMovedDown'
      : change.changeKg > 0
        ? 'statsMovedUp'
        : 'statsMovedLevel';
  const moved = translate(locale, movedKey, { amount, days });

  if (change.changePerWeekKg === null) {
    return `${moved}.`;
  }

  const rate = translate(locale, 'statsRatePerWeek', {
    amount: formatKg(Math.abs(change.changePerWeekKg), locale, { digits: 2 }),
  });

  return `${moved}, ${rate}.`;
}

export function versusSentence(versus: WeightTrendComparison, locale: Locale): string | undefined {
  const difference = versus.differencePerWeekKg;

  if (difference === null || difference === 0) {
    return difference === 0 ? translate(locale, 'statsSameRate') : undefined;
  }

  const rate = translate(locale, 'statsRatePerWeek', {
    amount: formatKg(Math.abs(difference), locale, { digits: 2 }),
  });

  return translate(locale, difference < 0 ? 'statsFurtherDown' : 'statsFurtherUp', { rate });
}

export function weekLabel(
  week: { startDate: LocalDate; endDate: LocalDate },
  locale: Locale,
): string {
  // In UTC: a LocalDate has already had a timezone applied and carries none of its own.
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).formatRange(new Date(`${week.startDate}T00:00:00Z`), new Date(`${week.endDate}T00:00:00Z`));
}

export const CHART = { step: 8, height: 120, pad: 10 };

export interface ChartGeometry {
  width: number;
  height: number;
  line: string;
  raw: { x: number; y: number }[];
}

export function chartGeometry(days: readonly WeightTrendDay[]): ChartGeometry {
  const width = Math.max(1, days.length - 1) * CHART.step + 2 * CHART.pad;
  const { height, pad } = CHART;

  const values = days.flatMap((day) => [day.trendKg, day.rawKg].filter((v) => v !== null));
  const low = Math.min(...values);
  const high = Math.max(...values);
  // A flat series, a single reading, or none: the whole line sits on the middle rather than
  // dividing by a zero span.
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
