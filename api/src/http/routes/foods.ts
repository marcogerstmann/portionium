import {
  bulkClassifyRequestSchema,
  bulkClassifyResponseSchema,
  classifyFoodRequestSchema,
  classifyFoodResponseSchema,
  createClassificationRequestSchema,
  createFoodRequestSchema,
  foodClassificationResponseSchema,
  foodDetailResponseSchema,
  foodListQuerySchema,
  foodResponseSchema,
  foodSearchQuerySchema,
  pageSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  unclassifiedCountQuerySchema,
  unclassifiedCountResponseSchema,
  unclassifiedFoodResponseSchema,
  unclassifiedFoodsQuerySchema,
  updateFoodRequestSchema,
  type FoodClassificationResponse,
  type FoodResponse,
  type Scope,
  type UnclassifiedFoodResponse,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { withdrawClassification } from '../../db/classification-withdrawal.js';
import {
  findClassificationHistory,
  findClassificationsForFoods,
  insertClassifications,
  type FoodClassificationRecord,
  type NewClassification,
} from '../../db/classification.js';
import type { Db } from '../../db/client.js';
import { searchFoods } from '../../db/food-search.js';
import {
  findFoodById,
  findFoodByName,
  insertFood,
  listFoods,
  removeFood,
  updateFood,
  type FoodRecord,
} from '../../db/food.js';
import {
  countUnclassifiedFoods,
  listUnclassifiedFoods,
  type UnclassifiedFood,
} from '../../db/unclassified.js';
import type { FoodClassifier } from '../../domain/classification/classifier.js';
import { resolveClassification, resolveClassifications } from '../../domain/classification.js';
import {
  ClassifierUnavailableError,
  InsufficientScopeError,
  ResourceNotFoundError,
} from '../../domain/errors.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

export interface FoodRouteOptions {
  db: Db;
  classifier: FoodClassifier;
}

const idParamsSchema = z.strictObject({ id: z.uuidv7() });

const notFoundResponse = {
  404: {
    description: 'No such food, or it has been deleted',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const unavailableResponse = {
  503: {
    description: 'No classifier is configured, or the model could not be reached',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const noContentResponse = { 204: z.null().describe('Deleted') } as const;

export function toFoodResponse(
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

function toUnclassifiedFoodResponse({
  food,
  suggestion,
}: UnclassifiedFood): UnclassifiedFoodResponse {
  return {
    id: food.id,
    name: food.name,
    kind: food.kind,
    ...(food.energyDensity === null ? {} : { energyDensity: food.energyDensity }),
    ...(food.createdBy === null ? {} : { createdBy: food.createdBy }),
    suggestion: suggestion === undefined ? null : toClassificationResponse(suggestion),
  };
}

export const foodRoutes: FastifyPluginCallbackZod<FoodRouteOptions> = (app, options, done) => {
  const { db, classifier } = options;

  function classificationFor(
    food: FoodRecord,
    userId: string,
  ): FoodClassificationRecord | undefined {
    return resolveClassification(findClassificationsForFoods(db, [food.id], userId), userId);
  }

  function requireFood(id: string): FoodRecord {
    const food = findFoodById(db, id);
    if (food === undefined) {
      throw new ResourceNotFoundError();
    }

    return food;
  }

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
      const { limit, cursor, kind, unclassified, mine } = request.query;

      // One row more than asked for, which is how the last page is told from a full one without a
      // second count query.
      const page = listFoods(db, { userId, limit: limit + 1, cursor, kind, unclassified, mine });
      const items = page.slice(0, limit);

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

  app.get(
    '/foods/search',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Find a food by what somebody has typed so far',
        querystring: foodSearchQuerySchema,
        response: {
          200: z.array(foodResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { q, limit } = request.query;

      const results = searchFoods(db, { userId, query: q, limit });

      const resolved = resolveClassifications(
        findClassificationsForFoods(
          db,
          results.map((food) => food.id),
          userId,
        ),
        userId,
      );

      return results.map((food) => toFoodResponse(food, resolved.get(food.id)));
    },
  );

  app.get(
    '/foods/unclassified',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'The review queue: what has no colour yet, ranked by how often it is eaten',
        querystring: unclassifiedFoodsQuerySchema,
        response: {
          200: z.array(unclassifiedFoodResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { minConfidence, limit } = request.query;

      return listUnclassifiedFoods(db, { userId, minConfidence, limit }).map(
        toUnclassifiedFoodResponse,
      );
    },
  );

  app.get(
    '/foods/unclassified/count',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'How many entries are in the review queue, cheaply enough to poll',
        querystring: unclassifiedCountQuerySchema,
        response: {
          200: unclassifiedCountResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;

      return {
        count: countUnclassifiedFoods(db, { userId, minConfidence: request.query.minConfidence }),
      };
    },
  );

  app.post(
    '/foods/unclassified/confirm',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Confirm the colour of several queued foods in one request',
        body: bulkClassifyRequestSchema,
        response: {
          200: bulkClassifyResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;

      // Positional rather than keyed by foodId, so two items naming one food each get a result.
      const outcomes = request.body.items.map((item) => ({
        foodId: item.foodId,
        food: findFoodById(db, item.foodId),
        category: item.category,
        reasoning: item.reasoning,
      }));

      const verdicts: NewClassification[] = outcomes
        .filter((outcome) => outcome.food !== undefined)
        .map((outcome) => ({
          foodId: (outcome.food as FoodRecord).id,
          category: outcome.category,
          source: 'user',
          userId,
          ...(outcome.reasoning === undefined ? {} : { reasoning: outcome.reasoning }),
        }));
      const inserted = insertClassifications(db, verdicts);

      let cursor = 0;
      const results = outcomes.map((outcome) => {
        if (outcome.food === undefined) {
          return { foodId: outcome.foodId, status: 'not_found' as const };
        }

        const classification = inserted[cursor++] as FoodClassificationRecord;
        return {
          foodId: outcome.foodId,
          status: 'confirmed' as const,
          classification: toClassificationResponse(classification),
        };
      });

      request.log.info(
        { userId, confirmed: cursor, notFound: outcomes.length - cursor },
        'food classifications bulk confirmed',
      );

      return { results };
    },
  );

  app.post(
    '/foods/classify',
    {
      config: { auth: 'write' },
      schema: {
        summary:
          'Ask the model for a name and a colour for something somebody typed, writing nothing',
        body: classifyFoodRequestSchema,
        response: {
          200: classifyFoodResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...unavailableResponse,
          ...problemResponses,
        },
      },
    },
    async (request) => {
      const { userId } = request.auth;

      const result = await classifier({ name: request.body.text });

      if (result.status === 'unavailable') {
        request.log.info({ userId, reason: result.reason }, 'classifier unavailable');
        throw new ClassifierUnavailableError();
      }

      request.log.info(
        { userId, model: result.model, confidence: result.confidence },
        'food classified from text',
      );

      // Nothing is written: a suggestion nobody accepts must leave no catalog row and no verdict
      // behind. The food is created by POST /foods when the suggestion is actually logged, which
      // also means the verdict stored for it is the caller's own.
      return { name: result.name, category: result.category, confidence: result.confidence };
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

      // 200 rather than 201 for a match, so a client can tell its entry is not the one created.
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

      return findClassificationHistory(db, food.id, userId).map(toClassificationResponse);
    },
  );

  app.put(
    '/foods/:id/classification',
    {
      config: { auth: 'write' },
      schema: {
        summary: "Override this food's colour with the caller's own opinion",
        params: idParamsSchema,
        body: createClassificationRequestSchema,
        response: {
          200: foodClassificationResponseSchema,
          ...authenticatedProblemResponses,
          ...notFoundResponse,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const food = requireFood(request.params.id);

      const [classification] = insertClassifications(db, [
        {
          foodId: food.id,
          category: request.body.category,
          source: 'user',
          userId,
          ...(request.body.reasoning === undefined ? {} : { reasoning: request.body.reasoning }),
        },
      ]);

      request.log.info({ userId, foodId: food.id }, 'food classification overridden');

      return toClassificationResponse(classification as FoodClassificationRecord);
    },
  );

  app.delete(
    '/foods/:id/classification',
    {
      config: { auth: 'write' },
      schema: {
        summary: "Withdraw the caller's own opinion, falling back to the AI or seed verdict",
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
      const food = requireFood(request.params.id);

      withdrawClassification(db, food.id, userId);

      request.log.info({ userId, foodId: food.id }, 'food classification withdrawn');

      reply.code(204).send(null);
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
        summary: 'Remove an entry, leaving the meals that named it as they were logged',
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
      const { userId, scopes } = request.auth;
      const food = requireFood(request.params.id);

      requireAuthorOrAdmin(food, userId, scopes);

      if (!removeFood(db, food)) {
        throw new ResourceNotFoundError();
      }

      request.log.info({ userId, foodId: food.id }, 'food deleted');

      reply.code(204).send(null);
    },
  );

  done();
};
