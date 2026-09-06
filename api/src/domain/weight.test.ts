import type { WeightEntry } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { createWeightEntry, WEIGHT_PLAUSIBILITY, type NewWeightEntry } from './weight.js';

const USER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const OTHER_USER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b39';

function entry(weightGrams: number, localDate: string): NewWeightEntry {
  return {
    userId: USER_ID,
    weightGrams,
    localDate,
    recordedAt: new Date(`${localDate}T06:00:00.000Z`),
  };
}

function past(weightGrams: number, localDate: string, userId = USER_ID): WeightEntry {
  return {
    ...entry(weightGrams, localDate),
    userId,
    id: '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b40',
  };
}

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).code;
  }
  return expect.unreachable('expected the reading to be rejected');
}

describe('createWeightEntry', () => {
  describe('with no history', () => {
    it('accepts any reading inside the absolute range', () => {
      expect(createWeightEntry(entry(82_400, '2026-09-06'), []).weightGrams).toBe(82_400);
    });

    it('rejects a reading below the range, which is a decimal point in the wrong place', () => {
      expect(codeOf(() => createWeightEntry(entry(8_240, '2026-09-06'), []))).toBe(
        'implausible_weight',
      );
    });

    it('rejects a reading above the range, which is grams entered as kilograms', () => {
      expect(codeOf(() => createWeightEntry(entry(824_000, '2026-09-06'), []))).toBe(
        'implausible_weight',
      );
    });

    it('accepts the exact bounds', () => {
      const { minGrams, maxGrams } = WEIGHT_PLAUSIBILITY;
      expect(() => createWeightEntry(entry(minGrams, '2026-09-06'), [])).not.toThrow();
      expect(() => createWeightEntry(entry(maxGrams, '2026-09-06'), [])).not.toThrow();
    });
  });

  describe('against history', () => {
    const history = [past(82_400, '2026-09-05')];

    it('accepts a reading a day later that moved by a believable amount', () => {
      expect(() => createWeightEntry(entry(83_000, '2026-09-06'), history)).not.toThrow();
    });

    it('rejects a reading a day later that jumped further than a body can', () => {
      expect(codeOf(() => createWeightEntry(entry(92_400, '2026-09-06'), history))).toBe(
        'implausible_weight',
      );
    });

    it('names the reading it disagreed with, so the user can see which one is wrong', () => {
      expect(() => createWeightEntry(entry(92_400, '2026-09-06'), history)).toThrow(
        /82\.4 kg recorded on 2026-09-05/,
      );
    });

    it('allows a full day of slack on a second reading the same day', () => {
      // Two percent of 82.4 kg is a little over 1.6 kg, which a day of food and water covers.
      expect(() => createWeightEntry(entry(83_800, '2026-09-05'), history)).not.toThrow();
      expect(() => createWeightEntry(entry(88_000, '2026-09-05'), history)).toThrow(DomainError);
    });

    it('widens the allowance with the gap, so a month away is not a month of rejections', () => {
      const monthLater = entry(88_000, '2026-10-05');

      expect(() => createWeightEntry(monthLater, history)).not.toThrow();
      // The same jump overnight is not believable.
      expect(() => createWeightEntry(entry(88_000, '2026-09-06'), history)).toThrow(DomainError);
    });

    it('judges a backfilled reading against its own neighbours, not against today', () => {
      const longHistory = [past(95_000, '2026-01-10'), past(82_400, '2026-09-05')];

      // 94 kg in January sits beside the 95 kg from January, and nowhere near today's 82 kg.
      expect(() => createWeightEntry(entry(94_000, '2026-01-11'), longHistory)).not.toThrow();
    });

    it('still applies the absolute range even when history would allow the drift', () => {
      const climbing = [past(21_000, '2026-09-05')];

      expect(codeOf(() => createWeightEntry(entry(19_000, '2026-09-06'), climbing))).toBe(
        'implausible_weight',
      );
    });

    it('ignores another user’s entries entirely', () => {
      const someoneElse = [past(120_000, '2026-09-05', OTHER_USER_ID)];

      // Judged as a first reading, so accepted. Judged against 120 kg, it would have been too.
      expect(() => createWeightEntry(entry(82_400, '2026-09-06'), someoneElse)).not.toThrow();
      // And their history cannot wave through something the absolute range forbids.
      expect(() => createWeightEntry(entry(8_240, '2026-09-06'), someoneElse)).toThrow(DomainError);
    });
  });
});
