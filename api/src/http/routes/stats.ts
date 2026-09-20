import {
  statsBudgetQuerySchema,
  statsBudgetResponseSchema,
  statsDaysResponseSchema,
  statsRangeQuerySchema,
  statsWeeklyQuerySchema,
  statsWeeklyResponseSchema,
  statsWeightResponseSchema,
  type StatsBudgetResponse,
  type StatsWeeklyResponse,
  type StatsWeightResponse,
  type WeightTrendChange,
  type WeightTrendComparison,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { findUserById, weeklyBudgetsOf, type UserRecord } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import { findEntriesForDateRange } from '../../db/meal.js';
import { listWeightHistoryForUser } from '../../db/weight.js';
import { computeBudgetStatus } from '../../domain/budget.js';
import { UnauthenticatedError } from '../../domain/errors.js';
import { resolveLocalDate } from '../../domain/local-date.js';
import { computeDailyColourStats } from '../../domain/stats.js';
import { computeWeeklySummary, isoWeekOf, isoWeeksEnding } from '../../domain/weekly-summary.js';
import {
  computeWeightTrend,
  type WeightTrendChange as TrendChange,
  type WeightTrendComparison as TrendComparison,
} from '../../domain/weight-trend.js';
import { authenticatedProblemResponses, problemResponses } from '../problem.js';

export interface StatsRouteOptions {
  db: Db;
  trendHalfLifeDays: number;
}

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

      const entries = findEntriesForDateRange(db, userId, from, to);

      return { days: computeDailyColourStats(entries, from, to) };
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

      // Every reading the account has, not the range's: a trend is a position rather than a
      // function of the window, so loading only [from, to] reports the smoothing settling as gain.
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
      // One extra week before the first requested one, so that week also has something to compare
      // against. computeWeeklySummary consumes it rather than returning it.
      const windows = isoWeeksEnding(today, weeksRequested + 1);
      const first = windows[0];
      const last = windows.at(-1);
      const from = first?.startDate ?? today;
      const to = last?.endDate ?? today;

      const entries = findEntriesForDateRange(db, userId, from, to);
      const dailyColours = computeDailyColourStats(entries, from, to);

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

  app.get(
    '/stats/budget',
    {
      config: { auth: 'read' },
      schema: {
        summary:
          'How one ISO week stands against the weekly allowance: the limit, the count and ' +
          'what is left, per category',
        description:
          'A soft lock. Nothing here is enforced and logging past a limit always succeeds; ' +
          '`remaining` simply goes negative. The week is the ISO week the `date` query falls ' +
          "in, defaulting to the caller's own current local date, and is numbered by the same " +
          'function GET /api/v1/stats/weekly uses, so the two cannot disagree about where a ' +
          'week starts. Counts are evaluated against whatever limits are configured now, past ' +
          'weeks included: there is no history of limits, so changing one takes effect ' +
          'immediately for the current week and also changes how an old week reads.',
        querystring: statsBudgetQuerySchema,
        response: {
          200: statsBudgetResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId } = request.auth;
      const user = requireUser(userId);

      const week = isoWeekOf(
        request.query.date ?? resolveLocalDate(new Date(), user.timezone, user.dayBoundaryHour),
      );

      const entries = findEntriesForDateRange(db, userId, week.startDate, week.endDate);

      const response: StatsBudgetResponse = {
        isoYear: week.isoYear,
        isoWeek: week.isoWeek,
        startDate: week.startDate,
        endDate: week.endDate,
        budget: computeBudgetStatus(entries, weeklyBudgetsOf(user)),
      };

      return response;
    },
  );

  done();
};
