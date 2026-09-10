import { STATUS_CODES } from 'node:http';

import {
  PROBLEM,
  PROBLEM_CONTENT_TYPE,
  problemDetailsSchema,
  type ProblemDetails,
} from '@portionium/schemas';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

import { isDomainError, ThrottledError, type DomainErrorCode } from '../domain/errors.js';

/**
 * The one place an error becomes an HTTP response.
 *
 * Everything that can fail a request arrives here: a schema rejection from the validator, a
 * typed failure thrown by the domain, an error the framework raised before a handler ran, and
 * whatever nobody predicted. Each leaves as RFC 9457 Problem Details, so a client has one
 * response shape to parse and one field to branch on.
 *
 * The domain does not know any of this. It throws a DomainError carrying a code, and the map
 * below is the only thing in the codebase that decides what that code means over HTTP.
 */

/**
 * Domain failures, mapped. A Record over the code union rather than a switch with a default,
 * so adding a code in domain/errors.ts without deciding what it means here does not compile.
 *
 * The two 422s are 422 rather than 400. The request was well formed and the client could not
 * have known it would be refused: the shape was right, the meaning was not. A 400 would tell a
 * client to fix its serialization, which is the wrong advice.
 *
 * The two authentication failures are the reason this map holds a status per code rather than
 * one status for all of them. Neither says anything a client could use to work out whether the
 * address it sent belongs to an account, which is a property of the strings written here.
 *
 * `resource_not_found` is a 404 for a row that is missing and for one belonging to somebody
 * else, which is the whole point of it. A 403 there would answer "does this id exist" to
 * anybody willing to ask, see docs/adr/003-multi-user-authorization.md.
 */
const DOMAIN_PROBLEMS: Record<
  DomainErrorCode,
  Pick<ProblemDetails, 'type' | 'title' | 'status'>
> = {
  invalid_credentials: {
    type: PROBLEM.invalidCredentials,
    title: 'Invalid credentials',
    status: 401,
  },
  invalid_current_password: {
    type: PROBLEM.invalidCurrentPassword,
    title: 'Current password is incorrect',
    status: 403,
  },
  too_many_login_attempts: {
    type: PROBLEM.tooManyLoginAttempts,
    title: 'Too many failed sign in attempts',
    status: 429,
  },
  rate_limited: {
    type: PROBLEM.rateLimited,
    title: 'Too many requests',
    status: 429,
  },
  unauthenticated: {
    type: PROBLEM.unauthenticated,
    title: 'Not signed in',
    status: 401,
  },
  insufficient_scope: {
    type: PROBLEM.insufficientScope,
    title: 'Insufficient scope',
    status: 403,
  },
  csrf_origin_rejected: {
    type: PROBLEM.csrfOriginRejected,
    title: 'Origin not recognised',
    status: 403,
  },
  session_required: {
    type: PROBLEM.sessionRequired,
    title: 'Session required',
    status: 403,
  },
  resource_not_found: {
    type: PROBLEM.notFound,
    title: 'Not found',
    status: 404,
  },
  food_in_use: {
    type: PROBLEM.foodInUse,
    title: 'Food is used by a meal',
    status: 409,
  },
  meal_has_no_items: {
    type: PROBLEM.mealHasNoItems,
    title: 'A meal must contain at least one item',
    status: 422,
  },
  implausible_weight: {
    type: PROBLEM.implausibleWeight,
    title: 'Weight is not plausible',
    status: 422,
  },
  idempotency_key_mismatch: {
    type: PROBLEM.idempotencyKeyMismatch,
    title: 'Idempotency-Key reused for a different request',
    status: 422,
  },
  idempotency_request_in_progress: {
    type: PROBLEM.idempotencyRequestInProgress,
    title: 'Request still in progress',
    status: 409,
  },
};

/**
 * What the client is told when something unexpected broke. Deliberately says nothing: the
 * cause is in the log, addressed by the request id that is in this same body.
 */
const INTERNAL_DETAIL =
  'The request could not be completed. Quote the request id when reporting this.';

/**
 * Spread into a route's `response` map, so the generated OpenAPI document describes the errors
 * a route can answer with and not only its happy path. Declaring them also means the error
 * body is serialized through the schema, so a problem that does not match the contract fails
 * in the test suite rather than in a client.
 *
 * 400, 429 and 500 are on every route by construction: any route can be sent a request its
 * schemas reject, any route can be sent too fast, and any route can hit a bug. The 429 is
 * raised by the rate limit plugin before a route runs, so no route raises it itself, see
 * http/plugins/rate-limit.ts. Statuses that depend on what a route does, a 404 for a resource
 * that is looked up, are declared by that route.
 */
