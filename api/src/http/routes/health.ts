import { PROBLEM_CONTENT_TYPE, problemDetailsSchema } from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { databaseNotReadyReason, type Db } from '../../db/client.js';
import { NotReadyError } from '../../domain/errors.js';
import { problemResponses } from '../problem.js';

/**
 * The two probes, and they are two because an orchestrator does two different things with the
 * answers. Liveness failing means restart this process. Readiness failing means stop sending it
 * traffic, and a restart would not help.
 *
 * /health is liveness and answers "is this process serving HTTP". It deliberately does not
 * touch the database, because a check that fails on a held write lock would have the process
 * killed for a condition that clears itself in milliseconds.
 *
 * /ready is readiness and does touch it, which is the whole of what it adds.
 *
 * Neither is versioned, see the comment on their registration in app.ts, and neither tells an
 * unauthenticated caller anything about this deployment. There is no version string, no commit,
 * no uptime and no configuration in either response: those are the fields that make a scan of
 * the internet worth somebody's afternoon, and the person entitled to them is reading the log.
 *
 * This is also the shape every other route follows. Schemas are declared for whichever of
 * params, querystring and body the route actually takes, and for every status it answers
 * with. The handler's argument and return types come from those schemas, so the second
 * declaration that usually drifts does not exist.
 */

/**
 * No query parameters, and saying so rejects the ones nobody meant to send. Same rule as
 * request bodies: a misspelled parameter that is silently ignored is a bug that reaches
 * production looking like working code.
 */
const healthQuerySchema = z.strictObject({});

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

// Callback rather than async: registering a route is synchronous, and a plugin that awaits
// nothing has no reason to be a promise.
/** Written down once, because the rate limit plugin exempts both by path. */
export const HEALTH_PATH = '/health';
export const READY_PATH = '/ready';

export interface HealthRoutesOptions {
  db: Db;
}

const readyResponseSchema = z.object({
  status: z.literal('ready'),
});

export const healthRoutes: FastifyPluginCallbackZod<HealthRoutesOptions> = (app, { db }, done) => {
  app.get(
    HEALTH_PATH,
    {
      // An orchestrator has no account and cannot be given one, so this is one of the four
      // endpoints reachable without a credential. See http/plugins/auth.ts.
      config: { auth: 'public' },
      schema: {
        summary: 'Liveness probe',
        querystring: healthQuerySchema,
        response: { 200: healthResponseSchema, ...problemResponses },
      },
    },
    () => ({ status: 'ok' }) as const,
  );

  app.get(
    READY_PATH,
    {
      // Same caller as the liveness probe and the same reason it cannot hold a credential.
      config: { auth: 'public' },
      schema: {
        summary: 'Readiness probe',
        querystring: healthQuerySchema,
        response: {
          200: readyResponseSchema,
          503: {
            description: 'The database did not answer, or its schema is not the expected one',
            content: { [PROBLEM_CONTENT_TYPE]: { schema: problemDetailsSchema } },
          },
          ...problemResponses,
        },
      },
    },
    (request) => {
      const reason = databaseNotReadyReason(db);
      if (reason !== undefined) {
        // The side of this that is actually useful. The response is a status code, this is the
        // sentence that says which of the two things went wrong, under the request id the
        // caller was given.
        request.log.error({ reason }, 'readiness check failed');
        throw new NotReadyError();
      }

      return { status: 'ready' } as const;
    },
  );

  done();
};
