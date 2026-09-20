import { z } from 'zod';

import {
  categorySchema,
  classificationSourceSchema,
  dayBoundaryHourSchema,
  foodKindSchema,
  idSchema,
  localDateSchema,
  localeSchema,
  mealTypeSchema,
  timestampSchema,
  timezoneSchema,
  userRoleSchema,
  weightGramsSchema,
} from './primitives.js';

export const userSchema = z.object({
  id: idSchema,
  email: z.email(),
  displayName: z.string().min(1).max(100),
  role: userRoleSchema,
  timezone: timezoneSchema,
  dayBoundaryHour: dayBoundaryHourSchema,
  locale: localeSchema.nullable(),
  createdAt: timestampSchema,
});

export type User = z.infer<typeof userSchema>;

export const foodSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  kind: foodKindSchema,
  energyDensity: z.number().nonnegative().max(900).optional(),
  createdBy: idSchema.optional(),
  createdAt: timestampSchema,
});

export type Food = z.infer<typeof foodSchema>;

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
  assumptions: z.array(z.string().min(1).max(500)).optional(),
  createdAt: timestampSchema,
});

export type FoodClassification = z.infer<typeof foodClassificationSchema>;

export const mealSchema = z.object({
  id: idSchema,
  userId: idSchema,
  type: mealTypeSchema,
  loggedAt: timestampSchema,
  /**
   * Derived from `loggedAt` at write time and never recomputed, see
   * docs/adr/002-local-day-boundaries.md.
   */
  localDate: localDateSchema,
  notes: z.string().max(2000).optional(),
});

export type Meal = z.infer<typeof mealSchema>;

export const entrySchema = z.object({
  id: idSchema,
  mealId: idSchema,
  foodId: idSchema.nullable(),
  /**
   * Stamped when the entry was logged and never recomputed from the food, see
   * docs/adr/011-an-entry-is-a-colour.md.
   */
  category: categorySchema.nullable(),
  /**
   * Deliberately unused. Portions are not part of the product; the field exists so the MCP adapter
   * can carry one.
   */
  quantity: z.number().positive().optional(),
  position: z.int().nonnegative(),
});

export type Entry = z.infer<typeof entrySchema>;

export const entryInputSchema = z
  .object({
    foodId: idSchema.optional(),
    category: categorySchema.optional(),
    quantity: entrySchema.shape.quantity,
  })
  .refine((entry) => entry.foodId !== undefined || entry.category !== undefined, {
    error: 'An entry must name a food, a colour, or both.',
  });

export type EntryInput = z.infer<typeof entryInputSchema>;

export const mealFavouriteSchema = z.object({
  id: idSchema,
  userId: idSchema,
  name: z.string().trim().min(1).max(100),
  type: mealTypeSchema,
  entries: z.array(entryInputSchema),
  createdAt: timestampSchema,
});

export type MealFavourite = z.infer<typeof mealFavouriteSchema>;

export const weightEntrySchema = z.object({
  id: idSchema,
  userId: idSchema,
  weightGrams: weightGramsSchema,
  localDate: localDateSchema,
  recordedAt: timestampSchema,
});

export type WeightEntry = z.infer<typeof weightEntrySchema>;
