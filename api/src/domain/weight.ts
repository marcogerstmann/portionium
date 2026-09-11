import type { LocalDate, WeightEntry } from '@portionium/schemas';

import { DomainError } from './errors.js';

/**
 * Weight plausibility. A schema can say a reading is a positive whole number of grams. Only
 * the readings around it can say whether it is a believable one, which is why this is here and
 * not in the shared package.
 *
 * The failure this catches is a typo, not fraud: 8240 for 82400, or a stone entered as if it
 * were a kilogram. Both parse cleanly and both poison a trend line for months, because a chart
 * scaled to include one bad point flattens every real change around it.
 */

export type NewWeightEntry = Omit<WeightEntry, 'id'>;

/**
 * The knobs. Exported because they are judgement calls, not facts, and the numbers that suit a
 * general adult population are not the numbers that suit a clinical one.
 */
export const WEIGHT_PLAUSIBILITY = {
  /** Roughly the lightest recorded adult, and heavier than the heaviest. */
  minGrams: 20_000,
  maxGrams: 500_000,
  /**
   * How far a reading may sit from the nearest known one, as a fraction of that one, per day
   * between them. Two percent covers a day of water and food swing, and a week of it covers
   * any real loss or gain over that week. The default a caller gets when it does not pass its
   * own, see WEIGHT_MAX_DRIFT_PER_DAY in config.ts for where an operator overrides it.
   */
  maxDriftPerDay: 0.02,
};

export interface WeightEntryResult {
  entry: NewWeightEntry;
  /**
   * Set when the reading is a believable jump further than the nearest known one allows for the
   * gap between them. Never blocks: scales and travel produce genuine outliers, and rejecting
   * them would cost a real reading to catch a typo, which is what the absolute range above is
   * for. Null when the reading was unremarkable, or there was no history to judge it against.
   */
  warning: string | null;
}

/**
 * Whole days between two calendar dates. Both are plain dates, so no zone is involved.
 * Exported for the trend in weight-trend.ts, which derives its smoothing from the same gap.
 */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * Validates a reading against the user's own history.
 *
 * Two different judgements, both from the same comparison, and deliberately not the same
 * consequence. Outside the absolute human range is rejected: nothing that far out is a real
 * body weight, it is a decimal point or a unit typed wrong, and there is no reading worth
 * keeping. A believable range but a jump too fast is only flagged, in `warning`, because a
 * scale a user has never used before or a week of travel produce a genuine outlier that a block
 * would refuse for no reason beyond bad timing. See docs on WEIGHT_PLAUSIBILITY for the numbers.
 *
 * The comparison is against the nearest entry by date rather than the latest one, so that
 * backfilling last month's readings is judged against last month and not against today.
 *
 * Nearest single neighbour, an O(n) scan over the history the caller passed in. It
 * cannot tell a genuine step change from a typo followed by a correction. If that starts
 * mattering, compare against a median of the surrounding window instead, and have the caller
 * pass a bounded window rather than everything.
 */
export function createWeightEntry(
  entry: NewWeightEntry,
  history: readonly WeightEntry[],
  maxDriftPerDay: number = WEIGHT_PLAUSIBILITY.maxDriftPerDay,
): WeightEntryResult {
  const { weightGrams, localDate, userId } = entry;

  if (weightGrams < WEIGHT_PLAUSIBILITY.minGrams || weightGrams > WEIGHT_PLAUSIBILITY.maxGrams) {
    throw new DomainError(
      'implausible_weight',
      `${(weightGrams / 1000).toFixed(1)} kg is outside the range this app accepts.`,
    );
  }

  // Belt and braces. Repository reads are already scoped to one user, and a reading judged
  // against somebody else's history would be rejected or accepted for no visible reason.
  const own = history.filter((candidate) => candidate.userId === userId);
  if (own.length === 0) {
    return { entry, warning: null };
  }

  const nearest = own.reduce((best, candidate) =>
    daysBetween(candidate.localDate, localDate) < daysBetween(best.localDate, localDate)
      ? candidate
      : best,
  );

  // Same day readings still get one day of allowance. People weigh themselves twice.
  const days = Math.max(daysBetween(nearest.localDate, localDate), 1);
  const drift = Math.abs(weightGrams - nearest.weightGrams) / nearest.weightGrams;

  if (drift > maxDriftPerDay * days) {
    return {
      entry,
      warning:
        `${(weightGrams / 1000).toFixed(1)} kg is a big jump from the ` +
        `${(nearest.weightGrams / 1000).toFixed(1)} kg recorded on ${nearest.localDate}. ` +
        'Recorded anyway, scales and travel produce real outliers too.',
    };
  }

  return { entry, warning: null };
}
