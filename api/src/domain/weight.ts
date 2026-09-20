import type { LocalDate, WeightEntry } from '@portionium/schemas';

import { DomainError } from './errors.js';

export type NewWeightEntry = Omit<WeightEntry, 'id'>;

export const WEIGHT_PLAUSIBILITY = {
  /** The absolute human range, outside which a reading is a typo rather than a body weight. */
  minGrams: 20_000,
  maxGrams: 500_000,
  /**
   * Two percent covers a day of water and food swing, and a week of it covers any real loss or
   * gain.
   */
  maxDriftPerDay: 0.02,
};

export interface WeightEntryResult {
  entry: NewWeightEntry;
  /** A warning, never a refusal: scales and travel produce genuine outliers. */
  warning: string | null;
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

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

  const own = history.filter((candidate) => candidate.userId === userId);
  if (own.length === 0) {
    return { entry, warning: null };
  }

  const nearest = own.reduce((best, candidate) =>
    daysBetween(candidate.localDate, localDate) < daysBetween(best.localDate, localDate)
      ? candidate
      : best,
  );

  // Same day readings still get one day of allowance.
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
