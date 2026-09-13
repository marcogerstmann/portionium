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
  /**
   * The chosen interface language, or null for a user who has never chosen one. Null is a state
   * rather than an absent value: it is what lets the client keep following `navigator.languages`
   * for this account instead of pinning it to whatever the browser said the first time they
   * signed in, see resolveLocale in web/src/i18n.ts. No default, the same reason timezone has
   * none: a row always carries one or the other explicitly, there is nothing sensible to fall
   * back to here.
   */
  locale: localeSchema.nullable(),
  createdAt: timestampSchema,
});

export type User = z.infer<typeof userSchema>;

export const foodSchema = z.object({
  id: idSchema,
  /**
   * Trimmed before it is measured, the same way an email address is normalised by its own
   * schema. Surrounding whitespace is never meaningful in a food name and a leading space is
   * how one catalog ends up with two entries that read identically.
   */
  name: z.string().trim().min(1).max(200),
  kind: foodKindSchema,
  /**
   * Kilocalories per 100 g. Optional because most foods are classified without anyone knowing
   * it, and the traffic light never needs it. The ceiling is pure fat, at roughly 900.
   */
  energyDensity: z.number().nonnegative().max(900).optional(),
  /** Absent on the entries seeded with the app. The catalog is shared, its seeds are nobody's. */
  createdBy: idSchema.optional(),
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

export const entrySchema = z.object({
  id: idSchema,
  mealId: idSchema,
  /**
   * The food this entry came from, or null for a bare colour. Provenance rather than the
   * subject: an entry is a colour, and naming the preset it was logged from is what makes the
   * search, the catalog and the review queue worth having. See docs/adr/011-an-entry-is-a-colour.md.
   */
  foodId: idSchema.nullable(),
  /**
   * The colour this entry was logged as, written when it happened and never recomputed. Null
   * means nobody has judged the food behind it yet, which is a state and not a failure: a `user`
   * verdict on that food fills it in, see insertClassifications in api/src/db/classification.ts.
   *
   * Null beside a null `foodId` is refused by the table's own CHECK rather than by application
   * code, so an entry that means nothing is not expressible.
   */
  category: categorySchema.nullable(),
  /**
   * Deliberately optional and deliberately unused. Portion sizes are not part of the product,
   * the whole point is that a user does not weigh their food. This is here so that a later
   * feature can record a number without a migration.
   *
   * It must never become required. A required quantity turns this into a calorie tracker, and a
   * bare colour is the opposite of a portion rather than a step towards one.
   */
  quantity: z.number().positive().optional(),
  /** Display order within the meal, zero based and dense. Assigned by the domain factory. */
  position: z.int().nonnegative(),
});

export type Entry = z.infer<typeof entrySchema>;

/**
 * What a caller supplies for one entry, on a meal or a favourite alike. Extracted because three
 * different requests take exactly this and nothing more, see createMealRequestSchema,
 * updateMealRequestSchema and createFavouriteRequestSchema in api.ts.
 *
 * Three combinations, and the refinement below is what rules out the fourth:
 *
 *   - `foodId` alone, the ordinary case: the server stamps the colour that food resolves to for
 *     this caller at this moment, or leaves it null when nobody has judged it yet
 *   - `foodId` with `category`, an explicit colour for this one entry with the provenance kept
 *   - `category` alone, a bare colour: somebody logging what they ate without naming it
 *
 * Neither field is refused here rather than by the table's CHECK, so a client gets a 400 that
 * names the problem instead of a 500 from a constraint.
 */
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

/**
 * A meal composition a user has named and pinned on purpose, "Standard Frühstück", rather than
 * one this API noticed from their history, see the suggestion schemas in api.ts. Favourites are
 * private: `userId` is never null the way a shared catalog food's `createdBy` can be.
 *
 * `entries` carries no `position`. The array's own order is the order, the same convention
 * `entrySchema.position` encodes explicitly for a stored meal, and it is what lets a favourite's
 * entries go straight into createMeal to become a real one.
 */
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
  /** The day this reading belongs to. Two readings on one day are allowed, people re-weigh. */
  localDate: localDateSchema,
  recordedAt: timestampSchema,
});

export type WeightEntry = z.infer<typeof weightEntrySchema>;
