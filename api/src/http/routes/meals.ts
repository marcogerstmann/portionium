import {
  createMealRequestSchema,
  dayResponseSchema,
  localDateSchema,
  mealListQuerySchema,
  mealResponseSchema,
  pageSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  toWeightEntryResponse,
  updateMealRequestSchema,
  type Category,
  type ColourCounts,
  type MealItemResponse,
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
import { findExistingFoodIds } from '../../db/food.js';
import {
  findItemsForMeals,
  findMealById,
  findMealsForDay,
  insertMeal,
  listMeals,
  softDeleteMeal,
  updateMeal,
  type MealItemRecord,
  type MealRecord,
} from '../../db/meal.js';
import { findLatestWeightEntryForDay } from '../../db/weight.js';
import { resolveClassifications } from '../../domain/classification.js';
import { DomainError, ResourceNotFoundError, UnauthenticatedError } from '../../domain/errors.js';
import {
  applyMealChanges,
  createMeal,
  type MealChanges,
  type NewMeal,
  type ValidatedMealItem,
} from '../../domain/meal.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

/**
 * The primary write path: logging what somebody ate, and reading it back. Two shapes of read
 * cover it, a caller's own feed and one local day, see GET /meals and GET /days/{date} below.
 *
 * Every food an item names is resolved to its colour the same way the catalog does, through
 * resolveClassifications, so a meal and the food it references never disagree about what colour
 * that food is for the caller reading it.
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
      'The meal has no items, an item names a food id with no live catalog entry, loggedAt is ' +
      'too far in the future, or the Idempotency-Key was already used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** The 422 half of the same story, for PATCH: there is no id to conflict on, so no 409 here. */
const mealUpdateProblemResponses = {
  422: {
    description:
      'The edit would leave the meal with no items, an item names a food id with no live ' +
      'catalog entry, loggedAt is too far in the future, or the Idempotency-Key was already ' +
      'used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** One item, with the colour resolved the way a catalog entry's is. */
function toMealItemResponse(
  item: MealItemRecord,
  category: Category | undefined,
): MealItemResponse {
  return {
    id: item.id,
    foodId: item.foodId,
    ...(item.quantity === null ? {} : { quantity: item.quantity }),
    position: item.position,
    category: category ?? null,
  };
}

/**
 * `loggedAt` is converted here and only here, the one place a stored Date becomes the ISO
 * string mealResponseSchema actually accepts. See the comment beside that schema for why the
 * Date cannot make that trip through the schema itself.
 */
function toMealResponse(
  meal: MealRecord,
  items: readonly MealItemRecord[],
  resolved: ReadonlyMap<string, FoodClassificationRecord>,
): MealResponse {
  return {
    id: meal.id,
    userId: meal.userId,
    type: meal.type,
    loggedAt: meal.loggedAt.toISOString(),
    localDate: meal.localDate,
    ...(meal.notes === null ? {} : { notes: meal.notes }),
    items: items.map((item) => toMealItemResponse(item, resolved.get(item.foodId)?.category)),
  };
}

/** Items grouped by the meal they belong to, so a page of meals costs one pass over one query. */
function groupItemsByMeal(items: readonly MealItemRecord[]): Map<string, MealItemRecord[]> {
  const byMeal = new Map<string, MealItemRecord[]>();
  for (const item of items) {
    const bucket = byMeal.get(item.mealId);
    if (bucket === undefined) {
      byMeal.set(item.mealId, [item]);
    } else {
      bucket.push(item);
    }
  }

  return byMeal;
}

/** How many of these items landed in each colour, unresolved ones included. */
function countColours(
  items: readonly MealItemRecord[],
  resolved: ReadonlyMap<string, FoodClassificationRecord>,
): ColourCounts {
  const counts: ColourCounts = { green: 0, yellow: 0, orange: 0, unclassified: 0 };
  for (const item of items) {
    const category = resolved.get(item.foodId)?.category;
    counts[category ?? 'unclassified'] += 1;
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
   * Every food an item list names has to be a live catalog entry, on a create and on an edit
   * alike, so this is shared rather than repeated. Returns the ids it checked, which both
   * callers already need for resolving colours.
   */
  function requireExistingFoods(items: readonly ValidatedMealItem[]): string[] {
    const foodIds = [...new Set(items.map((item) => item.foodId))];
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

  /**
   * Two things a page or a day of meals both need: every item across them in one query, and
   * every colour those items resolve to in another, whatever the count of either turns out to
   * be. This is the whole of the performance note on GET /days/{date}.
   */
  function itemsAndColours(userId: string, mealIds: readonly string[]) {
    const items = findItemsForMeals(db, mealIds);
    const foodIds = [...new Set(items.map((item) => item.foodId))];
    const resolved = resolveClassifications(
      findClassificationsForFoods(db, foodIds, userId),
      userId,
    );

    return { items, resolved, byMeal: groupItemsByMeal(items) };
  }

  app.post(
    '/meals',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Log a meal',
        body: createMealRequestSchema,
        response: {
          201: mealResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...mealWriteConflictResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;
      const user = requireUser(userId);

      const newMeal: NewMeal = {
        userId,
        type: request.body.type,
        loggedAt: request.body.loggedAt ?? new Date(),
        ...(request.body.notes === undefined ? {} : { notes: request.body.notes }),
        items: request.body.items,
      };

      // Throws meal_has_no_items for an empty list and meal_logged_in_future for a loggedAt
      // clock skew cannot excuse, and assigns each item's position, see domain/meal.ts. Runs
      // before anything touches the database, an invalid meal is not worth a food lookup.
      const validated = createMeal(newMeal, user);
      const foodIds = requireExistingFoods(validated.items);

      const stored = insertMeal(
        db,
        { ...validated.meal, ...(request.body.id === undefined ? {} : { id: request.body.id }) },
        validated.items,
      );
      if (stored === undefined) {
        throw new DomainError('meal_id_conflict', 'A meal with this id already exists.');
      }

      const resolved = resolveClassifications(
        findClassificationsForFoods(db, foodIds, userId),
        userId,
      );

      request.log.info({ userId, mealId: stored.meal.id }, 'meal created');

      reply.code(201);
      return toMealResponse(stored.meal, stored.items, resolved);
    },
  );

  app.patch(
    '/meals/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Change a meal already logged: its type, notes, loggedAt or item list',
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
        ...(request.body.items === undefined ? {} : { items: request.body.items }),
      };

      const current: NewMeal = {
        userId: meal.userId,
        type: meal.type,
        loggedAt: meal.loggedAt,
        ...(meal.notes === null ? {} : { notes: meal.notes }),
        items: findItemsForMeals(db, [meal.id]).map((item) => ({
          foodId: item.foodId,
          ...(item.quantity === null ? {} : { quantity: item.quantity }),
        })),
      };

      // Merges the edit into the meal as it stands, then runs the same invariants a create
      // gets: no empty item list, no loggedAt further into the future than clock skew excuses.
      // A changed loggedAt lands on a freshly derived localDate, which is what can move the
      // meal to a different day, and the response below reports it: there is nothing cached
      // anywhere else that a read of this meal, or of the day it now belongs to, has to catch
      // up with, every aggregate is computed at read time from this row.
      const validated = applyMealChanges(current, changes, user);
      const foodIds = requireExistingFoods(validated.items);

      const updated = updateMeal(db, userId, meal.id, validated.meal, validated.items);
      if (updated === undefined) {
        throw new ResourceNotFoundError();
      }

      const resolved = resolveClassifications(
        findClassificationsForFoods(db, foodIds, userId),
        userId,
      );

      request.log.info(
        { userId, mealId: meal.id, fields: Object.keys(request.body) },
        'meal updated',
      );

      return toMealResponse(updated.meal, updated.items, resolved);
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

      const { resolved, byMeal } = itemsAndColours(
        userId,
        meals.map((meal) => meal.id),
      );

      return {
        items: meals.map((meal) => toMealResponse(meal, byMeal.get(meal.id) ?? [], resolved)),
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

      // Four queries whatever the day contains: the meals, their items in one go, the
      // classifications those items resolve to in one more, and the weight reading. A day with
      // twenty items costs the same round trip as a day with two, which is the point.
      const meals = findMealsForDay(db, userId, date);
      const { items, resolved, byMeal } = itemsAndColours(
        userId,
        meals.map((meal) => meal.id),
      );
      const weightEntry = findLatestWeightEntryForDay(db, userId, date);

      return {
        date,
        meals: meals.map((meal) => toMealResponse(meal, byMeal.get(meal.id) ?? [], resolved)),
        weightEntry: weightEntry === undefined ? null : toWeightEntryResponse(weightEntry),
        colourCounts: countColours(items, resolved),
      };
    },
  );

  done();
};
