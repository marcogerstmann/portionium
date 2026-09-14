import {
  createFavouriteRequestSchema,
  createMealRequestSchema,
  dayResponseSchema,
  favouriteListQuerySchema,
  favouriteResponseSchema,
  localDateSchema,
  mealListQuerySchema,
  mealResponseSchema,
  mealSuggestionResponseSchema,
  mealSuggestionsQuerySchema,
  pageSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  toWeightEntryResponse,
  updateMealRequestSchema,
  type Category,
  type ColourCounts,
  type EntryInput,
  type EntryResponse,
  type MealCompositionEntryResponse,
  type MealResponse,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { findUserById, type UserRecord } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import {
  findClassificationsForFoods,
  type FoodClassificationRecord,
} from '../../db/classification.js';
import { findExistingFoodIds, findFoodsByIds } from '../../db/food.js';
import {
  insertMealFavourite,
  listMealFavourites,
  softDeleteMealFavourite,
  type MealFavouriteRecord,
} from '../../db/meal-favourite.js';
import {
  findEntriesForMeals,
  findMealById,
  findMealsForDay,
  insertMeal,
  listMeals,
  softDeleteMeal,
  updateMeal,
  type EntryRecord,
  type MealRecord,
} from '../../db/meal.js';
import { findLatestWeightEntryForDay } from '../../db/weight.js';
import { resolveClassifications } from '../../domain/classification.js';
import { DomainError, ResourceNotFoundError, UnauthenticatedError } from '../../domain/errors.js';
import {
  applyMealChanges,
  createMeal,
  validateFavouriteEntries,
  type MealChanges,
  type NewEntry,
  type NewMeal,
} from '../../domain/meal.js';
import { rankMealSuggestions, type SuggestionHistoryMeal } from '../../domain/meal-suggestions.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';
import { toFoodResponse } from './foods.js';

/**
 * The primary write path: logging what somebody ate, and reading it back. Two shapes of read
 * cover it, a caller's own feed and one local day, see GET /meals and GET /days/{date} below.
 *
 * This is the one place on the meal path where a colour is resolved, and it happens on the way
 * in rather than on the way out: POST and PATCH stamp each entry with the colour its food has
 * for this caller at that moment, and every read here then answers with the column. Recolouring
 * a food afterwards changes what logging it again would give you and leaves every day it was
 * already eaten on exactly as it was, see docs/adr/011-an-entry-is-a-colour.md.
 *
 * The one read that still resolves is the `foods` list on GET /days/{date}, which is about the
 * catalog rather than about history: it is what a client shows in a search box, so it carries
 * each food's current colour. An entry's colour and its food's can therefore differ on one
 * response, and the entry's is the one a client renders.
 */

export interface MealRouteOptions {
  db: Db;
}

const dayParamsSchema = z.strictObject({ date: localDateSchema });
const idParamsSchema = z.strictObject({ id: z.uuidv7() });

const notFoundResponse = {
  404: {
    description: 'No such meal, or it has been deleted, or it belongs to somebody else',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const noContentResponse = { 204: z.null().describe('Deleted') } as const;

/**
 * Spread after the idempotency responses, which already declare a 409 and a 422 of their own.
 * One status, more than one reason, so the description says both rather than one silently
 * replacing the other in the generated document. See inUseResponse in foods.ts for the same
 * pattern.
 */
const mealWriteConflictResponses = {
  409: {
    description:
      'A meal with this id already exists, or the first request carrying this ' +
      'Idempotency-Key has not finished',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  422: {
    description:
      'The meal has no entries, an entry names a food id with no live catalog entry, loggedAt ' +
      'is too far in the future, fromMealId was supplied together with entries, or the ' +
      'Idempotency-Key was already used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** The 422 half of the same story, for PATCH: there is no id to conflict on, so no 409 here. */
const mealUpdateProblemResponses = {
  422: {
    description:
      'The edit would leave the meal with no entries, an entry names a food id with no live ' +
      'catalog entry, loggedAt is too far in the future, or the Idempotency-Key was already ' +
      'used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** The 422 half of pinning a favourite: no id involved, so no 409 the way a meal create has. */
const favouriteWriteProblemResponses = {
  422: {
    description:
      'The favourite has no entries, an entry names a food id with no live catalog entry, or ' +
      'the Idempotency-Key was already used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** One entry, carrying the colour it was logged with rather than one resolved for this request. */
function toEntryResponse(entry: EntryRecord): EntryResponse {
  return {
    id: entry.id,
    foodId: entry.foodId,
    category: entry.category,
    ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
    position: entry.position,
  };
}

/**
 * `loggedAt` is converted here and only here, the one place a stored Date becomes the ISO
 * string mealResponseSchema actually accepts. See the comment beside that schema for why the
 * Date cannot make that trip through the schema itself.
 */
function toMealResponse(meal: MealRecord, entries: readonly EntryRecord[]): MealResponse {
  return {
    id: meal.id,
    userId: meal.userId,
    type: meal.type,
    loggedAt: meal.loggedAt.toISOString(),
    localDate: meal.localDate,
    ...(meal.notes === null ? {} : { notes: meal.notes }),
    entries: entries.map(toEntryResponse),
  };
}

/** Entries grouped by the meal they belong to, so a page of meals costs one pass over one query. */
function groupEntriesByMeal(entries: readonly EntryRecord[]): Map<string, EntryRecord[]> {
  const byMeal = new Map<string, EntryRecord[]>();
  for (const entry of entries) {
    const bucket = byMeal.get(entry.mealId);
    if (bucket === undefined) {
      byMeal.set(entry.mealId, [entry]);
    } else {
      bucket.push(entry);
    }
  }

  return byMeal;
}

/**
 * One entry of a suggestion or a favourite. A composition is a preset rather than history, so
 * unlike a logged entry this resolves: it answers what logging this again would give the caller
 * now. A bare colour names no food and simply keeps the colour it was pinned with, and has no
 * name to carry either.
 */
function toCompositionEntryResponse(
  entry: {
    foodId?: string | undefined;
    category?: Category | null | undefined;
    quantity?: number | undefined;
  },
  resolved: ReadonlyMap<string, FoodClassificationRecord>,
  names: ReadonlyMap<string, string>,
): MealCompositionEntryResponse {
  return {
    ...(entry.foodId === undefined
      ? {}
      : { foodId: entry.foodId, foodName: names.get(entry.foodId) }),
    ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
    category:
      entry.foodId === undefined
        ? (entry.category ?? null)
        : (resolved.get(entry.foodId)?.category ?? null),
  };
}

/** A favourite on its way out, with every entry's colour and food name resolved for the caller. */
function toFavouriteResponse(
  favourite: MealFavouriteRecord,
  resolved: ReadonlyMap<string, FoodClassificationRecord>,
  names: ReadonlyMap<string, string>,
) {
  return {
    id: favourite.id,
    name: favourite.name,
    type: favourite.type,
    entries: favourite.entries.map((entry) => toCompositionEntryResponse(entry, resolved, names)),
  };
}

/** How many of these entries landed in each colour, the ones still waiting for one included. */
function countColours(entries: readonly EntryRecord[]): ColourCounts {
  const counts: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };
  for (const entry of entries) {
    counts[entry.category ?? 'unclassified'] += 1;
  }

  return counts;
}

export const mealRoutes: FastifyPluginCallbackZod<MealRouteOptions> = (app, options, done) => {
  const { db } = options;

  /**
   * The row behind request.auth, the same reasoning as me.ts's currentUser: the auth hook
   * resolved this account a moment ago, so the only way it is gone now is a delete that landed
   * in between, which is the same "no longer resolves to anybody" the next request would get.
   */
  function requireUser(userId: string): UserRecord {
    const user = findUserById(db, userId);
    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    return user;
  }

  /** The row, or the one answer a missing, deleted, or foreign meal all get. See requireFood. */
  function requireMeal(userId: string, id: string): MealRecord {
    const meal = findMealById(db, userId, id);
    if (meal === undefined) {
      throw new ResourceNotFoundError();
    }

    return meal;
  }

  /**
   * Every food an entry list names has to be a live catalog entry: on a meal create, a meal
   * edit, and a favourite pin alike, so this is shared rather than repeated three times. Takes
   * anything with an optional `foodId`, which covers a favourite's entries and a bare colour,
   * whose absent food is nothing to check. Returns the ids it checked, which every caller
   * already needs for resolving colours.
   */
  function requireExistingFoods(entries: readonly { foodId?: string | undefined }[]): string[] {
    const foodIds = [
      ...new Set(entries.flatMap((entry) => (entry.foodId === undefined ? [] : [entry.foodId]))),
    ];
    const existingFoodIds = findExistingFoodIds(db, foodIds);
    const missingFoodIds = foodIds.filter((id) => !existingFoodIds.has(id));
    if (missingFoodIds.length > 0) {
      throw new DomainError(
        'unknown_food_reference',
        `Unknown food id${missingFoodIds.length > 1 ? 's' : ''}: ${missingFoodIds.join(', ')}.`,
      );
    }

    return foodIds;
  }

  /** The colours these foods have for this caller right now, in one query however many there are. */
  function coloursFor(userId: string, foodIds: readonly string[]) {
    return resolveClassifications(findClassificationsForFoods(db, foodIds, userId), userId);
  }

  /**
   * The names these foods carry right now, one query for a whole page. A composition renders
   * from this map alone, the same reasoning GET /days/{date} already applies to its `foods` list.
   */
  function namesFor(foodIds: readonly string[]): Map<string, string> {
    return new Map(findFoodsByIds(db, foodIds).map((food) => [food.id, food.name]));
  }

  /**
   * Stamps the colour on the way in, which is the whole of this story: an entry that named a
   * food and said nothing about its colour takes the one that food resolves to for this caller
   * at this moment, and one that named a colour keeps it, food or no food.
   *
   * Null is a real answer and not a failure: a food nobody has judged yet gives a waiting entry,
   * which a later `user` verdict fills in, see insertClassifications in db/classification.ts.
   */
  function stampEntries(userId: string, entries: readonly EntryInput[]): NewEntry[] {
    const resolved = coloursFor(
      userId,
      entries.flatMap((entry) => (entry.foodId === undefined ? [] : [entry.foodId])),
    );

    return entries.map((entry) => ({
      foodId: entry.foodId ?? null,
      category:
        entry.category ??
        (entry.foodId === undefined ? null : (resolved.get(entry.foodId)?.category ?? null)),
      ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
    }));
  }

  /**
   * Every entry across a page or a day of meals, in one query rather than one per meal, grouped
   * by the meal it belongs to. This is the whole of the performance note on GET /days/{date},
   * and it is one query rather than the two it used to be: the colour is on the row.
   */
  function entriesForMeals(mealIds: readonly string[]) {
    const entries = findEntriesForMeals(db, mealIds);

    return { entries, byMeal: groupEntriesByMeal(entries) };
  }

  app.post(
    '/meals',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Log a meal, or repeat one already logged by naming it as fromMealId',
        body: createMealRequestSchema,
        response: {
          201: mealResponseSchema,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...mealWriteConflictResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;
      const user = requireUser(userId);

      if (request.body.fromMealId !== undefined && request.body.entries !== undefined) {
        throw new DomainError(
          'meal_from_id_with_entries',
          'Provide entries or fromMealId, not both.',
        );
      }

      // Absent entries and absent fromMealId both mean "nothing supplied", which falls through
      // to createMeal's own meal_has_no_entries check below rather than needing one here too.
      //
      // Repeating a meal is an ordinary write and not a copy of what was stored: an entry that
      // named a food is handed on as that food alone, so it takes the colour that food has now,
      // and a bare colour carries its own because it has nothing else to be. See the note on
      // `fromMealId` in createMealRequestSchema.
      const inputs: EntryInput[] =
        request.body.fromMealId === undefined
          ? (request.body.entries ?? [])
          : findEntriesForMeals(db, [requireMeal(userId, request.body.fromMealId).id]).map(
              (entry) => ({
                ...(entry.foodId === null
                  ? { category: entry.category ?? undefined }
                  : { foodId: entry.foodId }),
                ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
              }),
            );

      // Both of these read the database, so unlike before they run ahead of createMeal's own
      // checks rather than behind them: an entry cannot be stamped against a food that is not
      // there, and there is nothing to stamp for the empty list that is the only invalid meal
      // reaching this far, since both reads answer an empty input without a query.
      requireExistingFoods(inputs);
      const entries = stampEntries(userId, inputs);

      const newMeal: NewMeal = {
        userId,
        type: request.body.type,
        loggedAt: request.body.loggedAt ?? new Date(),
        ...(request.body.notes === undefined ? {} : { notes: request.body.notes }),
        entries,
      };

      // Throws meal_has_no_entries for an empty list and meal_logged_in_future for a loggedAt
      // clock skew cannot excuse, and assigns each entry's position, see domain/meal.ts.
      const validated = createMeal(newMeal, user);

      const stored = insertMeal(
        db,
        { ...validated.meal, ...(request.body.id === undefined ? {} : { id: request.body.id }) },
        validated.entries,
      );
      if (stored === undefined) {
        throw new DomainError('meal_id_conflict', 'A meal with this id already exists.');
      }

      request.log.info({ userId, mealId: stored.meal.id }, 'meal created');

      reply.code(201);
      return toMealResponse(stored.meal, stored.entries);
    },
  );

  app.patch(
    '/meals/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Change a meal already logged: its type, notes, loggedAt or entry list',
        params: idParamsSchema,
        body: updateMealRequestSchema,
        response: {
          200: mealResponseSchema,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...mealUpdateProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const user = requireUser(userId);
      const meal = requireMeal(userId, request.params.id);

      // A sent entry list is a new write and is stamped afresh, the same as a create's, so an
      // entry that named a food takes that food's colour as it stands now. An absent one is
      // not touched at all, see `current` below.
      const changes: MealChanges = {
        ...(request.body.type === undefined ? {} : { type: request.body.type }),
        ...(request.body.loggedAt === undefined ? {} : { loggedAt: request.body.loggedAt }),
        ...(request.body.notes === undefined ? {} : { notes: request.body.notes }),
      };
      if (request.body.entries !== undefined) {
        requireExistingFoods(request.body.entries);
        changes.entries = stampEntries(userId, request.body.entries);
      }

      const current: NewMeal = {
        userId: meal.userId,
        type: meal.type,
        loggedAt: meal.loggedAt,
        ...(meal.notes === null ? {} : { notes: meal.notes }),
        // The rows as they stand, colours included. An edit that names no entry list leaves
        // these exactly as they were logged rather than restamping them, which is the whole
        // point of a stamped colour: changing a meal's notes is not a reason to re-judge what
        // was in it.
        entries: findEntriesForMeals(db, [meal.id]).map((entry) => ({
          foodId: entry.foodId,
          category: entry.category,
          ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
        })),
      };

      // Merges the edit into the meal as it stands, then runs the same invariants a create
      // gets: no empty entry list, no loggedAt further into the future than clock skew excuses.
      // A changed loggedAt lands on a freshly derived localDate, which is what can move the
      // meal to a different day, and the response below reports it: there is nothing cached
      // anywhere else that a read of this meal, or of the day it now belongs to, has to catch
      // up with, every aggregate is computed at read time from this row.
      const validated = applyMealChanges(current, changes, user);

      const updated = updateMeal(db, userId, meal.id, validated.meal, validated.entries);
      if (updated === undefined) {
        throw new ResourceNotFoundError();
      }

      request.log.info(
        { userId, mealId: meal.id, fields: Object.keys(request.body) },
        'meal updated',
      );

      return toMealResponse(updated.meal, updated.entries);
    },
  );

  app.delete(
    '/meals/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Soft delete a meal. Recreating it with the same id undoes it, see POST /meals',
        params: idParamsSchema,
        response: {
          ...noContentResponse,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;
      requireMeal(userId, request.params.id);

      // Already deleted counts as nothing to do, so deleting twice is a 404 rather than a
      // second success, the same rule softDeleteFood follows.
      if (!softDeleteMeal(db, userId, request.params.id)) {
        throw new ResourceNotFoundError();
      }

      request.log.info({ userId, mealId: request.params.id }, 'meal deleted');

      reply.code(204).send(null);
    },
  );

  app.get(
    '/meals',
    {
      config: { auth: 'read' },
      schema: {
        summary: "Browse the caller's own meals, newest first",
        querystring: mealListQuerySchema,
        response: {
          200: pageSchema(mealResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { limit, cursor, type, from, to } = request.query;

      // One row more than asked for, the same trick listFoods uses to tell the last page from a
      // full one without a second count query that would be stale by the time it answered.
      const page = listMeals(db, { userId, limit: limit + 1, cursor, type, from, to });
      const meals = page.slice(0, limit);

      const { byMeal } = entriesForMeals(meals.map((meal) => meal.id));

      return {
        items: meals.map((meal) => toMealResponse(meal, byMeal.get(meal.id) ?? [])),
        nextCursor: page.length > limit ? (meals.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.get(
    '/days/:date',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Everything for one local day: meals, weight, and colour counts',
        params: dayParamsSchema,
        response: {
          200: dayResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { date } = request.params;

      // Five queries whatever the day contains: the meals, their entries in one go, the foods
      // those entries name in one more, the current colours of those foods in one more, and the
      // weight reading. A day with twenty entries costs the same round trip as a day with two,
      // which is the point.
      const meals = findMealsForDay(db, userId, date);
      const { entries, byMeal } = entriesForMeals(meals.map((meal) => meal.id));
      const foodIds = entries.flatMap((entry) => (entry.foodId === null ? [] : [entry.foodId]));
      const foods = findFoodsByIds(db, foodIds);
      const resolved = coloursFor(userId, foodIds);
      const weightEntry = findLatestWeightEntryForDay(db, userId, date);

      return {
        date,
        meals: meals.map((meal) => toMealResponse(meal, byMeal.get(meal.id) ?? [])),
        weightEntry: weightEntry === undefined ? null : toWeightEntryResponse(weightEntry),
        colourCounts: countColours(entries),
        // The one resolved read left on this path, and it is about the catalog rather than about
        // the day: this is what a client shows in a search box, so it carries each food's colour
        // as it stands now. An entry logged before somebody recoloured its food keeps the colour
        // it was logged with, so the two can differ here, and the entry's is the one to render.
        foods: foods.map((food) => toFoodResponse(food, resolved.get(food.id))),
      };
    },
  );

  /**
   * How many of a caller's own meals of one type are read to rank suggestions. A composition's
   * weight in domain/meal-suggestions.ts halves every fourteen days, so anything beyond a few
   * months of history is worth a fraction of a percent of the newest occurrence either way.
   *
   * ponytail: a flat cap, newest first, rather than a window on loggedAt. It can in principle
   * miss an old occurrence of a composition that would have nudged its score, which nudges
   * nothing anybody would notice at this weight. If suggestions ever look wrong for an account
   * with an unusually large history, the fix is a `from` bound derived from the half life, not a
   * bigger cap.
   */
  const SUGGESTION_HISTORY_LIMIT = 200;

  app.get(
    '/meals/suggestions',
    {
      config: { auth: 'read' },
      schema: {
        summary:
          "The caller's most frequent compositions for one meal type, ranked by frequency " +
          'with a recency weighting',
        querystring: mealSuggestionsQuerySchema,
        response: {
          200: z.array(mealSuggestionResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { type, limit } = request.query;

      // No history is not an error, see rankMealSuggestions: an empty page falls straight out
      // of an empty history rather than needing a check here.
      const history = listMeals(db, { userId, type, limit: SUGGESTION_HISTORY_LIMIT });
      const { entries, byMeal } = entriesForMeals(history.map((meal) => meal.id));

      const historyMeals: SuggestionHistoryMeal[] = history.map((meal) => ({
        id: meal.id,
        loggedAt: meal.loggedAt,
        entries: (byMeal.get(meal.id) ?? []).map((entry) => ({
          foodId: entry.foodId ?? undefined,
          category: entry.category,
          ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
        })),
      }));

      // A suggestion is a preset, so its colours are the ones logging it again would give,
      // resolved now, rather than the ones the meal it came from was logged with.
      const foodIds = entries.flatMap((entry) => (entry.foodId === null ? [] : [entry.foodId]));
      const resolved = coloursFor(userId, foodIds);
      const names = namesFor(foodIds);

      return rankMealSuggestions(historyMeals, limit).map((suggestion) => ({
        mealId: suggestion.mealId,
        entries: suggestion.entries.map((entry) =>
          toCompositionEntryResponse(entry, resolved, names),
        ),
      }));
    },
  );

  app.post(
    '/meals/favourites',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Pin a meal composition as a named favourite, private to the caller',
        body: createFavouriteRequestSchema,
        response: {
          201: favouriteResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...favouriteWriteProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;

      // Throws favourite_has_no_entries for an empty list, the one invariant a favourite is
      // held to, see domain/meal.ts. Runs before the food lookup, the same ordering a create
      // uses: an invalid favourite is not worth a query.
      validateFavouriteEntries(request.body.entries);
      const foodIds = requireExistingFoods(request.body.entries);

      const stored = insertMealFavourite(db, {
        userId,
        name: request.body.name,
        type: request.body.type,
        entries: request.body.entries,
      });

      const resolved = coloursFor(userId, foodIds);
      const names = namesFor(foodIds);

      request.log.info({ userId, favouriteId: stored.id }, 'favourite created');

      reply.code(201);
      return toFavouriteResponse(stored, resolved, names);
    },
  );

  app.get(
    '/meals/favourites',
    {
      config: { auth: 'read' },
      schema: {
        summary: "Browse the caller's own favourites, newest first",
        querystring: favouriteListQuerySchema,
        response: {
          200: pageSchema(favouriteResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { limit, cursor, type } = request.query;

      const page = listMealFavourites(db, { userId, limit: limit + 1, cursor, type });
      const favourites = page.slice(0, limit);

      const foodIds = favourites.flatMap((favourite) =>
        favourite.entries.flatMap((entry) => (entry.foodId === undefined ? [] : [entry.foodId])),
      );
      const resolved = coloursFor(userId, foodIds);
      const names = namesFor(foodIds);

      return {
        items: favourites.map((favourite) => toFavouriteResponse(favourite, resolved, names)),
        nextCursor: page.length > limit ? (favourites.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.delete(
    '/meals/favourites/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Remove a pinned favourite',
        params: idParamsSchema,
        response: {
          ...noContentResponse,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;

      if (!softDeleteMealFavourite(db, userId, request.params.id)) {
        throw new ResourceNotFoundError();
      }

      request.log.info({ userId, favouriteId: request.params.id }, 'favourite deleted');

      reply.code(204).send(null);
    },
  );

  done();
};
