import {
  apiTokenResponseSchema,
  createApiTokenRequestSchema,
  createApiTokenResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  sessionResponseSchema,
  type Scope,
} from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import {
  deleteSession,
  findUserByEmail,
  insertApiToken,
  insertSession,
  listApiTokens,
  listSessions,
  revokeApiToken,
  type ApiTokenRecord,
  type SessionRecord,
} from '../../db/auth.js';
import type { Db } from '../../db/client.js';
import {
  canGrantScopes,
  createApiToken,
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  maskEmail,
  verifyPassword,
  type LoginThrottle,
} from '../../domain/auth.js';
import {
  InsufficientScopeError,
  InvalidCredentialsError,
  ResourceNotFoundError,
  SessionRequiredError,
} from '../../domain/errors.js';
import { clearedSessionCookie, sessionCookie } from '../plugins/auth.js';
import { idempotencyProblemResponses, problemResponses } from '../problem.js';

/**
 * The credentials, both of them: the session a person gets by typing a password into the web
 * app, and the API token they mint from that session for something that has no keyboard.
 *
 * There is no registration endpoint here and there will not be one. Accounts are made by an
 * administrator with the `user` CLI: an instance serving two people has nothing to gain from
 * self service sign up and a great deal to lose from it.
 *
 * The split between the two credentials is the design. A browser holds a cookie it cannot read,
 * which is what makes an injected script unable to steal it, and pays for that with a CSRF
 * check on every mutation. A script holds a string it can read, which is the only thing a
 * script can do, and pays for that with a scope list its owner chose and a revoke button.
 */

export interface AuthRouteOptions {
  db: Db;
  /**
   * One per process, created in buildApp. Passed in rather than reached for, so a test can hand
   * this route a fresh one and not inherit the failures another test recorded.
   */
  throttle: LoginThrottle;
  sessionTtlMs: number;
  /** Whether the session cookie is marked Secure, derived from WEB_ORIGIN's scheme. */
  cookieSecure: boolean;
}

