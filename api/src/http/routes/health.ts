import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { problemResponses } from '../problem.js';

/**
 * Liveness only. It answers "is this process serving HTTP", which is what a container
 * orchestrator restarts on. It deliberately does not touch the database: a readiness check
 * that fails on a locked file would take the process down for a condition that clears itself.
 *
 * Served unversioned at /health, see the comment on its registration in app.ts.
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
export const healthRoutes: FastifyPluginCallbackZod = (app, _options, done) => {
  app.get(
    '/health',
    {
      // An orchestrator has no account and cannot be given one, so this is one of the three
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

  done();
};
