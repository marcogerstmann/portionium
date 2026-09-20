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
  type EntryInput,
  type EntryResponse,
  type MealCompositionEntryResponse,
  type MealResponse,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { findUserById, weeklyBudgetsOf, type UserRecord } from '../../db/auth.js';
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
  findEntriesForDateRange,
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
import { computeBudgetStatus } from '../../domain/budget.js';
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
import { countColours } from '../../domain/stats.js';
import { isoWeekOf } from '../../domain/weekly-summary.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';
import { toFoodResponse } from './foods.js';

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

const mealUpdateProblemResponses = {
  422: {
    description:
      'The edit would leave the meal with no entries, an entry names a food id with no live ' +
      'catalog entry, loggedAt is too far in the future, or the Idempotency-Key was already ' +
      'used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const favouriteWriteProblemResponses = {
  422: {
    description:
      'The favourite has no entries, an entry names a food id with no live catalog entry, or ' +
      'the Idempotency-Key was already used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

function toEntryResponse(entry: EntryRecord): EntryResponse {
  return {
    id: entry.id,
    foodId: entry.foodId,
    category: entry.category,
    ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
    position: entry.position,
  };
}

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

export const mealRoutes: FastifyPluginCallbackZod<MealRouteOptions> = (app, options, done) => {
  const { db } = options;

  function requireUser(userId: string): UserRecord {
    const user = findUserById(db, userId);
    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    return user;
  }

  function requireMeal(userId: string, id: string): MealRecord {
    const meal = findMealById(db, userId, id);
    if (meal === undefined) {
      throw new ResourceNotFoundError();
    }

    return meal;
  }

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

  function coloursFor(userId: string, foodIds: readonly string[]) {
    return resolveClassifications(findClassificationsForFoods(db, foodIds, userId), userId);
  }

  function namesFor(foodIds: readonly string[]): Map<string, string> {
    return new Map(findFoodsByIds(db, foodIds).map((food) => [food.id, food.name]));
  }

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

      requireExistingFoods(inputs);
      const entries = stampEntries(userId, inputs);

      const newMeal: NewMeal = {
        userId,
        type: request.body.type,
        loggedAt: request.body.loggedAt ?? new Date(),
        ...(request.body.notes === undefined ? {} : { notes: request.body.notes }),
        entries,
      };

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
        entries: findEntriesForMeals(db, [meal.id]).map((entry) => ({
          foodId: entry.foodId,
          category: entry.category,
          ...(entry.quantity === null ? {} : { quantity: entry.quantity }),
        })),
      };

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

      const meals = findMealsForDay(db, userId, date);
      const { entries, byMeal } = entriesForMeals(meals.map((meal) => meal.id));
      const foodIds = entries.flatMap((entry) => (entry.foodId === null ? [] : [entry.foodId]));
      const foods = findFoodsByIds(db, foodIds);
      const resolved = coloursFor(userId, foodIds);
      const weightEntry = findLatestWeightEntryForDay(db, userId, date);

      const week = isoWeekOf(date);
      const weekEntries = findEntriesForDateRange(db, userId, week.startDate, week.endDate);
      const budget = computeBudgetStatus(weekEntries, weeklyBudgetsOf(requireUser(userId)));

      return {
        date,
        meals: meals.map((meal) => toMealResponse(meal, byMeal.get(meal.id) ?? [])),
        weightEntry: weightEntry === undefined ? null : toWeightEntryResponse(weightEntry),
        colourCounts: countColours(entries),
        foods: foods.map((food) => toFoodResponse(food, resolved.get(food.id))),
        budget,
      };
    },
  );

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
