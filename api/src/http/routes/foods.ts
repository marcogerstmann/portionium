import {
  createFoodRequestSchema,
  foodClassificationResponseSchema,
  foodDetailResponseSchema,
  foodListQuerySchema,
  foodResponseSchema,
  pageSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  updateFoodRequestSchema,
  type FoodClassificationResponse,
  type FoodResponse,
  type Scope,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  findClassificationHistory,
  findClassificationsForFoods,
  type FoodClassificationRecord,
} from '../../db/classification.js';
import type { Db } from '../../db/client.js';
import {
  countMealsUsingFood,
  findFoodById,
  findFoodByName,
  insertFood,
  listFoods,
  softDeleteFood,
  updateFood,
  type FoodRecord,
} from '../../db/food.js';
import { resolveClassification, resolveClassifications } from '../../domain/classification.js';
import {
  FoodInUseError,
  InsufficientScopeError,
  ResourceNotFoundError,
} from '../../domain/errors.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

/**
 * The shared catalog. One table for ingredients, dishes and branded products, and one entry per
 * food for the whole instance, see docs/adr/006-single-foods-table.md.
 *
 * Two properties run through the five catalog endpoints:
 *
 *   Nothing here answers with a raw category. Every food that leaves this file has been through
 *   resolveClassification for the caller, so two people in one household reading the same entry
 *   get their own answer and neither can see the other's opinion.
 *
 *   Nothing here writes a category either. A colour is a verdict with a source and an author,
 *   so it is a row in food_classification written by the classification endpoint, and there is
 *   no field on a create or an update that could carry one.
 *
 * The history endpoint is the log itself, unresolved. Everything else in this file answers with
 * the one verdict that won; that one answers with all of them, which is only a question worth
 * asking because nothing in this application ever overwrites one. See
 * docs/adr/007-append-only-classification-log.md.
 */

export interface FoodRouteOptions {
  db: Db;
}

const idParamsSchema = z.strictObject({ id: z.uuidv7() });

