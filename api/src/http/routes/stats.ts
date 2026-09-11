import {
  statsDaysResponseSchema,
  statsRangeQuerySchema,
  statsWeeklyQuerySchema,
  statsWeeklyResponseSchema,
  statsWeightResponseSchema,
  type StatsWeeklyResponse,
  type StatsWeightResponse,
  type WeightTrendChange,
  type WeightTrendComparison,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { findUserById, type UserRecord } from '../../db/auth.js';
import { findClassificationsForFoods } from '../../db/classification.js';
import type { Db } from '../../db/client.js';
import { findItemsForDateRange } from '../../db/meal.js';
import { listWeightHistoryForUser } from '../../db/weight.js';
import { resolveClassifications } from '../../domain/classification.js';
import { UnauthenticatedError } from '../../domain/errors.js';
import { resolveLocalDate } from '../../domain/local-date.js';
import { computeDailyColourStats } from '../../domain/stats.js';
import { computeWeeklySummary, isoWeeksEnding } from '../../domain/weekly-summary.js';
import {
  computeWeightTrend,
  type WeightTrendChange as TrendChange,
  type WeightTrendComparison as TrendComparison,
} from '../../domain/weight-trend.js';
import { authenticatedProblemResponses, problemResponses } from '../problem.js';

/**
 * POR-36, POR-37 and POR-38: the basic feedback loop, how a range of days looked next to a
 * normal day, what the scale is saying underneath its own noise, and the two side by side one
 * ISO week at a time. Everything is resolved, grouped and smoothed at read time, see
 * domain/stats.ts for why that stays cheap enough not to need a materialised table yet.
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

  /** The row behind request.auth, the same reasoning as meals.ts's requireUser: POR-38 needs
   * the account's timezone and day boundary to know which ISO week today falls in. */
  function requireUser(userId: string): UserRecord {
    const user = findUserById(db, userId);
    if (user === undefined) {
      throw new UnauthenticatedError();
    }

    return user;
  }

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

  app.get(
    '/stats/weekly',
    {
      config: { auth: 'read' },
      schema: {
        summary:
          'The colour distribution and weight trend for the last `weeks` ISO weeks, oldest first',
        querystring: statsWeeklyQuerySchema,
        response: {
          200: statsWeeklyResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const user = requireUser(userId);
      const { weeks: weeksRequested } = request.query;

      const today = resolveLocalDate(new Date(), user.timezone, user.dayBoundaryHour);
      // One extra week before the first one the caller asked for, purely so that week also has
      // something to compare against; computeWeeklySummary consumes it rather than returning it.
      const windows = isoWeeksEnding(today, weeksRequested + 1);
      const first = windows[0];
      const last = windows.at(-1);
      // Unreachable: weeksRequested is at least 1 by schema, so windows always has at least two
      // entries. A guard rather than an assertion, same reasoning as computeDailyColourStats.
      const from = first?.startDate ?? today;
      const to = last?.endDate ?? today;

      // The same two queries GET /stats/days makes, over the whole span rather than per week.
      const items = findItemsForDateRange(db, userId, from, to);
      const foodIds = [...new Set(items.map((item) => item.foodId))];
      const resolved = resolveClassifications(
        findClassificationsForFoods(db, foodIds, userId),
        userId,
      );
      const dailyColours = computeDailyColourStats(items, resolved, from, to);

      // The same trend calculation GET /stats/weight makes, once over the whole span; each
      // week below is a slice of its days rather than a trend computed from scratch.
      const trend = computeWeightTrend(listWeightHistoryForUser(db, userId), {
        from,
        to,
        halfLifeDays: trendHalfLifeDays,
      });

      const weeks = computeWeeklySummary(dailyColours, trend.days, windows);

      const response: StatsWeeklyResponse = {
        weeks: weeks.map((week) => ({
          isoYear: week.isoYear,
          isoWeek: week.isoWeek,
          startDate: week.startDate,
          endDate: week.endDate,
          counts: week.counts,
          share: week.share,
          daysLogged: week.daysLogged,
          sparse: week.sparse,
          weight: {
            startKg: toKg(week.weight.startGrams),
            endKg: toKg(week.weight.endGrams),
            changeKg: toKg(week.weight.changeGrams),
            changePerWeekKg: toKg(week.weight.changePerWeekGrams),
          },
          versusPreviousWeek: week.versusPreviousWeek,
        })),
      };

      return response;
    },
  );

  done();
};
