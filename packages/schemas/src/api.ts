import { z } from 'zod';

import {
  foodSchema,
  mealItemSchema,
  mealSchema,
  userSchema,
  weightEntrySchema,
  type WeightEntry,
} from './entities.js';
import { emailSchema, mealTypeSchema, PASSWORD_MAX_LENGTH, timestampSchema } from './primitives.js';

/**
 * What crosses the wire. These live beside the entity schemas rather than in the API, so the
 * web client parses a response with the exact definition the server produced it from. A field
 * that is renamed or dropped breaks the typecheck on both sides in the same commit.
 *
 * Requests carry only what the caller supplies. Ids, timestamps and the owning user are the
 * server's to assign, so they are absent here by construction rather than by convention.
 *
 * Every request schema is strict. A property nobody declared is a mistake, a renamed field or
 * a client built against a different version, and answering 200 to it is how that mistake
 * reaches production dressed as working code. The test beside this file checks that every
 * schema named `*RequestSchema` is strict, and api/test/http/app.test.ts checks that the
 * HTTP layer turns the resulting issue into a 400 rather than a quiet 200.
 */

export const createFoodRequestSchema = foodSchema
  .pick({
    name: true,
    kind: true,
    energyDensity: true,
  })
  .strict();

export type CreateFoodRequest = z.infer<typeof createFoodRequestSchema>;

export const createMealRequestSchema = z.strictObject({
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
  .strictObject({
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

/**
 * Credentials on their way in. The email is normalised by its own schema, so `Foo@Example.com`
 * and `foo@example.com` are the same account before the lookup happens rather than after it.
 *
 * The password is checked for length and for nothing else, deliberately. passwordSchema is the
 * policy a password is held to when it is set. Applying it here would answer a wrong password
 * that happens to be short with a 400 and a list of issues, next to the 401 a wrong password of
 * the right length gets, and a client that can tell those two apart has been handed a detail
 * about stored passwords that nobody meant to send.
 */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * A user as the wire sees one. There is no password field to remember to strip: userSchema
 * never had one, the hash exists only as a column, so no handler can leak it by forgetting.
 *
 * `createdAt` is dropped rather than converted. timestampSchema parses an instant on the way in
 * and cannot encode one on the way out, so any response schema containing it serialises to a
 * 500. Nothing about signing in needs the date the account was made, so this is a field that is
 * absent rather than a conversion that is present.
 */
export const userResponseSchema = userSchema.omit({ createdAt: true });

export type UserResponse = z.infer<typeof userResponseSchema>;

export const loginResponseSchema = z.object({
  /**
   * The session credential, and the only time it is ever readable. The server keeps a SHA-256
   * of it and not the string itself, so a lost token cannot be recovered from the database, and
   * a copy of the database is not a set of live sessions.
   *
   * It is in the body because there is no cookie layer yet. Moving it into an HttpOnly cookie,
   * with the sliding expiry and the revocation list around it, is the sessions story.
   */
  sessionToken: z.string(),
  /** When that token stops working, whatever the client does with it in the meantime. */
  expiresAt: z.iso.datetime(),
  user: userResponseSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;