const notFoundResponse = {
  404: {
    description: 'No such food, or it has been deleted',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/**
 * Spread after the idempotency responses on the delete, which already declares a 409 of its
 * own. One status, two reasons, so the description covers both rather than one of them
 * silently replacing the other in the generated document.
 */
const inUseResponse = {
  409: {
    description:
      'The food is used by a meal, or the first request carrying this Idempotency-Key has not finished',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const noContentResponse = { 204: z.null().describe('Deleted') } as const;

/**
 * The fields are listed rather than spread, the same rule toUserResponse follows. A row carries
 * columns the wire has no business seeing, today `deletedAt` and the timestamps, and a response
 * that is correct because a schema happens to strip them is one that stops being correct the
 * day somebody reaches for a looser schema.
 *
 * Nullable columns become absent properties rather than nulls, because that is what the entity
 * schema says a food looks like. `category` is the exception and is null on purpose: a food
 * nobody has judged yet is a state the client renders, not a field it has to feel around for.
 */
function toFoodResponse(
  food: FoodRecord,
  classification: FoodClassificationRecord | undefined,
): FoodResponse {
  return {
    id: food.id,
    name: food.name,
    kind: food.kind,
    ...(food.energyDensity === null ? {} : { energyDensity: food.energyDensity }),
    ...(food.createdBy === null ? {} : { createdBy: food.createdBy }),
    category: classification?.category ?? null,
  };
}

/** Why the colour is what it is. `foodId` is the URL and `userId` is either nobody or you. */
function toClassificationResponse(row: FoodClassificationRecord): FoodClassificationResponse {
  return {
    id: row.id,
    category: row.category,
    source: row.source,
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.promptVersion === null ? {} : { promptVersion: row.promptVersion }),
    ...(row.confidence === null ? {} : { confidence: row.confidence }),
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
    ...(row.assumptions === null ? {} : { assumptions: row.assumptions }),
    createdAt: row.createdAt.toISOString(),
  };
}

export const foodRoutes: FastifyPluginCallbackZod<FoodRouteOptions> = (app, options, done) => {
  const { db } = options;

  /** One food's winning verdict, for the endpoints that deal in one food at a time. */
  function classificationFor(
    food: FoodRecord,
    userId: string,
  ): FoodClassificationRecord | undefined {
    return resolveClassification(findClassificationsForFoods(db, [food.id], userId), userId);
  }

  /** The row, or the one answer a missing and a deleted food both get. */
  function requireFood(id: string): FoodRecord {
    const food = findFoodById(db, id);
    if (food === undefined) {
      throw new ResourceNotFoundError();
    }

    return food;
  }

  /**
   * Who may change an entry: whoever added it, or an administrator.
   *
   * One function for both writes rather than a check on each, because the two would drift and
   * the direction they drift in is predictable. A rename is not a smaller act than a delete on
   * a shared catalog: an entry renamed out from under somebody is gone from their search and
   * mislabelled in their history, and it takes their meals with it. Gating the delete and
   * leaving the rename open would be a door with a lock beside an open window.
   *
   * A seeded entry has no author, so it is nobody's and only an administrator touches it.
   *
   * A 403 rather than a 404, and it leaks nothing: the catalog is readable by every account, so
   * the id in this URL was never a secret. See ADR 003 for the case where the distinction does
   * matter, which is a row that belongs to one person.
   */
  function requireAuthorOrAdmin(food: FoodRecord, userId: string, scopes: readonly Scope[]): void {
    if (food.createdBy !== userId && !scopes.includes('admin')) {
      throw new InsufficientScopeError();
    }
  }

  app.get(
    '/foods',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Browse the catalog, with the colour resolved for the caller',
        querystring: foodListQuerySchema,
        response: {
          200: pageSchema(foodResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { limit, cursor, kind, unclassified } = request.query;

      // One row more than asked for, which is how the last page is told apart from a full one
      // without a second count query that would be wrong by the time it answered.
      const page = listFoods(db, { userId, limit: limit + 1, cursor, kind, unclassified });
      const items = page.slice(0, limit);

      // Two queries for a page of fifty, not fifty one. The ids are known by now, so every
      // verdict the caller may see comes back in one go and is resolved in memory.
      const resolved = resolveClassifications(
        findClassificationsForFoods(
          db,
          items.map((food) => food.id),
          userId,
        ),
        userId,
      );

      return {
        items: items.map((food) => toFoodResponse(food, resolved.get(food.id))),
        nextCursor: page.length > limit ? (items.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.post(
    '/foods',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Add an entry to the catalog, or get back the one that already means this',
        body: createFoodRequestSchema,
        response: {
          200: foodResponseSchema.describe('An entry with this name already existed'),
          201: foodResponseSchema.describe('Created'),
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;

      // A shared catalog fills up with near duplicates otherwise: everybody adds a food while
      // halfway through logging a meal, and "Skyr", "skyr" and "Skyr " are one food that three
      // people typed. Matching is case insensitive and whitespace normalised, see
      // normalizeFoodName. The existing entry comes back rather than a 409, because the caller
      // asked for a food to point a meal at and there is one.
      const existing = findFoodByName(db, request.body.name);
      const food =
        existing ??
        insertFood(db, {
          name: request.body.name,
          kind: request.body.kind,
          ...(request.body.energyDensity === undefined
            ? {}
            : { energyDensity: request.body.energyDensity }),
          createdBy: userId,
        });

      if (existing === undefined) {
        request.log.info({ userId, foodId: food.id, name: food.name }, 'food created');
      }

      // 200 rather than 201 for the match, so a client can tell that its entry is not the one
      // that got made. Both carry the same body, because both answer the same question.
      reply.code(existing === undefined ? 201 : 200);
      return toFoodResponse(food, classificationFor(food, userId));
    },
  );

  app.get(
    '/foods/:id',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'One entry, with the provenance of its colour',
        params: idParamsSchema,
        response: {
          200: foodDetailResponseSchema,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const food = requireFood(request.params.id);
      const classification = classificationFor(food, userId);

      return {
        ...toFoodResponse(food, classification),
        // Which verdict won and where it came from. The rest of the chain is the
        // classification history endpoint's business, not this one's.
        classification:
          classification === undefined ? null : toClassificationResponse(classification),
      };
    },
  );

  app.get(
    '/foods/:id/classification/history',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Every verdict this caller may see about one food, newest first',
        params: idParamsSchema,
        response: {
          200: z.array(foodClassificationResponseSchema),
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const food = requireFood(request.params.id);

      // Not paged, unlike the catalog. This is one food's chain: the seeded verdict, whatever
      // the model said, and the handful of times its owner changed their mind, which is a list
      // that is read in full or not at all. The same reasoning as the session and token lists.
      //
      // The other household member's opinions are not in here and are not omitted from a page
      // either, they never leave the database. See findClassificationHistory.
      return findClassificationHistory(db, food.id, userId).map(toClassificationResponse);
    },
  );

  app.patch(
    '/foods/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Correct the name or the kind of an entry',
        params: idParamsSchema,
        body: updateFoodRequestSchema,
        response: {
          200: foodResponseSchema,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId, scopes } = request.auth;

      requireAuthorOrAdmin(requireFood(request.params.id), userId, scopes);

      const updated = updateFood(db, request.params.id, request.body);
      if (updated === undefined) {
        throw new ResourceNotFoundError();
      }

      request.log.info(
        { userId, foodId: updated.id, fields: Object.keys(request.body) },
        'food updated',
      );

      return toFoodResponse(updated, classificationFor(updated, userId));
    },
  );

  app.delete(
    '/foods/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Remove an entry nobody has eaten',
        params: idParamsSchema,
        response: {
          ...noContentResponse,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...inUseResponse,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId, scopes } = request.auth;
      const food = requireFood(request.params.id);

      requireAuthorOrAdmin(food, userId, scopes);

      // The soft delete would leave the meal_item rows pointing at something no read path
      // returns, so a history that was right when it was written would grow holes. Renaming is
      // the way out, which is why PATCH does not ask this question.
      if (countMealsUsingFood(db, food.id) > 0) {
        throw new FoodInUseError();
      }

      // Already deleted counts as nothing to do, so deleting twice is a 404 rather than a
      // second success.
      if (!softDeleteFood(db, food.id)) {
        throw new ResourceNotFoundError();
      }

      request.log.info({ userId, foodId: food.id }, 'food deleted');

      reply.code(204).send(null);
    },
  );

  done();
};
