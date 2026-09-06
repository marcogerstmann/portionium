import { describe, expect, it } from 'vitest';

import { DomainError } from './errors.js';
import { createMeal, type NewMeal } from './meal.js';

const USER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const PORRIDGE = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b32';
const BERRIES = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b33';

const base: NewMeal = {
  userId: USER_ID,
  type: 'breakfast',
  loggedAt: new Date('2026-09-06T06:30:00.000Z'),
  localDate: '2026-09-06',
  items: [{ foodId: PORRIDGE }, { foodId: BERRIES }],
};

describe('createMeal', () => {
  it('rejects a meal with no items', () => {
    expect(() => createMeal({ ...base, items: [] })).toThrow(DomainError);
  });

  it('rejects it with a code an adapter can map, not a message it has to match', () => {
    try {
      createMeal({ ...base, items: [] });
      expect.unreachable('an empty meal must not be accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe('meal_has_no_items');
    }
  });

  it('numbers items densely from zero, in the order they were given', () => {
    const { items } = createMeal(base);

    expect(items.map((item) => item.position)).toEqual([0, 1]);
    expect(items.map((item) => item.foodId)).toEqual([PORRIDGE, BERRIES]);
  });

  it('ignores any position a caller tries to supply', () => {
    const { items } = createMeal({
      ...base,
      items: [{ foodId: PORRIDGE, position: 7 }, { foodId: BERRIES }] as NewMeal['items'],
    });

    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('carries quantity through untouched when one is given, and leaves it off when not', () => {
    const { items } = createMeal({
      ...base,
      items: [{ foodId: PORRIDGE, quantity: 1.5 }, { foodId: BERRIES }],
    });

    expect(items[0]?.quantity).toBe(1.5);
    expect(items[1]?.quantity).toBeUndefined();
  });

  it('allows the same food twice, a second helping is not a mistake', () => {
    const { items } = createMeal({ ...base, items: [{ foodId: PORRIDGE }, { foodId: PORRIDGE }] });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.position)).toEqual([0, 1]);
  });

  it('separates the meal from its items and keeps no items key on the meal', () => {
    const { meal } = createMeal(base);

    expect(meal).not.toHaveProperty('items');
    expect(meal.localDate).toBe('2026-09-06');
    expect(meal.userId).toBe(USER_ID);
  });
});
