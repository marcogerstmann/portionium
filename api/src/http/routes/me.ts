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

/**
 * The account, as its owner sees and edits it. Five endpoints and one row.
 *
 * There is no id in any of these paths. The caller is `request.auth` and nothing else, so
 * `/me` is the only spelling of "my profile" and there is no version of it that could be
 * pointed at somebody else's account by editing a URL. Reaching another user's row is not
 * refused here, it is not expressible.
 */

export interface MeRouteOptions {
  db: Db;
  /** Whether the cleared session cookie is marked Secure. Same derivation as the live one. */
  cookieSecure: boolean;
}

/** A 204 says everything a successful password change has to say. */
const noContentResponse = { 204: z.null().describe('Changed') } as const;

/**
 * The row behind `request.auth`. The auth hook resolved this account a moment ago, so the only
 * way it is gone is a delete that landed in between, which is the same "no longer resolves to
 * anybody" the next request would get. Answering it as such beats a 500 for a race nobody can
 * do anything about.
 */
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
      // PATCH rather than PUT, and the body says which fields it means. A field that is absent
      // is a field nobody touched, which is what lets two tabs edit two halves of a profile
      // without the slower one writing the other's change back to what it read.
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
      // PUT rather than PATCH because the body is the whole of this resource, but a category
      // the body does not name is still untouched rather than reset: there are three of them
      // and a client changing one should not have to write back the two it read, which is the
      // same reasoning PATCH /me gives. See updateWeeklyBudgets.
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

      // A session, not a token. A script handed limited access to this account must not be able
      // to take the account over, which is what changing the password amounts to. Same rule as
      // minting a token, see SessionRequiredError.
      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

      const user = currentUser(db, userId);

      // The credential on the request proves the browser was signed in at some point. It does
      // not prove the person at the keyboard is the owner, which is what an unattended session
      // is, so the current password is asked for and actually checked.
      if (!(await verifyPassword(user.passwordHash, request.body.currentPassword))) {
        request.log.warn({ userId }, 'password change refused, current password did not match');
        throw new InvalidCurrentPasswordError();
      }

      // Ends every session in the same transaction, this one included. A password that has been
      // changed while a session opened with the old one is still live is a password that has not
      // really been changed. API tokens are deliberately untouched, see setPasswordHash.
      const endedSessions = setPasswordHash(
        db,
        userId,
        await hashPassword(request.body.newPassword),
      );

      // The row behind it is already gone, so this only saves the browser from sending a dead
      // cookie until it notices. Signing in again is the next step either way.
      reply.header('set-cookie', clearedSessionCookie(cookieSecure));

      request.log.info({ userId, endedSessions }, 'password changed');

      reply.code(204).send(null);
    },
  );

  done();
};
