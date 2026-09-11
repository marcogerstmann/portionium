import { afterEach, describe, expect, it, vi } from 'vitest';

import { DomainError } from './errors.js';
import { applyMealChanges, createMeal, type MealDayContext, type NewMeal } from './meal.js';

const USER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const PORRIDGE = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b32';
const BERRIES = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b33';

/** 08:30 in Berlin, comfortably inside the day it was logged on. */
const base: NewMeal = {
  userId: USER_ID,
  type: 'breakfast',
  loggedAt: new Date('2026-09-06T06:30:00.000Z'),
  items: [{ foodId: PORRIDGE }, { foodId: BERRIES }],
};

const berliner: MealDayContext = { timezone: 'Europe/Berlin', dayBoundaryHour: 4 };

describe('createMeal', () => {
  it('rejects a meal with no items', () => {
    expect(() => createMeal({ ...base, items: [] }, berliner)).toThrow(DomainError);
  });

  it('rejects it with a code an adapter can map, not a message it has to match', () => {
    try {
      createMeal({ ...base, items: [] }, berliner);
      expect.unreachable('an empty meal must not be accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('meal_has_no_items');
    }
  });

  it('numbers items densely from zero, in the order they were given', () => {
    const { items } = createMeal(base, berliner);

    expect(items.map((item) => item.position)).toEqual([0, 1]);
    expect(items.map((item) => item.foodId)).toEqual([PORRIDGE, BERRIES]);
  });

  it('ignores any position a caller tries to supply', () => {
    const { items } = createMeal(
      {
        ...base,
        items: [{ foodId: PORRIDGE, position: 7 }, { foodId: BERRIES }] as NewMeal['items'],
      },
      berliner,
    );

    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('carries quantity through untouched when one is given, and leaves it off when not', () => {
    const { items } = createMeal(
      { ...base, items: [{ foodId: PORRIDGE, quantity: 1.5 }, { foodId: BERRIES }] },
      berliner,
    );

    expect(items[0]?.quantity).toBe(1.5);
    expect(items[1]?.quantity).toBeUndefined();
  });

  it('allows the same food twice, a second helping is not a mistake', () => {
    const { items } = createMeal(
      { ...base, items: [{ foodId: PORRIDGE }, { foodId: PORRIDGE }] },
      berliner,
    );

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('stamps the day from the instant and the user, not from the caller', () => {
    const { meal } = createMeal(base, berliner);

    expect(meal.localDate).toBe('2026-09-06');
  });

  it('files a late night meal on the evening it belongs to', () => {
    // 01:00 in Berlin, which is below the user's 04:00 boundary.
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
  const currentItems = [{ foodId: PORRIDGE }, { foodId: BERRIES }];
  const current: NewMeal = { ...base, items: currentItems };

  it('leaves a field untouched when the edit does not mention it', () => {
    const { meal, items } = applyMealChanges(current, {}, berliner);

    expect(meal.type).toBe('breakfast');
    expect(meal.loggedAt).toEqual(base.loggedAt);
    expect(items.map((item) => item.foodId)).toEqual([PORRIDGE, BERRIES]);
  });

  it('moves the meal to a different local date when loggedAt crosses the day boundary', () => {
    // 08:30 UTC in Berlin's summer offset, past the 04:00 boundary on the next calendar day.
    const { meal } = applyMealChanges(
      current,
      { loggedAt: new Date('2026-09-07T06:30:00.000Z') },
      berliner,
    );

    expect(meal.localDate).toBe('2026-09-07');
  });

  it('replaces the whole item list, so add, remove and reorder are one edit', () => {
    const CHEESE = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b34';

    const { items } = applyMealChanges(
      current,
      { items: [{ foodId: BERRIES }, { foodId: CHEESE }] },
      berliner,
    );

    expect(items.map((item) => [item.foodId, item.position])).toEqual([
      [BERRIES, 0],
      [CHEESE, 1],
    ]);
  });

  it('rejects removing the last item, with a message that says to delete the meal instead', () => {
    try {
      applyMealChanges(current, { items: [] }, berliner);
      expect.unreachable('removing the last item must not leave an empty meal');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('meal_has_no_items');
      expect((error as DomainError).message).toMatch(/delete the meal/i);
    }
  });
});
