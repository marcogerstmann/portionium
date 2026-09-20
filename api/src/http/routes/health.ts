import { PROBLEM_CONTENT_TYPE, problemDetailsSchema } from '@portionium/schemas';
import type { FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { databaseNotReadyReason, type Db } from '../../db/client.js';
import { NotReadyError } from '../../domain/errors.js';
import { problemResponses } from '../problem.js';

const healthQuerySchema = z.strictObject({});

const healthResponseSchema = z.object({
  status: z.literal('ok'),
});

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
        request.log.error({ reason }, 'readiness check failed');
        throw new NotReadyError();
      }

      return { status: 'ready' } as const;
    },
  );

  done();
};
