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
   * any real loss or gain over that week.
   */
  maxDriftPerDay: 0.02,
};

/** Whole days between two calendar dates. Both are plain dates, so no zone is involved. */
function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * Validates a reading against the user's own history.
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
): NewWeightEntry {
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
    return entry;
  }

  const nearest = own.reduce((best, candidate) =>
    daysBetween(candidate.localDate, localDate) < daysBetween(best.localDate, localDate)
      ? candidate
      : best,
  );

  // Same day readings still get one day of allowance. People weigh themselves twice.
  const days = Math.max(daysBetween(nearest.localDate, localDate), 1);
  const drift = Math.abs(weightGrams - nearest.weightGrams) / nearest.weightGrams;

  if (drift > WEIGHT_PLAUSIBILITY.maxDriftPerDay * days) {
    throw new DomainError(
      'implausible_weight',
      `${(weightGrams / 1000).toFixed(1)} kg is too far from the ` +
        `${(nearest.weightGrams / 1000).toFixed(1)} kg recorded on ${nearest.localDate}.`,
    );
  }

  return entry;
}
