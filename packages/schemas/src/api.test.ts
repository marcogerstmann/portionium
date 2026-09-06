import { describe, expect, it } from 'vitest';

import {
  createMealRequestSchema,
  createWeightEntryRequestSchema,
  toWeightEntryResponse,
  weightEntryResponseSchema,
} from './api.js';

const ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
const OTHER_ID = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b32';

describe('createMealRequestSchema', () => {
  it('accepts a meal with items and no explicit timestamp', () => {
    const parsed = createMealRequestSchema.parse({
      type: 'lunch',
      items: [{ foodId: ID }, { foodId: OTHER_ID, quantity: 2 }],
    });

    expect(parsed.loggedAt).toBeUndefined();
    expect(parsed.items).toHaveLength(2);
  });

  it('lets an empty item list through, because that is a domain error and not a shape error', () => {
    expect(createMealRequestSchema.safeParse({ type: 'lunch', items: [] }).success).toBe(true);
  });

  it('rejects an item pointing at something that is not a food id', () => {
    const request = { type: 'lunch', items: [{ foodId: 'porridge' }] };
    expect(createMealRequestSchema.safeParse(request).success).toBe(false);
  });

  it('does not accept a caller supplied user id, the session decides who is writing', () => {
    const parsed = createMealRequestSchema.parse({
      type: 'lunch',
      items: [],
      userId: ID,
    });

    expect(parsed).not.toHaveProperty('userId');
  });
});

describe('createWeightEntryRequestSchema', () => {
  it('converts kilograms on the wire into whole grams for storage', () => {
    const parsed = createWeightEntryRequestSchema.parse({ weightKg: 82.4 });
    expect(parsed.weightGrams).toBe(82_400);
  });

  it('rounds rather than truncating, and never yields a fraction of a gram', () => {
    expect(createWeightEntryRequestSchema.parse({ weightKg: 82.4567 }).weightGrams).toBe(82_457);
    expect(
      Number.isInteger(createWeightEntryRequestSchema.parse({ weightKg: 0.0004 }).weightGrams),
    ).toBe(true);
  });

  it('rejects a weight large enough to make the conversion overflow', () => {
    expect(createWeightEntryRequestSchema.safeParse({ weightKg: 1e308 }).success).toBe(false);
  });

  it('rejects zero, negatives and non numbers', () => {
    expect(createWeightEntryRequestSchema.safeParse({ weightKg: 0 }).success).toBe(false);
    expect(createWeightEntryRequestSchema.safeParse({ weightKg: -82.4 }).success).toBe(false);
    expect(createWeightEntryRequestSchema.safeParse({ weightKg: '82.4' }).success).toBe(false);
  });
});

describe('the weight boundary', () => {
  const entry = {
    id: ID,
    userId: OTHER_ID,
    weightGrams: 82_400,
    localDate: '2026-09-06' as const,
    recordedAt: new Date('2026-09-06T06:00:00.000Z'),
  };

  it('sends kilograms back out and keeps grams off the wire', () => {
    const response = toWeightEntryResponse(entry);

    expect(response.weightKg).toBe(82.4);
    expect(response).not.toHaveProperty('weightGrams');
  });

  it('produces something the response schema accepts, which is what the client parses', () => {
    const wire: unknown = JSON.parse(JSON.stringify(toWeightEntryResponse(entry)));

    expect(weightEntryResponseSchema.parse(wire).weightKg).toBe(82.4);
  });

  it('round trips a weight through both halves of the conversion', () => {
    const stored = createWeightEntryRequestSchema.parse({ weightKg: 82.4 }).weightGrams;

    expect(toWeightEntryResponse({ ...entry, weightGrams: stored }).weightKg).toBe(82.4);
  });
});
