import { describe, expect, it } from 'vitest';

import {
  foodClassificationSchema,
  foodSchema,
  mealItemSchema,
  mealSchema,
  userSchema,
  weightEntrySchema,
} from './entities.js';

const ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const OTHER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b32';

const user = {
  id: ID,
  email: 'someone@example.com',
  displayName: 'Someone',
  role: 'user',
  timezone: 'Europe/Berlin',
  dayBoundaryHour: 4,
  createdAt: new Date('2026-09-06T08:00:00.000Z'),
};

const food = {
  id: ID,
  name: 'Porridge',
  kind: 'dish',
  createdBy: OTHER_ID,
  createdAt: new Date('2026-09-06T08:00:00.000Z'),
};

const meal = {
  id: ID,
  userId: OTHER_ID,
  type: 'breakfast',
  loggedAt: new Date('2026-09-06T06:30:00.000Z'),
  localDate: '2026-09-06',
  notes: 'with berries',
};

describe('userSchema', () => {
  it('accepts a complete user', () => {
    expect(userSchema.parse(user).role).toBe('user');
  });

  it('rejects an unusable timezone, every local date this user gets depends on it', () => {
    expect(userSchema.safeParse({ ...user, timezone: 'Europe/Berln' }).success).toBe(false);
  });

  it('rejects a malformed email and a blank display name', () => {
    expect(userSchema.safeParse({ ...user, email: 'someone' }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, displayName: '' }).success).toBe(false);
  });

  it('rejects a role outside the union', () => {
    expect(userSchema.safeParse({ ...user, role: 'superuser' }).success).toBe(false);
  });

  it('accepts any hour of the clock as a day boundary, and nothing else', () => {
    expect(userSchema.safeParse({ ...user, dayBoundaryHour: 0 }).success).toBe(true);
    expect(userSchema.safeParse({ ...user, dayBoundaryHour: 23 }).success).toBe(true);
    expect(userSchema.safeParse({ ...user, dayBoundaryHour: 24 }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, dayBoundaryHour: -1 }).success).toBe(false);
    expect(userSchema.safeParse({ ...user, dayBoundaryHour: 4.5 }).success).toBe(false);
  });
});

describe('foodSchema', () => {
  it('accepts a food with no energy density, which is the normal case', () => {
    const parsed = foodSchema.parse(food);
    expect(parsed.energyDensity).toBeUndefined();
  });

  it('accepts an energy density up to pure fat', () => {
    expect(foodSchema.safeParse({ ...food, energyDensity: 884 }).success).toBe(true);
  });

  it('rejects an energy density no food can have', () => {
    expect(foodSchema.safeParse({ ...food, energyDensity: 5000 }).success).toBe(false);
    expect(foodSchema.safeParse({ ...food, energyDensity: -1 }).success).toBe(false);
  });

  it('rejects a kind outside the union', () => {
    expect(foodSchema.safeParse({ ...food, kind: 'beverage' }).success).toBe(false);
  });
});

describe('foodClassificationSchema', () => {
  const seed = {
    id: ID,
    foodId: OTHER_ID,
    category: 'green',
    source: 'seed',
    createdAt: new Date('2026-09-06T08:00:00.000Z'),
  };

  it('accepts a seed verdict, which belongs to everyone and so has no user', () => {
    expect(foodClassificationSchema.parse(seed).userId).toBeUndefined();
  });

  it('accepts an AI verdict with its provenance', () => {
    const parsed = foodClassificationSchema.parse({
      ...seed,
      source: 'ai_text',
      model: 'claude-opus-5',
      promptVersion: 'v3',
      confidence: 0.82,
      reasoning: 'Rolled oats with no added sugar.',
      assumptions: ['No sugar was added', 'Cooked in water rather than milk'],
    });

    expect(parsed.assumptions).toHaveLength(2);
  });

  it('rejects a confidence outside zero to one', () => {
    expect(foodClassificationSchema.safeParse({ ...seed, confidence: 1.5 }).success).toBe(false);
    expect(foodClassificationSchema.safeParse({ ...seed, confidence: -0.1 }).success).toBe(false);
  });

  it('rejects a category outside the traffic light', () => {
    expect(foodClassificationSchema.safeParse({ ...seed, category: 'red' }).success).toBe(false);
  });

  it('accepts ai_vision, which is reserved and not yet produced', () => {
    expect(foodClassificationSchema.safeParse({ ...seed, source: 'ai_vision' }).success).toBe(true);
  });
});

describe('mealSchema', () => {
  it('accepts a meal and keeps the local date as a string', () => {
    expect(mealSchema.parse(meal).localDate).toBe('2026-09-06');
  });

  it('rejects a local date that is really a timestamp', () => {
    const bad = { ...meal, localDate: '2026-09-06T06:30:00.000Z' };
    expect(mealSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a meal type outside the union', () => {
    expect(mealSchema.safeParse({ ...meal, type: 'brunch' }).success).toBe(false);
  });
});

describe('mealItemSchema', () => {
  const item = { id: ID, mealId: OTHER_ID, foodId: ID, position: 0 };

  it('accepts an item with no quantity, and must keep doing so forever', () => {
    // The product does not ask users to weigh their food. If this ever fails, quantity has
    // become required and the product has turned into a calorie tracker.
    expect(mealItemSchema.safeParse(item).success).toBe(true);
  });

  it('accepts a quantity when one is supplied', () => {
    expect(mealItemSchema.parse({ ...item, quantity: 1.5 }).quantity).toBe(1.5);
  });

  it('rejects a non positive quantity', () => {
    expect(mealItemSchema.safeParse({ ...item, quantity: 0 }).success).toBe(false);
  });

  it('rejects a fractional or negative position', () => {
    expect(mealItemSchema.safeParse({ ...item, position: 1.5 }).success).toBe(false);
    expect(mealItemSchema.safeParse({ ...item, position: -1 }).success).toBe(false);
  });
});

describe('weightEntrySchema', () => {
  const entry = {
    id: ID,
    userId: OTHER_ID,
    weightGrams: 82_400,
    localDate: '2026-09-06',
    recordedAt: new Date('2026-09-06T06:00:00.000Z'),
  };

  it('accepts an entry in whole grams', () => {
    expect(weightEntrySchema.parse(entry).weightGrams).toBe(82_400);
  });

  it('rejects kilograms smuggled in as a float', () => {
    expect(weightEntrySchema.safeParse({ ...entry, weightGrams: 82.4 }).success).toBe(false);
  });
});

describe('serialisation', () => {
  it('round trips an entity through JSON, which is what the web client receives', () => {
    const wire: unknown = JSON.parse(JSON.stringify(mealSchema.parse(meal)));

    expect(mealSchema.parse(wire)).toEqual(mealSchema.parse(meal));
  });
});
