import { z } from 'zod';

import {
  foodSchema,
  mealItemSchema,
  mealSchema,
  weightEntrySchema,
  type WeightEntry,
} from './entities.js';
import { mealTypeSchema, timestampSchema } from './primitives.js';

/**
 * What crosses the wire. These live beside the entity schemas rather than in the API, so the
 * web client parses a response with the exact definition the server produced it from. A field
 * that is renamed or dropped breaks the typecheck on both sides in the same commit.
 *
 * Requests carry only what the caller supplies. Ids, timestamps and the owning user are the
 * server's to assign, so they are absent here by construction rather than by convention.
 */

export const createFoodRequestSchema = foodSchema.pick({
  name: true,
  kind: true,
  energyDensity: true,
});

export type CreateFoodRequest = z.infer<typeof createFoodRequestSchema>;

export const createMealRequestSchema = z.object({
  type: mealTypeSchema,
  /** Absent means now. The server stamps it and derives the local date from it. */
  loggedAt: timestampSchema.optional(),
  notes: mealSchema.shape.notes,
  /**
   * Order is meaning: the position stored on each item is this array's index. There is no
   * `.min(1)` here on purpose, an empty meal is a domain invariant rather than a shape error,
   * and it is rejected with a typed error by createMeal in api/src/domain/meal.ts.
   */
  items: z.array(mealItemSchema.pick({ foodId: true, quantity: true })),
});

export type CreateMealRequest = z.infer<typeof createMealRequestSchema>;

export const mealResponseSchema = mealSchema.extend({
  items: z.array(mealItemSchema),
});

export type MealResponse = z.infer<typeof mealResponseSchema>;

export const foodResponseSchema = foodSchema;

export type FoodResponse = z.infer<typeof foodResponseSchema>;

/**
 * Kilograms on the wire, grams in the database. Nobody types their weight in grams, and no
 * arithmetic should be done in a unit a user typed, so the conversion happens here, once, at
 * the point where the number stops being input and starts being data.
 *
 * The upper bound is not a plausibility check, it is what keeps `weightKg * 1000` finite.
 * Whether a reading is believable depends on the readings around it, see
 * api/src/domain/weight.ts.
 */
export const createWeightEntryRequestSchema = z
  .object({
    weightKg: z.number().positive().max(1000),
    /** Absent means now. */
    recordedAt: timestampSchema.optional(),
  })
  .transform(({ weightKg, ...rest }) => ({ ...rest, weightGrams: Math.round(weightKg * 1000) }));

export type CreateWeightEntryRequest = z.infer<typeof createWeightEntryRequestSchema>;

export const weightEntryResponseSchema = weightEntrySchema
  .omit({ weightGrams: true })
  .extend({ weightKg: z.number().positive() });

export type WeightEntryResponse = z.infer<typeof weightEntryResponseSchema>;

/** The other half of the boundary conversion. The only place grams turn back into kilograms. */
export function toWeightEntryResponse(entry: WeightEntry): WeightEntryResponse {
  const { weightGrams, ...rest } = entry;
  return { ...rest, weightKg: weightGrams / 1000 };
}
