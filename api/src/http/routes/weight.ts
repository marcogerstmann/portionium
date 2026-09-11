import {
  createWeightEntryRequestSchema,
  localDateSchema,
  pageSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  toWeightEntryResponse,
  weightEntryCreateResponseSchema,
  weightEntryResponseSchema,
  weightListQuerySchema,
  type WeightEntryCreateResponse,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { findUserById, type UserRecord } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import {
  findLatestWeightEntryForDay,
  insertWeightEntry,
  listWeightEntries,
  listWeightHistoryForUser,
  softDeleteWeightEntry,
} from '../../db/weight.js';
import { ResourceNotFoundError, UnauthenticatedError } from '../../domain/errors.js';
import { resolveLocalDate } from '../../domain/local-date.js';
import { createWeightEntry, type NewWeightEntry } from '../../domain/weight.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

/**
 * Weight: the outcome signal beside the colour log, and strictly private, with no read path
 * anywhere that shows one account's readings to another. See docs/adr/003-multi-user-authorization.md.
 *
 * There is no unique constraint on (user_id, local_date): people weigh themselves twice in a
 * day and both readings are real, see the comment on weight_entry in db/schema/weight-entry.ts.
 * "The" reading for a day, what GET /days/{date} shows and DELETE below removes, is the most
 * recently recorded one, findLatestWeightEntryForDay.
 */

export interface WeightRouteOptions {
  db: Db;
  /** How far a reading may drift from the nearest one before it is flagged, not blocked. */
  maxDriftPerDay: number;
}

const dateParamsSchema = z.strictObject({ date: localDateSchema });

const notFoundResponse = {
  404: {
    description: 'No reading on that date, or it has been deleted, or it belongs to somebody else',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const noContentResponse = { 204: z.null().describe('Deleted') } as const;

/**
 * Spread after the idempotency responses, which already declare a 422 of their own, the same
 * pattern mealUpdateProblemResponses in meals.ts follows: one status, two reasons.
 */
const weightCreateProblemResponses = {
  422: {
    description:
      'The weight is outside the plausible human range, or the Idempotency-Key was already ' +
      'used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

export const weightRoutes: FastifyPluginCallbackZod<WeightRouteOptions> = (app, options, done) => {
  const { db, maxDriftPerDay } = options;

  /** The row behind request.auth, the same reasoning as meals.ts's requireUser. */
  function requireUser(userId: string): UserRecord {
    const user = findUserById(db, userId);
    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    return user;
  }

  app.post(
    '/weight',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Record a weight for a local date, defaulting to today',
        body: createWeightEntryRequestSchema,
        response: {
          201: weightEntryCreateResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...weightCreateProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId } = request.auth;
      const user = requireUser(userId);
      const recordedAt = request.body.recordedAt ?? new Date();

      const newEntry: NewWeightEntry = {
        userId,
        weightGrams: request.body.weightGrams,
        recordedAt,
        localDate: resolveLocalDate(recordedAt, user.timezone, user.dayBoundaryHour),
      };

      // Throws implausible_weight for a reading outside the absolute human range. A believable
      // range but a fast jump only returns a warning, it never blocks the write, see
      // createWeightEntry in domain/weight.ts.
      const { entry, warning } = createWeightEntry(
        newEntry,
        listWeightHistoryForUser(db, userId),
        maxDriftPerDay,
      );
      const stored = insertWeightEntry(db, entry);

      request.log.info({ userId, weightEntryId: stored.id, warning }, 'weight entry recorded');

      reply.code(201);
      const response: WeightEntryCreateResponse = {
        ...toWeightEntryResponse(stored),
        warning,
      };
      return response;
    },
  );

  app.get(
    '/weight',
    {
      config: { auth: 'read' },
      schema: {
        summary: "Browse the caller's own weight, newest first",
        querystring: weightListQuerySchema,
        response: {
          200: pageSchema(weightEntryResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { limit, cursor, from, to } = request.query;

      // One row more than asked for, the same trick listMeals uses to tell the last page from a
      // full one without a second, potentially stale, count query.
      const page = listWeightEntries(db, { userId, limit: limit + 1, cursor, from, to });
      const entries = page.slice(0, limit);

      return {
        items: entries.map(toWeightEntryResponse),
        nextCursor: page.length > limit ? (entries.at(-1)?.id ?? null) : null,
      };
    },
  );

  app.delete(
    '/weight/:date',
    {
      config: { auth: 'write' },
      schema: {
        summary:
          'Remove the reading recorded for one local date, the most recent if there was more than one',
        params: dateParamsSchema,
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
      const { date } = request.params;

      const entry = findLatestWeightEntryForDay(db, userId, date);
      if (entry === undefined || !softDeleteWeightEntry(db, userId, entry.id)) {
        throw new ResourceNotFoundError();
      }

      request.log.info({ userId, weightEntryId: entry.id, date }, 'weight entry deleted');

      reply.code(204).send(null);
    },
  );

  done();
};
