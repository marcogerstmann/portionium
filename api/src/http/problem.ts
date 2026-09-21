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
import type { ServeWebApp } from './plugins/static.js';

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
  meal_has_no_entries: {
    type: PROBLEM.mealHasNoEntries,
    title: 'A meal must contain at least one entry',
    status: 422,
  },
  meal_id_conflict: {
    type: PROBLEM.mealIdConflict,
    title: 'A meal with this id already exists',
    status: 409,
  },
  meal_logged_in_future: {
    type: PROBLEM.mealLoggedInFuture,
    title: 'A meal cannot be logged in the future',
    status: 422,
  },
  meal_from_id_with_entries: {
    type: PROBLEM.mealFromIdWithEntries,
    title: 'fromMealId and entries may not both be set',
    status: 422,
  },
  favourite_has_no_entries: {
    type: PROBLEM.favouriteHasNoEntries,
    title: 'A favourite must contain at least one entry',
    status: 422,
  },
  unknown_food_reference: {
    type: PROBLEM.unknownFoodReference,
    title: 'Unknown food reference',
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
  classifier_unavailable: {
    type: PROBLEM.classifierUnavailable,
    title: 'No classification available',
    status: 503,
  },
  not_ready: {
    type: PROBLEM.notReady,
    title: 'Not ready',
    status: 503,
  },
  idempotency_request_in_progress: {
    type: PROBLEM.idempotencyRequestInProgress,
    title: 'Request still in progress',
    status: 409,
  },
};

const INTERNAL_DETAIL =
  'The request could not be completed. Quote the request id when reporting this.';

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

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  problem: Omit<ProblemDetails, 'instance' | 'requestId'>,
): FastifyReply {
  const body: ProblemDetails = {
    ...problem,
    instance: request.url,
    requestId: request.id,
  };

  return reply.code(body.status).type(PROBLEM_CONTENT_TYPE).send(body);
}

export function registerProblemHandlers(app: FastifyInstance, serveWebApp?: ServeWebApp): void {
  // Fastify answers an unmatched route on a separate path, so without this it would be the one
  // response in the API that is not a problem document.
  app.setNotFoundHandler((request, reply) => {
    if (serveWebApp?.(request, reply) === true) {
      return reply;
    }

    return sendProblem(request, reply, {
      type: PROBLEM.unclassified,
      title: 'Not Found',
      status: 404,
      detail: `No route for ${request.method} ${request.url}.`,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return sendProblem(request, reply, {
        type: PROBLEM.validationFailed,
        title: 'Request validation failed',
        status: 400,
        detail: `The request ${error.validationContext ?? 'payload'} does not match the schema.`,
        errors: error.validation.map(({ instancePath, message }) => ({
          // Fastify writes the root path as "/", where RFC 6901 spells the whole document as "".
          path: instancePath === '/' ? '' : instancePath,
          message: message ?? 'Invalid value',
        })),
      });
    }

    if (isDomainError(error)) {
      if (error instanceof ThrottledError) {
        reply.header('Retry-After', error.retryAfterSeconds);
      }

      return sendProblem(request, reply, {
        ...DOMAIN_PROBLEMS[error.code],
        detail: error.message,
      });
    }

    const status = error.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return sendProblem(request, reply, {
        type: PROBLEM.unclassified,
        title: STATUS_CODES[status] ?? 'Request Error',
        status,
        detail: error.message,
      });
    }

    request.log.error({ err: error }, 'Unhandled error');

    return sendProblem(request, reply, {
      type: PROBLEM.internalError,
      title: 'Internal server error',
      status: 500,
      detail: INTERNAL_DETAIL,
    });
  });
}