export const problemResponses = {
  400: {
    description: 'The request does not match the schema',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  429: {
    description: 'The caller is over the rate limit for this kind of request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  500: {
    description: 'Unexpected server error',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/**
 * Spread into the `response` map of every route that needs a credential, which is every route
 * this API serves except the three in the public list. Raised by the auth plugin before a
 * handler runs, so no route raises them itself and none would otherwise document them. See
 * http/plugins/auth.ts.
 */
export const authenticatedProblemResponses = {
  401: {
    description: 'No credential, or one that no longer resolves to anybody',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  403: {
    description: 'The credential may not do this, or the request failed the origin check',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/**
 * Spread into the `response` map of every route that changes something. These are answered by
 * the idempotency plugin before the handler runs, so a route never raises them itself and
 * would not otherwise know to document them. See http/plugins/idempotency.ts.
 */
export const idempotencyProblemResponses = {
  409: {
    description: 'The first request carrying this Idempotency-Key has not finished',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
  422: {
    description: 'The Idempotency-Key was already used for a different request',
    content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
  },
} as const;

/**
 * `instance` and `requestId` are filled in here rather than by any caller. They are properties
 * of the request, not of the failure, and a caller that had to remember them is a caller that
 * eventually forgets.
 */
function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: Omit<ProblemDetails, 'instance' | 'requestId'>,
): FastifyReply {
  const body: ProblemDetails = {
    ...problem,
    // The occurrence, as far as a URL can name one. The request id is what actually
    // distinguishes this occurrence from the next one at the same path.
    instance: request.url,
    requestId: request.id,
  };

  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

/**
 * Installs the two handlers on the root instance, so every route registered anywhere under it
 * answers errors the same way. Called once, from buildApp.
 */
export function registerProblemHandlers(app: FastifyInstance): void {
  // A route that does not exist never reaches the error handler, Fastify answers it on a
  // separate path. Without this it would be the one response in the API that is not a problem
  // document, which is exactly the special case a client forgets to handle.
  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, {
      type: PROBLEM.unclassified,
      title: 'Not Found',
      status: 404,
      detail: `No route for ${request.method} ${request.url}.`,
    }),
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Validation, first, because it is the only failure that can say something more useful
    // than its status code. The issues come from the Zod error the validator already
    // produced, so the field paths are derived rather than described.
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendProblem(request, reply, {
        type: PROBLEM.validationFailed,
        title: 'Request validation failed',
        status: 400,
        detail: `The request ${error.validationContext ?? 'payload'} does not match the schema.`,
        errors: error.validation.map(({ instancePath, message }) => ({
          // An issue about the payload itself, an unrecognized key at the top level, has no
          // path. Fastify writes that as "/", RFC 6901 spells the whole document as "".
          path: instancePath === '/' ? '' : instancePath,
          // Optional in Fastify's own type, always set by the Zod validator.
          message: message ?? 'Invalid value',
        })),
      });
    }

    if (isDomainError(error)) {
      // The one family of failures that carries something a client can act on. A 429 with no
      // Retry-After leaves a caller guessing, and a caller that guesses retries too soon or
      // gives up. Matched on the base class, so a third throttle cannot forget the header.
      if (error instanceof ThrottledError) {
        reply.header('Retry-After', error.retryAfterSeconds);
      }

      return sendProblem(request, reply, {
        ...DOMAIN_PROBLEMS[error.code],
        // Domain messages are written for a person to read and carry no internals, see
        // domain/errors.ts.
        detail: error.message,
      });
    }

    // Everything the framework raises before or around a handler: an unparseable body, a
    // media type nobody registered, a rate limit later on. These carry a status and a message
    // that is already meant for the client, and nothing a client would branch on beyond the
    // status, which is what about:blank is for.
    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return sendProblem(request, reply, {
        type: PROBLEM.unclassified,
        title: STATUS_CODES[status] ?? 'Request Error',
        status,
        detail: error.message,
      });
    }

    // Anything left is a bug: an exception nobody expected, or a response that did not match
    // its own schema. The stack goes to the log, under the request id that the client is
    // holding, and the client is told nothing else.
    request.log.error({ err: error }, 'Unhandled error');

    return sendProblem(request, reply, {
      type: PROBLEM.internalError,
      title: 'Internal server error',
      status: 500,
      detail: INTERNAL_DETAIL,
    });
  });
}
