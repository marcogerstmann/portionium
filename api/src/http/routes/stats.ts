import { statsDaysQuerySchema, statsDaysResponseSchema } from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { findClassificationsForFoods } from '../../db/classification.js';
import type { Db } from '../../db/client.js';
import { findItemsForDateRange } from '../../db/meal.js';
import { resolveClassifications } from '../../domain/classification.js';
import { computeDailyColourStats } from '../../domain/stats.js';
import { authenticatedProblemResponses, problemResponses } from '../problem.js';

/**
 * POR-36: the basic feedback loop, how a range of days looked next to a normal day. Everything
 * is resolved and grouped at read time, see domain/stats.ts for why that stays cheap enough not
 * to need a materialised table yet.
 */

export interface StatsRouteOptions {
  db: Db;
}

export const statsRoutes: FastifyPluginCallbackZod<StatsRouteOptions> = (app, options, done) => {
  const { db } = options;

  app.get(
    '/stats/days',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Per-day colour counts over a local date range, gaps filled with zeroes',
        querystring: statsDaysQuerySchema,
        response: {
          200: statsDaysResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { from, to } = request.query;

      // Two queries whatever the range contains, the same split itemsAndColours in meals.ts
      // makes for a single day: every item in the range in one, then every colour those items'
      // foods resolve to in one more, bounded by the catalog rather than by the range.
      const items = findItemsForDateRange(db, userId, from, to);
      const foodIds = [...new Set(items.map((item) => item.foodId))];
      const resolved = resolveClassifications(
        findClassificationsForFoods(db, foodIds, userId),
        userId,
      );

      return { days: computeDailyColourStats(items, resolved, from, to) };
    },
  );

  done();
};
