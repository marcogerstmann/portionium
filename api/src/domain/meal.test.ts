import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from './errors.js';
import { applyMealChanges, createMeal, type MealDayContext, type NewMeal } from './meal.js';

const USER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const PORRIDGE = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b32';
const BERRIES = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b33';

const base: NewMeal = {
  userId: USER_ID,
  type: 'breakfast',
  loggedAt: new Date('2026-09-06T06:30:00.000Z'),
  entries: [
    { foodId: PORRIDGE, category: 'green' },
    { foodId: BERRIES, category: null },
  ],
};

const berliner: MealDayContext = { timezone: 'Europe/Berlin', dayBoundaryHour: 4 };

describe('createMeal', () => {
  it('rejects a meal with no entries', () => {
    expect(() => createMeal({ ...base, entries: [] }, berliner)).toThrow(DomainError);
  });

  it('rejects it with a code an adapter can map, not a message it has to match', () => {
    try {
      createMeal({ ...base, entries: [] }, berliner);
      expect.unreachable('an empty meal must not be accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('meal_has_no_entries');
    }
  });

  it('numbers entries densely from zero, in the order they were given', () => {
    const { entries } = createMeal(base, berliner);

    expect(entries.map((entry) => entry.position)).toEqual([0, 1]);
    expect(entries.map((entry) => entry.foodId)).toEqual([PORRIDGE, BERRIES]);
  });

  it('ignores any position a caller tries to supply', () => {
    const { entries } = createMeal(
      {
        ...base,
        entries: [
          { foodId: PORRIDGE, category: null, position: 7 },
          { foodId: BERRIES, category: null },
        ] as NewMeal['entries'],
      },
      berliner,
    );

    expect(entries.map((entry) => entry.position)).toEqual([0, 1]);
  });

  it('carries quantity through untouched when one is given, and leaves it off when not', () => {
    const { entries } = createMeal(
      {
        ...base,
        entries: [
          { foodId: PORRIDGE, category: null, quantity: 1.5 },
          { foodId: BERRIES, category: null },
        ],
      },
      berliner,
    );

    expect(entries[0]?.quantity).toBe(1.5);
    expect(entries[1]?.quantity).toBeUndefined();
  });

  it('carries the stamped colour through untouched, including a bare one with no food', () => {
    const { entries } = createMeal(
      {
        ...base,
        entries: [
          { foodId: PORRIDGE, category: 'yellow' },
          { foodId: null, category: 'orange' },
          { foodId: BERRIES, category: null },
        ],
      },
      berliner,
    );

    expect(entries.map((entry) => entry.category)).toEqual(['yellow', 'orange', null]);
    expect(entries.map((entry) => entry.foodId)).toEqual([PORRIDGE, null, BERRIES]);
  });

  it('allows the same food twice, a second helping is not a mistake', () => {
    const { entries } = createMeal(
      {
        ...base,
        entries: [
          { foodId: PORRIDGE, category: null },
          { foodId: PORRIDGE, category: null },
        ],
      },
      berliner,
    );

    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.position)).toEqual([0, 1]);
  });

  it('stamps the day from the instant and the user, not from the caller', () => {
    const { meal } = createMeal(base, berliner);

    expect(meal.localDate).toBe('2026-09-06');
  });

  it('files a late night meal on the evening it belongs to', () => {
    const { meal } = createMeal(
      { ...base, type: 'snack', loggedAt: new Date('2026-09-06T23:00:00.000Z') },
      berliner,
    );

    expect(meal.localDate).toBe('2026-09-06');
  });

  it('stamps the same instant differently for users in different zones', () => {
    const instant = new Date('2026-09-06T20:00:00.000Z');
    const auckland: MealDayContext = { timezone: 'Pacific/Auckland', dayBoundaryHour: 4 };

    expect(createMeal({ ...base, loggedAt: instant }, berliner).meal.localDate).toBe('2026-09-06');
    expect(createMeal({ ...base, loggedAt: instant }, auckland).meal.localDate).toBe('2026-09-07');
  });

  it('separates the meal from its items and keeps no items key on the meal', () => {
    const { meal } = createMeal(base, berliner);

    expect(meal).not.toHaveProperty('items');
    expect(meal.localDate).toBe('2026-09-06');
    expect(meal.userId).toBe(USER_ID);
  });

  describe('the future', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('lets a loggedAt a moment ahead of now through, for a clock a few minutes fast', () => {
      vi.useFakeTimers({ now: new Date('2026-09-06T06:30:00.000Z') });

      expect(() =>
        createMeal({ ...base, loggedAt: new Date('2026-09-06T06:34:00.000Z') }, berliner),
      ).not.toThrow();
    });

    it('rejects a loggedAt further into the future than clock skew excuses', () => {
      vi.useFakeTimers({ now: new Date('2026-09-06T06:30:00.000Z') });

      try {
        createMeal({ ...base, loggedAt: new Date('2026-09-06T07:00:00.000Z') }, berliner);
        expect.unreachable('a meal half an hour in the future must not be accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).code).toBe('meal_logged_in_future');
      }
    });

    it('backdates without limit, only the future direction is guarded', () => {
      vi.useFakeTimers({ now: new Date('2026-09-06T06:30:00.000Z') });

      expect(() =>
        createMeal({ ...base, loggedAt: new Date('2020-01-01T00:00:00.000Z') }, berliner),
      ).not.toThrow();
    });
  });
});

describe('applyMealChanges', () => {
  const currentEntries: NewMeal['entries'] = [
    { foodId: PORRIDGE, category: 'green' },
    { foodId: BERRIES, category: null },
  ];
  const current: NewMeal = { ...base, entries: currentEntries };

  it('leaves a field untouched when the edit does not mention it', () => {
    const { meal, entries } = applyMealChanges(current, {}, berliner);

    expect(meal.type).toBe('breakfast');
    expect(meal.loggedAt).toEqual(base.loggedAt);
    expect(entries.map((entry) => entry.foodId)).toEqual([PORRIDGE, BERRIES]);
  });

  it('leaves the colours a meal was logged with alone when the edit names no entries', () => {
    const { entries } = applyMealChanges(current, { notes: 'moved the fork' }, berliner);

    expect(entries.map((entry) => entry.category)).toEqual(['green', null]);
  });

  it('moves the meal to a different local date when loggedAt crosses the day boundary', () => {
    const { meal } = applyMealChanges(
      current,
      { loggedAt: new Date('2026-09-07T06:30:00.000Z') },
      berliner,
    );

    expect(meal.localDate).toBe('2026-09-07');
  });

  it('replaces the whole entry list, so add, remove and reorder are one edit', () => {
    const CHEESE = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b34';

    const { entries } = applyMealChanges(
      current,
      {
        entries: [
          { foodId: BERRIES, category: 'green' },
          { foodId: CHEESE, category: 'orange' },
        ],
      },
      berliner,
    );

    expect(entries.map((entry) => [entry.foodId, entry.position])).toEqual([
      [BERRIES, 0],
      [CHEESE, 1],
    ]);
  });

  it('rejects removing the last entry, with a message that says to delete the meal instead', () => {
    try {
      applyMealChanges(current, { entries: [] }, berliner);
      expect.unreachable('removing the last entry must not leave an empty meal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('meal_has_no_entries');
      expect((error as DomainError).message).toMatch(/delete the meal/i);
    }
  });
});
