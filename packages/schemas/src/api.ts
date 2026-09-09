import { z } from 'zod';

import {
  foodSchema,
  mealItemSchema,
  mealSchema,
  userSchema,
  weightEntrySchema,
  type WeightEntry,
} from './entities.js';
import {
  apiTokenNameSchema,
  emailSchema,
  idSchema,
  mealTypeSchema,
  PASSWORD_MAX_LENGTH,
  scopeSchema,
  timestampSchema,
} from './primitives.js';

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
   * When the session stops working if nothing touches it again. The credential itself is not
   * here and is not anywhere a script can read: it is set as an HttpOnly cookie, so the page
   * that signed in cannot read its own session token and neither can anything injected into it.
   *
   * A caller that wants a credential it can hold, an MCP server or a deploy script, does not
   * sign in at all. It is handed an API token minted from a session, see createApiTokenResponse.
   */
  expiresAt: z.iso.datetime(),
  user: userResponseSchema,
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * One of the browsers a user is signed in on. There is no token or hash of one here: the row's
 * id is what a session is listed and revoked by, which is exactly why it is not the credential.
 *
 * `current` is the session the request asking for this list arrived on, marked so that revoking
 * one is a decision rather than an accident.
 */
export const sessionResponseSchema = z.object({
  id: idSchema,
  createdAt: z.iso.datetime(),
  /** Last time a request on this session moved its expiry. See ACTIVITY_INTERVAL_MS. */
  lastActivityAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  current: z.boolean(),
});

export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * An API token as its owner sees it afterwards, which is everything about it except the thing
 * that makes it work. The plaintext exists in one response, once, see below.
 *
 * The nullable fields are null rather than absent. A client that has to check whether
 * `lastUsedAt` is there before checking whether it is null has two code paths for "never used".
 */
export const apiTokenResponseSchema = z.object({
  id: idSchema,
  name: apiTokenNameSchema,
  scopes: z.array(scopeSchema),
  createdAt: z.iso.datetime(),
  /** Null until the token authenticates something. Written at most once a minute after that. */
  lastUsedAt: z.iso.datetime().nullable(),
  /** Null means it does not expire on its own and lives until it is revoked. */
  expiresAt: z.iso.datetime().nullable(),
});

export type ApiTokenResponse = z.infer<typeof apiTokenResponseSchema>;

/**
 * Minting one. The scopes are the caller's choice and are checked against what the caller
 * actually has: a token cannot carry more than the user issuing it, which is the only reason
 * this endpoint can be reached by anyone other than an administrator.
 *
 * `expiresInDays` is a duration rather than a date, because the client is asking for "ninety
 * days from now" and a date computed on a laptop with a wrong clock is a token that dies on a
 * Tuesday for no reason. Absent means it lives until it is revoked.
 */
export const createApiTokenRequestSchema = z.strictObject({
  name: apiTokenNameSchema,
  scopes: z.array(scopeSchema).min(1),
  expiresInDays: z.int().positive().max(365).optional(),
});

export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

/**
 * The one response that carries a usable token, and the only time that string exists outside
 * the client that asked for it. The server stored a SHA-256 of it, so this is not recoverable
 * afterwards by anybody, including whoever holds the database file.
 */
export const createApiTokenResponseSchema = apiTokenResponseSchema.extend({
  token: z.string(),
});

export type CreateApiTokenResponse = z.infer<typeof createApiTokenResponseSchema>;
