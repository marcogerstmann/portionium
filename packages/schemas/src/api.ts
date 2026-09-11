import { z } from 'zod';

import {
  foodClassificationSchema,
  foodSchema,
  mealFavouriteSchema,
  mealItemInputSchema,
  mealItemSchema,
  mealSchema,
  userSchema,
  weightEntrySchema,
  type User,
  type WeightEntry,
} from './entities.js';
import {
  apiTokenNameSchema,
  categorySchema,
  emailSchema,
  foodKindSchema,
  idSchema,
  localDateSchema,
  mealTypeSchema,
  PASSWORD_MAX_LENGTH,
  passwordSchema,
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

/**
 * Paging, written down once for every list this API will ever serve, before the first one
 * exists. Two parameters, `limit` and `cursor`, and one envelope.
 *
 * Cursor based rather than offset based. An offset addresses rows by position, so a row
 * inserted or removed while somebody is paging shifts everything after it and the client sees
 * an entry twice or misses one entirely. Meals and weight entries come back newest first and
 * are written continuously, which is exactly the case an offset gets wrong.
 *
 * A cursor is opaque and the only correct thing a client can do with one is send it back. What
 * it contains is the endpoint's business: ids here are UUIDv7 and therefore already sort by
 * creation time, so in practice it is the last id of the page. There is deliberately no encode
 * or decode helper here, because nothing issues a cursor yet and a helper written now would be
 * a guess that the first real endpoint has to work around.
 *
 * `nextCursor` is null on the last page rather than absent, so a client has one check for
 * "there is more" instead of two.
 */
export const paginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * A page of anything. A function rather than a constant, so the item type survives into the
 * response type a route is inferred from.
 */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/**
 * Adding to the catalog. `kind` is optional and defaults to `ingredient`, because the moment a
 * food is created is the moment somebody is halfway through logging a meal, and a required
 * label that nothing branches on would be a question asked at the worst possible time.
 *
 * There is no `category` here, and there is not one on the update either. A colour is a verdict
 * with a source and an author, so it is written through the classification endpoint and never
 * as a field on the food. See docs/adr/006-single-foods-table.md.
 */
export const createFoodRequestSchema = foodSchema
  .pick({ name: true, energyDensity: true })
  .extend({ kind: foodKindSchema.default('ingredient') })
  .strict();

export type CreateFoodRequest = z.infer<typeof createFoodRequestSchema>;

/**
 * Editing one. Both fields optional, so a client sends the one it is changing rather than
 * writing back a whole entry it read a minute ago. An empty body is a no-op, not a 400: it
 * asks for nothing and gets the entry as it stands.
 */
export const updateFoodRequestSchema = foodSchema
  .pick({ name: true, kind: true })
  .partial()
  .strict();

export type UpdateFoodRequest = z.infer<typeof updateFoodRequestSchema>;

/**
 * Browsing it. `kind` narrows to one label, `unclassified` narrows to the entries that resolve
 * to no colour for whoever is asking, which is the caller's own backlog rather than a global
 * one: two users looking at the same catalog see different entries here.
 *
 * A query string only ever carries strings, so the flag goes through `z.stringbool` rather than
 * `z.boolean`, which would reject the `?unclassified=true` every client actually sends.
 */
export const foodListQuerySchema = paginationQuerySchema.extend({
  kind: foodKindSchema.optional(),
  unclassified: z.stringbool().optional(),
});

export type FoodListQuery = z.infer<typeof foodListQuerySchema>;

/**
 * Searching it. `q` is what somebody has typed so far, so it is matched loosely: inside a word,
 * across a space, and through a single typo. What that means exactly is api/src/domain/food-search.ts.
 *
 * An empty `q` is the default rather than a 400, and it is why the field has one. An
 * autocomplete is focused before it is typed into, and the useful answer at that moment is the
 * caller's own most eaten foods, which is a result the same endpoint can give.
 *
 * There is no cursor here and results are not a page. A ranked list is only meaningful from the
 * top, the interesting part of it is the first handful, and a second page of increasingly
 * unlikely guesses is not something a search box asks for. `limit` is smaller than the
 * catalog's for the same reason: a dropdown nobody scrolls.
 */
export const foodSearchQuerySchema = z.strictObject({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type FoodSearchQuery = z.infer<typeof foodSearchQuerySchema>;

export const createMealRequestSchema = z.strictObject({
  /**
   * Absent means the server mints one. Present is what lets a meal logged offline keep the id
   * it was given on the device: the client generates a UUIDv7 the moment somebody logs it, and
   * syncing later is handing the server that same id rather than asking for a new one. An id
   * that already belongs to a row is refused rather than silently overwriting it, see
   * insertMeal in api/src/db/meal.ts.
   */
  id: idSchema.optional(),
  type: mealTypeSchema,
  /** Absent means now. The server stamps it and derives the local date from it. */
  loggedAt: timestampSchema.optional(),
  notes: mealSchema.shape.notes,
  /**
   * Order is meaning: the position stored on each item is this array's index. There is no
   * `.min(1)` here on purpose, an empty meal is a domain invariant rather than a shape error,
   * and it is rejected with a typed error by createMeal in api/src/domain/meal.ts. Absent has
   * the same meaning as empty, which is what lets a request name `fromMealId` instead.
   */
  items: z.array(mealItemInputSchema).optional(),
  /**
   * Copies another meal's items into this one instead of listing them again: the "repeat this"
   * and "log this suggestion" flows both end up here rather than each inventing its own way to
   * resend an item list the server already has. Mutually exclusive with `items`, see POST
   * /meals in api/src/http/routes/meals.ts, which is where that is enforced.
   */
  fromMealId: idSchema.optional(),
});

export type CreateMealRequest = z.infer<typeof createMealRequestSchema>;

/** One item on its way out, with the colour resolved for whoever asked, the same as a food. */
export const mealItemResponseSchema = mealItemSchema.omit({ mealId: true }).extend({
  category: categorySchema.nullable(),
});

export type MealItemResponse = z.infer<typeof mealItemResponseSchema>;

/**
 * `loggedAt` is re-typed rather than inherited from mealSchema. timestampSchema is a one way
 * transform, built to turn a string or a Date arriving on a request into a Date the domain
 * works with; asked to run the other way, in a response, it throws. Every instant that leaves
 * this API over HTTP is a plain ISO string for that reason, see foodClassificationResponseSchema
 * and toMealResponse in api/src/http/routes/meals.ts, which is where the Date becomes one.
 */
export const mealResponseSchema = mealSchema.omit({ loggedAt: true }).extend({
  loggedAt: z.iso.datetime(),
  items: z.array(mealItemResponseSchema),
});

export type MealResponse = z.infer<typeof mealResponseSchema>;

/**
 * Browsing a caller's own meals. Newest first, like every feed of a user's own rows, which is
 * why the cursor here means "older than this" rather than foodListQuerySchema's "after this":
 * see listMeals in api/src/db/meal.ts.
 *
 * `from` and `to` are local dates rather than instants, because a day is what a client filters
 * by, "yesterday" or "this week", and a local date is the column meals are already grouped by.
 */
export const mealListQuerySchema = paginationQuerySchema.extend({
  type: mealTypeSchema.optional(),
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

export type MealListQuery = z.infer<typeof mealListQuerySchema>;

/**
 * Editing one. Every field optional, the same convention updateProfileRequestSchema follows: a
 * client sends what it is changing and an absent field is a field nobody touched.
 *
 * `items` is the exception to that reading. Left out, the meal's current items stand; sent, it
 * replaces the whole list, position and all, which is what lets one PATCH add, remove and
 * reorder items instead of three separate verbs. An empty array is let through here for the same
 * reason createMealRequestSchema lets one through: leaving a meal with no items is a domain
 * invariant, not a shape error, see applyMealChanges in api/src/domain/meal.ts.
 */
export const updateMealRequestSchema = z.strictObject({
  type: mealTypeSchema.optional(),
  loggedAt: timestampSchema.optional(),
  notes: mealSchema.shape.notes,
  items: z.array(mealItemInputSchema).optional(),
});

export type UpdateMealRequest = z.infer<typeof updateMealRequestSchema>;

/** One item of a suggestion or a favourite, with the colour resolved the way a meal item's is. */
export const mealCompositionItemResponseSchema = mealItemInputSchema.extend({
  category: categorySchema.nullable(),
});

export type MealCompositionItemResponse = z.infer<typeof mealCompositionItemResponseSchema>;

/**
 * Asking what to log again. `type` narrows to one meal type because a suggestion only makes
 * sense in the context a client is logging in, breakfast suggestions while logging breakfast.
 * `limit` is small and capped low: a caller's distinct compositions for one meal type are a
 * handful, this is a shortlist to tap from and not a page to browse, see foodSearchQuerySchema
 * for the same reasoning applied to a search box instead of a shortlist.
 */
export const mealSuggestionsQuerySchema = z.strictObject({
  type: mealTypeSchema,
  limit: z.coerce.number().int().min(1).max(20).default(5),
});

export type MealSuggestionsQuery = z.infer<typeof mealSuggestionsQuerySchema>;

/**
 * One frequently logged composition, ranked ahead of the response: the array order is the
 * suggestion order, there is no score on the wire to sort by because there is nothing correct a
 * client could do with one beyond what the order already says.
 *
 * `mealId` is the most recent meal this composition came from, and is what a client hands back
 * as `fromMealId` on POST /meals to log it in the one tap POR-33 asks for, rather than resending
 * the item list it was just given.
 */
export const mealSuggestionResponseSchema = z.object({
  mealId: idSchema,
  items: z.array(mealCompositionItemResponseSchema),
});

export type MealSuggestionResponse = z.infer<typeof mealSuggestionResponseSchema>;

/**
 * Pinning one. `items` is held to the same shape createMealRequestSchema's is and to the same
 * domain invariant, no empty list, enforced by validateFavouriteItems in
 * api/src/domain/meal.ts rather than here for the reason that comment gives.
 */
export const createFavouriteRequestSchema = mealFavouriteSchema
  .pick({ name: true, type: true, items: true })
  .strict();

export type CreateFavouriteRequest = z.infer<typeof createFavouriteRequestSchema>;

/**
 * A favourite on its way out. `userId` is dropped, favourites are private so it is always the
 * caller's own, and `items` carries the resolved colour the same reason a suggestion's does: so
 * a preview renders from this response alone.
 */
export const favouriteResponseSchema = mealFavouriteSchema
  .omit({ userId: true, createdAt: true, items: true })
  .extend({ items: z.array(mealCompositionItemResponseSchema) });

export type FavouriteResponse = z.infer<typeof favouriteResponseSchema>;

/** Browsing a caller's own favourites, newest first, the same convention every other list follows. */
export const favouriteListQuerySchema = paginationQuerySchema.extend({
  type: mealTypeSchema.optional(),
});

export type FavouriteListQuery = z.infer<typeof favouriteListQuerySchema>;

/**
 * How many of a day's items landed in each colour, including the ones nobody has judged yet.
 * Counted over items rather than meals, since a colour is a property of what was eaten and one
 * meal usually carries more than one.
 */
export const colourCountsSchema = z.object({
  green: z.int().nonnegative(),
  yellow: z.int().nonnegative(),
  orange: z.int().nonnegative(),
  unclassified: z.int().nonnegative(),
});

export type ColourCounts = z.infer<typeof colourCountsSchema>;

/**
 * A catalog entry on its way out, with the colour resolved for whoever asked for it. There is
 * no raw global category anywhere in this API: `category` is always the answer to "what colour
 * is this for you", which for two people in one household is two different answers.
 *
 * Null rather than absent, because a food with no verdict yet is a state the client renders
 * rather than a field it has to feel around for. Logging one is always allowed, see
 * docs/adr/006-single-foods-table.md.
 *
 * `createdAt` is dropped rather than converted, for the reason userResponseSchema states:
 * timestampSchema parses an instant and cannot encode one, so a response carrying it would
 * serialise to a 500. Nothing about a catalog entry needs the minute it was added.
 */
export const foodResponseSchema = foodSchema
  .omit({ createdAt: true })
  .extend({ category: categorySchema.nullable() });

export type FoodResponse = z.infer<typeof foodResponseSchema>;

/**
 * Why a food is the colour it is: which verdict won, where it came from, and what the model was
 * unsure about if a model produced it.
 *
 * `foodId` and `userId` are dropped. The first is in the URL that fetched this, and the second
 * is either absent or the caller, since resolution never looks at anybody else's rows: `source`
 * already says whether this verdict is the caller's own, a model's, or the one that shipped.
 */
export const foodClassificationResponseSchema = foodClassificationSchema
  .omit({ foodId: true, userId: true, createdAt: true })
  .extend({ createdAt: z.iso.datetime() });

export type FoodClassificationResponse = z.infer<typeof foodClassificationResponseSchema>;

/**
 * Overriding a food's colour. `category` is the verdict, `reasoning` is why, the same field a
 * model's own verdict carries it under, and it is optional for the same reason a model's is not
 * required to guess right: not every disagreement needs a sentence attached to it.
 *
 * There is no `source` and no `userId` here. Both are the server's to assign: the endpoint
 * that accepts this is what makes the source `user`, and the caller in `request.auth` is the
 * only place a user id for a write ever comes from. See docs/adr/007-append-only-classification-log.md.
 */
export const createClassificationRequestSchema = foodClassificationSchema
  .pick({ category: true, reasoning: true })
  .strict();

export type CreateClassificationRequest = z.infer<typeof createClassificationRequestSchema>;

/** One entry, with the provenance of the colour beside the colour. Null when there is none. */
export const foodDetailResponseSchema = foodResponseSchema.extend({
  classification: foodClassificationResponseSchema.nullable(),
});

export type FoodDetailResponse = z.infer<typeof foodDetailResponseSchema>;

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

/** `recordedAt` re-typed for the same reason mealResponseSchema's `loggedAt` is, see there. */
export const weightEntryResponseSchema = weightEntrySchema
  .omit({ weightGrams: true, recordedAt: true })
  .extend({ weightKg: z.number().positive(), recordedAt: z.iso.datetime() });

export type WeightEntryResponse = z.infer<typeof weightEntryResponseSchema>;

/** The other half of the boundary conversion. The only place grams turn back into kilograms. */
export function toWeightEntryResponse(entry: WeightEntry): WeightEntryResponse {
  const { weightGrams, recordedAt, ...rest } = entry;
  return { ...rest, weightKg: weightGrams / 1000, recordedAt: recordedAt.toISOString() };
}

/**
 * Browsing a caller's own weight, newest first, the same convention mealListQuerySchema
 * follows: see listWeightEntries in api/src/db/weight.ts. `from` and `to` are local dates for
 * the same reason meals filters by them, a day is what somebody filters by and it is the
 * column weight is already grouped by.
 */
export const weightListQuerySchema = paginationQuerySchema.extend({
  from: localDateSchema.optional(),
  to: localDateSchema.optional(),
});

export type WeightListQuery = z.infer<typeof weightListQuerySchema>;

/**
 * What POST /weight answers with, weightEntryResponseSchema plus the one field a plain read
 * never carries: whether this reading looked like an implausible jump from the nearest one on
 * record. Null when it was unremarkable. Never blocks the write, see createWeightEntry in
 * api/src/domain/weight.ts.
 */
export const weightEntryCreateResponseSchema = weightEntryResponseSchema.extend({
  warning: z.string().nullable(),
});

export type WeightEntryCreateResponse = z.infer<typeof weightEntryCreateResponseSchema>;

/**
 * Everything the app needs the moment it opens: the day's meals with their items and colours,
 * today's weight if there is one, and the counts a summary bar draws without re-deriving them
 * from the meal list. See the performance note on GET /days/{date} for why this is assembled
 * from a small fixed number of queries rather than one per meal or per item.
 */
export const dayResponseSchema = z.object({
  date: localDateSchema,
  meals: z.array(mealResponseSchema),
  weightEntry: weightEntryResponseSchema.nullable(),
  colourCounts: colourCountsSchema,
});

export type DayResponse = z.infer<typeof dayResponseSchema>;

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

/**
 * The other direction, and the one place a stored account becomes one on the wire.
 *
 * The fields are listed rather than spread. Every row this is called with carries a password
 * hash, and a response that is safe because a schema happens to strip an extra key is a
 * response that stops being safe the day somebody reaches for a looser schema.
 */
export function toUserResponse(user: User): UserResponse {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    timezone: user.timezone,
    dayBoundaryHour: user.dayBoundaryHour,
  };
}

/**
 * What a user may change about themselves. Every field is optional, so a client sends the one
 * it is changing rather than writing back the whole profile it read a minute ago, which is how
 * one open tab silently reverts an edit made in another.
 *
 * Email and role are absent by construction rather than by filtering. An address identifies
 * the account and changing one needs a confirmation flow that does not exist here; a role is
 * something an administrator grants, and a user who could PATCH their own would already be one.
 *
 * The timezone is held to timezoneSchema, which asks the runtime's own IANA database rather
 * than a list bundled here. So `Europe/Berlin` is accepted and `CEST` is a 400, before
 * anything tries to derive a local date from it. See resolveLocalDate.
 */
export const updateProfileRequestSchema = userSchema
  .pick({ displayName: true, timezone: true, dayBoundaryHour: true })
  .partial()
  .strict();

export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/**
 * Rotating a password. The current one is required and is verified by the server, so a session
 * somebody left open on a shared machine is not enough to take the account over for good.
 *
 * The two fields are held to different schemas, the same split loginRequestSchema makes. The
 * new one is held to the policy because it is being set. The current one is only being
 * compared, so it is length checked and nothing else: answering a wrong password with a list of
 * policy violations tells whoever is guessing which guesses were never worth making.
 */
export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

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