/** Declared here rather than in problemResponses: only the login route can answer with these. */
const loginProblemResponses = {
  401: {
    description: 'The email and password did not match an account',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  429: {
    description: 'Too many failed attempts. Carries Retry-After',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** Every route below this one needs a credential, so all of them can answer these two. */
const authenticatedProblemResponses = {
  401: {
    description: 'No credential, or one that no longer resolves to anybody',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  403: {
    description: 'The credential may not do this, or the request failed the origin check',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const notFoundResponse = {
  404: {
    description: 'No such session or token belonging to this user',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/** A DELETE that worked has nothing to say, so it says it with no body at all. */
const noContentResponse = { 204: z.null().describe('Revoked') } as const;

const idParamsSchema = z.strictObject({ id: z.uuidv7() });

function toSessionResponse(session: SessionRecord, currentSessionId: string | undefined) {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastActivityAt: session.lastActivityAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
    current: session.id === currentSessionId,
  };
}

function toApiTokenResponse(token: ApiTokenRecord) {
  return {
    id: token.id,
    name: token.name,
    scopes: token.scopes,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
    expiresAt: token.expiresAt?.toISOString() ?? null,
  };
}

export const authRoutes: FastifyPluginCallbackZod<AuthRouteOptions> = (app, options, done) => {
  const { db, throttle, sessionTtlMs, cookieSecure } = options;

  app.post(
    '/auth/login',
    {
      // The endpoint that mints the credential, so requiring one would be a circle. It is the
      // only write in the API that anybody can reach, which is why the lockout below exists.
      config: { auth: 'public' },
      schema: {
        summary: 'Exchange an email and password for a session cookie',
        body: loginRequestSchema,
        response: { 200: loginResponseSchema, ...loginProblemResponses, ...problemResponses },
      },
    },
    async (request, reply) => {
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

      const { token, tokenHash, expiresAt } = createSessionToken(new Date(), sessionTtlMs);
      insertSession(db, { userId: user.id, tokenHash, expiresAt });

      // The only place this string leaves the process, and it leaves in a header the page that
      // caused it cannot read. Nothing in the body carries a credential, so a response logged
      // by a proxy or pasted into a bug report is not a way in.
      reply.header(
        'set-cookie',
        sessionCookie(token, Math.floor(sessionTtlMs / 1000), cookieSecure),
      );

      request.log.info({ userId: user.id }, 'login succeeded');

      return {
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

  app.post(
    '/auth/logout',
    {
      // The weakest scope there is. Signing out is not a privilege, and a session that could
      // not end itself would be a session a user cannot get rid of.
      config: { auth: 'read' },
      schema: {
        summary: 'End the session this request arrived on',
        response: {
          ...noContentResponse,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { sessionId, userId } = request.auth;

      // An API token has no session to end, and treating "log out" as a no-op for one would
      // answer 204 to a client that is still fully authenticated.
      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

      // The row is deleted, so the credential is dead whatever the client does with the header
      // below. A logout that only cleared a cookie would leave a stolen copy working.
      deleteSession(db, userId, sessionId);
      reply.header('set-cookie', clearedSessionCookie(cookieSecure));

      request.log.info({ userId }, 'session ended');

      reply.code(204).send(null);
    },
  );

  app.get(
    '/auth/sessions',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'List the browsers this account is signed in on',
        response: {
          200: z.array(sessionResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => {
      const { userId, sessionId } = request.auth;

      return listSessions(db, userId).map((session) => toSessionResponse(session, sessionId));
    },
  );

  app.delete(
    '/auth/sessions/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Sign one browser out',
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
      // The owner is part of the delete, so a session id belonging to somebody else removes
      // nothing and is answered exactly as an id that never existed. See ADR 003.
      if (!deleteSession(db, request.auth.userId, request.params.id)) {
        throw new ResourceNotFoundError();
      }

      reply.code(204).send(null);
    },
  );

  app.post(
    '/auth/tokens',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Mint an API token, shown once',
        body: createApiTokenRequestSchema,
        response: {
          201: createApiTokenResponseSchema,
          ...authenticatedProblemResponses,
          ...idempotencyProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request, reply) => {
      const { userId, role, sessionId } = request.auth;
      const { name, scopes, expiresInDays } = request.body;

      // A token cannot mint its own successor. Otherwise revoking a stolen one means nothing,
      // because whoever took it made a fresh one first. This is why the web client creates
      // tokens and there is no pairing code flow for a device that has no browser.
      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

      // The only place in this API where a caller names their own permissions, so it is also
      // the only place that has to check they are not naming more than they have.
      if (!canGrantScopes(role, scopes)) {
        request.log.warn({ userId, role, scopes }, 'token creation refused for excess scopes');
        throw new InsufficientScopeError();
      }

      const { token, tokenHash } = createApiToken();

      const stored = insertApiToken(db, {
        userId,
        name,
        tokenHash,
        // Deduplicated and stored as asked for rather than expanded, see the scopes column.
        scopes: [...new Set<Scope>(scopes)],
        expiresAt:
          expiresInDays === undefined
            ? null
            : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      });

      request.log.info({ userId, tokenId: stored.id, scopes }, 'api token created');

      // The one response that carries it. Only the digest was stored, so nobody, including
      // whoever holds the database file, can produce this string again.
      reply.code(201).send({ ...toApiTokenResponse(stored), token });
    },
  );

  app.get(
    '/auth/tokens',
    {
      config: { auth: 'read' },
      schema: {
        summary: 'List this account API tokens, without the tokens',
        response: {
          200: z.array(apiTokenResponseSchema),
          ...authenticatedProblemResponses,
          ...problemResponses,
        },
      },
    },
    (request) => listApiTokens(db, request.auth.userId).map(toApiTokenResponse),
  );

  app.delete(
    '/auth/tokens/:id',
    {
      config: { auth: 'write' },
      schema: {
        summary: 'Revoke an API token, effective on the next request carrying it',
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
      // Owner in the where clause, and already revoked counts as nothing to do, so revoking
      // twice is a 404 rather than a second success.
      if (!revokeApiToken(db, request.auth.userId, request.params.id)) {
        throw new ResourceNotFoundError();
      }

      request.log.info(
        { userId: request.auth.userId, tokenId: request.params.id },
        'api token revoked',
      );

      reply.code(204).send(null);
    },
  );

  done();
};
