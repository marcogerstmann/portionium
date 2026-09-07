import { z } from 'zod';

import {
  categorySchema,
  classificationSourceSchema,
  dayBoundaryHourSchema,
  foodKindSchema,
  idSchema,
  localDateSchema,
  mealTypeSchema,
  timestampSchema,
  timezoneSchema,
  userRoleSchema,
  weightGramsSchema,
} from './primitives.js';

/**
 * The persisted shape of every entity, as the domain sees it: camelCase fields, Dates for
 * instants, grams for weight. Types are inferred from these schemas, never declared alongside
 * them, so the validator and the type cannot disagree.
 *
 * These describe shape and context free validation only. An invariant that needs to look at
 * anything other than the object in front of it lives in api/src/domain/.
 */

export const userSchema = z.object({
  id: idSchema,
  email: z.email(),
  displayName: z.string().min(1).max(100),
  role: userRoleSchema,
  /** Drives every local date this user's rows are stamped with. */
  timezone: timezoneSchema,
  /** The local hour this user's day rolls over at. Applied with `timezone`, never alone. */
  dayBoundaryHour: dayBoundaryHourSchema,
  createdAt: timestampSchema,
});

export type User = z.infer<typeof userSchema>;

export const foodSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(200),
  kind: foodKindSchema,
  /**
   * Kilocalories per 100 g. Optional because most foods are classified without anyone knowing
   * it, and the traffic light never needs it. The ceiling is pure fat, at roughly 900.
   */
  energyDensity: z.number().nonnegative().max(900).optional(),
  createdBy: idSchema,
  createdAt: timestampSchema,
});

export type Food = z.infer<typeof foodSchema>;

/**
 * One verdict about one food. A food can carry several: the seeded default, an AI verdict, and
 * a user's own override, which is why this is a table and not a column on Food.
 *
 * `userId` is absent on the rows that apply to everyone, the seeds and the shared AI verdicts.
 * The provenance fields are absent on anything a model did not produce.
 */
export const foodClassificationSchema = z.object({
  id: idSchema,
  foodId: idSchema,
  userId: idSchema.optional(),
  category: categorySchema,
  source: classificationSourceSchema,
  model: z.string().min(1).max(100).optional(),
  promptVersion: z.string().min(1).max(50).optional(),
  confidence: z.number().min(0).max(1).optional(),
  reasoning: z.string().max(2000).optional(),
  /** What the model had to guess at, one short sentence each. Shown when a user disputes. */
  assumptions: z.array(z.string().min(1).max(500)).optional(),
  createdAt: timestampSchema,
});

export type FoodClassification = z.infer<typeof foodClassificationSchema>;

export const mealSchema = z.object({
  id: idSchema,
  userId: idSchema,
  type: mealTypeSchema,
  /** The instant, in UTC. The single source of truth for when this happened. */
  loggedAt: timestampSchema,
  /**
   * `loggedAt` rendered in the user's timezone, denormalised at write time. Stored rather than
   * computed on read because every list, streak and summary groups by it, and doing that in
   * SQL means the grouping key has to be an indexable column.
   */
  localDate: localDateSchema,
  notes: z.string().max(2000).optional(),
});

export type Meal = z.infer<typeof mealSchema>;

export const mealItemSchema = z.object({
  id: idSchema,
  mealId: idSchema,
  foodId: idSchema,
  /**
   * Deliberately optional and deliberately unused. Portion sizes are not part of the product,
   * the whole point is that a user does not weigh their food. This is here so that a later
   * feature can record a number without a migration.
   *
   * It must never become required. A required quantity turns this into a calorie tracker.
   */
  quantity: z.number().positive().optional(),
  /** Display order within the meal, zero based and dense. Assigned by the domain factory. */
  position: z.int().nonnegative(),
});

export type MealItem = z.infer<typeof mealItemSchema>;

export const weightEntrySchema = z.object({
  id: idSchema,
  userId: idSchema,
  weightGrams: weightGramsSchema,
  /** The day this reading belongs to. Two readings on one day are allowed, people re-weigh. */
  localDate: localDateSchema,
  recordedAt: timestampSchema,
});

export type WeightEntry = z.infer<typeof weightEntrySchema>;
