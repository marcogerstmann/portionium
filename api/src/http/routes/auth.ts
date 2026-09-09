import {
  loginRequestSchema,
  loginResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';

import { findUserByEmail, insertSession } from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import {
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  maskEmail,
  verifyPassword,
  type LoginThrottle,
} from '../../domain/auth.js';
import { InvalidCredentialsError } from '../../domain/errors.js';
import { problemResponses } from '../problem.js';

/**
 * Signing in. The only endpoint in the API that anybody can reach without already having
 * credentials, which is why the interesting parts of it are about what it refuses to reveal.
 *
 * There is no counterpart to it. Accounts are made by an administrator with the `user` CLI, and
 * there is no public registration endpoint anywhere in this repository: an instance serving two
 * people has nothing to gain from self service sign up and a great deal to lose from it.
 */

export interface AuthRouteOptions {
  db: Db;
  /**
   * One per process, created in buildApp. Passed in rather than reached for, so a test can hand
   * this route a fresh one and not inherit the failures another test recorded.
   */
  throttle: LoginThrottle;
}

/** Declared here rather than in problemResponses: only this route can answer with either. */
const authProblemResponses = {
  401: {
    description: 'The email and password did not match an account',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  429: {
    description: 'Too many failed attempts. Carries Retry-After',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

export const authRoutes: FastifyPluginCallbackZod<AuthRouteOptions> = (app, options, done) => {
  const { db, throttle } = options;

  app.post(
    '/auth/login',
    {
      // The endpoint that mints the credential, so requiring one would be a circle. It is the
      // only write in the API that anybody can reach, which is why the lockout below exists.
      config: { auth: 'public' },
      schema: {
        summary: 'Exchange an email and password for a session',
        body: loginRequestSchema,
        response: { 200: loginResponseSchema, ...authProblemResponses, ...problemResponses },
      },
    },
    async (request) => {
      const { email, password } = request.body;
      const ip = request.ip;

      // Before any hashing. A locked out attempt should cost a map lookup, otherwise the
      // lockout is an invitation to spend the server's CPU rather than a limit on it.
      throttle.assertNotLockedOut(email, ip);

      const user = findUserByEmail(db, email);

      // Always a real verification, against this user's hash or against a constant one. The
      // alternative, returning early when the address is unknown, answers in microseconds for
      // an address with no account and in tens of milliseconds for one that has an account,
      // and that gap is readable from the other side of the internet. See DUMMY_PASSWORD_HASH.
      const passwordMatches = await verifyPassword(
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        password,
      );

      if (user === undefined || !passwordMatches) {
        throttle.recordFailure(email, ip);

        // Enough to see an attack in the logs and not enough to be a record of who holds an
        // account here: the local part of the address is masked, the password is not touched,
        // and `reason` distinguishes the two cases for whoever is reading the log. None of
        // that distinction reaches the response, which is one status and one sentence for
        // both. See InvalidCredentialsError.
        request.log.warn(
          {
            email: maskEmail(email),
            ip,
            reason: user === undefined ? 'no_such_account' : 'wrong_password',
          },
          'login failed',
        );

        throw new InvalidCredentialsError();
      }

      throttle.clearEmail(email);

      const { token, tokenHash, expiresAt } = createSessionToken();
      insertSession(db, { userId: user.id, tokenHash, expiresAt });

      request.log.info({ userId: user.id }, 'login succeeded');

      return {
        // The one time this string exists outside the client. Only its SHA-256 was stored.
        sessionToken: token,
        expiresAt: expiresAt.toISOString(),
        // Listed field by field rather than spread. The row carries a password hash, and a
        // response that is correct because a schema happens to strip an extra key is a
        // response that stops being correct the day somebody reaches for a looser schema.
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.role,
          timezone: user.timezone,
          dayBoundaryHour: user.dayBoundaryHour,
        },
      };
    },
  );

  done();
};
