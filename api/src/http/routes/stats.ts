import {
  statsDaysResponseSchema,
  statsRangeQuerySchema,
  statsWeightResponseSchema,
  type StatsWeightResponse,
  type WeightTrendChange,
  type WeightTrendComparison,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { findClassificationsForFoods } from '../../db/classification.js';
import type { Db } from '../../db/client.js';
import { findItemsForDateRange } from '../../db/meal.js';
import { listWeightHistoryForUser } from '../../db/weight.js';
import { resolveClassifications } from '../../domain/classification.js';
import { computeDailyColourStats } from '../../domain/stats.js';
import {
  computeWeightTrend,
  type WeightTrendChange as TrendChange,
  type WeightTrendComparison as TrendComparison,
} from '../../domain/weight-trend.js';
import { authenticatedProblemResponses, problemResponses } from '../problem.js';

/**
 * POR-36 and POR-37: the basic feedback loop, how a range of days looked next to a normal day,
 * and what the scale is saying underneath its own noise. Everything is resolved, grouped and
 * smoothed at read time, see domain/stats.ts for why that stays cheap enough not to need a
 * materialised table yet.
 */

export interface StatsRouteOptions {
  db: Db;
  /** How long a reading takes to lose half its influence on the trend, see config.ts. */
  trendHalfLifeDays: number;
}

/**
 * Grams to kilograms, the same boundary conversion toWeightEntryResponse makes for a reading:
 * nobody thinks in grams, and no arithmetic should be done in the unit somebody typed. Rounded
 * to the gram, because a smoothed value is a float and 82.34239999999999 is not a weight.
 */
function toKg(grams: number | null): number | null {
  return grams === null ? null : Math.round(grams) / 1000;
}

function toChangeResponse(change: TrendChange): WeightTrendChange {
  return {
    from: change.from,
    to: change.to,
    changeKg: toKg(change.changeGrams),
    changePerWeekKg: toKg(change.changePerWeekGrams),
  };
}

function toComparisonResponse(comparison: TrendComparison): WeightTrendComparison {
  return {
    differenceKg: toKg(comparison.differenceGrams),
    differencePerWeekKg: toKg(comparison.differencePerWeekGrams),
  };
}

export const statsRoutes: FastifyPluginCallbackZod<StatsRouteOptions> = (app, options, done) => {
  const { db, trendHalfLifeDays } = options;

  app.get(
    '/stats/days',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'Per-day colour counts over a local date range, gaps filled with zeroes',
        querystring: statsRangeQuerySchema,
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

  app.get(
    '/stats/weight',
    {
      config: { auth: 'read' },
      schema: {
        summary:
          'The smoothed weight trend over a local date range, with the raw readings beside it',
        querystring: statsRangeQuerySchema,
        response: {
          200: statsWeightResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const { from, to } = request.query;

      // Every reading the account has, not the range's, and the same unbounded read the
      // plausibility check on POST /weight already makes. A trend is a position rather than a
      // function of the window it is looked at through: loading only [from, to] would reset the
      // line to whatever was on the scale that first morning and report a fortnight of the
      // smoothing settling as the user's progress. The endpoint also needs the period before
      // this one to compare against. See computeWeightTrend for both.
      const trend = computeWeightTrend(listWeightHistoryForUser(db, userId), {
        from,
        to,
        halfLifeDays: trendHalfLifeDays,
      });

      const response: StatsWeightResponse = {
        days: trend.days.map((day) => ({
          date: day.date,
          trendKg: toKg(day.trendGrams),
          lowConfidence: day.lowConfidence,
          movingAverageKg: toKg(day.movingAverageGrams),
          rawKg: toKg(day.rawGrams),
        })),
        change: toChangeResponse(trend.change),
        previous: toChangeResponse(trend.previous),
        versusPrevious: toComparisonResponse(trend.versusPrevious),
      };

      return response;
    },
  );

  done();
};
