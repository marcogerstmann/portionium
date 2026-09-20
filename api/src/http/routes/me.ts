import {
  changePasswordRequestSchema,
  toUserResponse,
  updateBudgetsRequestSchema,
  updateProfileRequestSchema,
  userResponseSchema,
  weeklyBudgetsSchema,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  findUserById,
  setPasswordHash,
  updateUserProfile,
  updateWeeklyBudgets,
  weeklyBudgetsOf,
  type UserRecord,
} from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import { hashPassword, verifyPassword } from '../../domain/auth.js';
import {
  InvalidCurrentPasswordError,
  SessionRequiredError,
  UnauthenticatedError,
} from '../../domain/errors.js';
import { clearedSessionCookie } from '../plugins/auth.js';
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

export interface MeRouteOptions {
  db: Db;
  cookieSecure: boolean;
}

const noContentResponse = { 204: z.null().describe('Changed') } as const;

function currentUser(db: Db, userId: string): UserRecord {
  const user = findUserById(db, userId);
  if (user === undefined) {
    throw new UnauthenticatedError();
  }

  return user;
}

export const meRoutes: FastifyPluginCallbackZod<MeRouteOptions> = (app, options, done) => {
  const { db, cookieSecure } = options;

  app.get(
    '/me',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'The signed in account',
        response: {
          200: userResponseSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => toUserResponse(currentUser(db, request.auth.userId)),
  );

  app.patch(
    '/me',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Change the display name, timezone, day boundary hour or locale',
        body: updateProfileRequestSchema,
        response: {
          200: userResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const updated = updateUserProfile(db, request.auth.userId, request.body);
      if (updated === undefined) {
        throw new UnauthenticatedError();
      }

      request.log.info(
        { userId: updated.id, fields: Object.keys(request.body) },
        'profile updated',
      );

      return toUserResponse(updated);
    },
  );

  app.get(
    '/me/budgets',
    {
      config: { auth: 'read' },
      schema: {
        summary: "The caller's weekly allowance per category, null for unlimited",
        response: {
          200: weeklyBudgetsSchema,
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => weeklyBudgetsOf(currentUser(db, request.auth.userId)),
  );

  app.put(
    '/me/budgets',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Set the weekly allowance per category; absent is untouched, null is unlimited',
        description:
          'A soft lock and nothing more. No count is ever refused and no limit is enforced ' +
          'anywhere, see GET /api/v1/stats/budget. A limit of 0 is valid and means none of ' +
          'that colour this week, which is not the same as null.',
        body: updateBudgetsRequestSchema,
        response: {
          200: weeklyBudgetsSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      // PUT, but a category the body does not name is untouched rather than reset: a client
      // changing one should not have to write back the two it read.
      const updated = updateWeeklyBudgets(db, request.auth.userId, request.body);
      if (updated === undefined) {
        throw new UnauthenticatedError();
      }

      request.log.info(
        { userId: updated.id, categories: Object.keys(request.body) },
        'weekly budgets updated',
      );

      return weeklyBudgetsOf(updated);
    },
  );

  app.post(
    '/me/password',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Change the password, which ends every session including this one',
        body: changePasswordRequestSchema,
        response: {
          ...noContentResponse,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    async (request, reply) => {
      const { userId, sessionId } = request.auth;

      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

      const user = currentUser(db, userId);

      if (!(await verifyPassword(user.passwordHash, request.body.currentPassword))) {
        request.log.warn({ userId }, 'password change refused, current password did not match');
        throw new InvalidCurrentPasswordError();
      }

      const endedSessions = setPasswordHash(
        db,
        userId,
        await hashPassword(request.body.newPassword),
      );

      reply.header('set-cookie', clearedSessionCookie(cookieSecure));

      request.log.info({ userId, endedSessions }, 'password changed');

      reply.code(204).send(null);
    },
  );

  done();
};
