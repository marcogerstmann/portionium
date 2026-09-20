import {
  apiTokenResponseSchema,
  createApiTokenRequestSchema,
  createApiTokenResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  sessionResponseSchema,
  toUserResponse,
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
import {
  authenticatedProblemResponses,
  idempotencyProblemResponses,
  problemResponses,
} from '../problem.js';

export interface AuthRouteOptions {
  db: Db;
  throttle: LoginThrottle;
  sessionTtlMs: number;
  cookieSecure: boolean;
}

const loginProblemResponses = {
  401: {
    description: 'The email and password did not match an account',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

const notFoundResponse = {
  404: {
    description: 'No such session or token belonging to this user',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

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

      throttle.assertNotLockedOut(email, ip);

      const user = findUserByEmail(db, email);

      // Always a real verification, against this user's hash or the dummy: returning early for an
      // unknown address answers in microseconds where a wrong password costs tens of milliseconds.
      const passwordMatches = await verifyPassword(
        user?.passwordHash ?? DUMMY_PASSWORD_HASH,
        password,
      );

      if (user === undefined || !passwordMatches) {
        throttle.recordFailure(email, ip);

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

      reply.header(
        'set-cookie',
        sessionCookie(token, Math.floor(sessionTtlMs / 1000), cookieSecure),
      );

      request.log.info({ userId: user.id }, 'login succeeded');

      return { expiresAt: expiresAt.toISOString(), user: toUserResponse(user) };
    },
  );

  app.post(
    '/auth/logout',
    {
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

      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

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

      // A token cannot mint its own successor, or revoking a stolen one means nothing.
      if (sessionId === undefined) {
        throw new SessionRequiredError();
      }

      if (!canGrantScopes(role, scopes)) {
        request.log.warn({ userId, role, scopes }, 'token creation refused for excess scopes');
        throw new InsufficientScopeError();
      }

      const { token, tokenHash } = createApiToken();

      const stored = insertApiToken(db, {
        userId,
        name,
        tokenHash,
        scopes: [...new Set<Scope>(scopes)],
        expiresAt:
          expiresInDays === undefined
            ? null
            : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000),
      });

      request.log.info({ userId, tokenId: stored.id, scopes }, 'api token created');

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
