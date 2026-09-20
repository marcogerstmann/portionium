import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';

import type { Config } from '../config.js';
import type { DatabaseHandle } from '../db/client.js';
import { createLoginThrottle } from '../domain/auth.js';
import { unavailableClassifier, type FoodClassifier } from '../domain/classification/classifier.js';
import { createOpenAIClassifier } from '../domain/classification/openai.js';
import { createRateLimiter } from '../domain/rate-limit.js';
import { loggerOptions } from './logging.js';
import { registerAuth } from './plugins/auth.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerSecurity } from './plugins/security.js';
import { registerWebApp } from './plugins/static.js';
import { registerProblemHandlers } from './problem.js';
import { authRoutes } from './routes/auth.js';
import { foodRoutes } from './routes/foods.js';
import { healthRoutes, HEALTH_PATH, READY_PATH } from './routes/health.js';
import { mealRoutes } from './routes/meals.js';
import { meRoutes } from './routes/me.js';
import { statsRoutes } from './routes/stats.js';
import { weightRoutes } from './routes/weight.js';

export const API_PREFIX = '/api/v1';

export const OPENAPI_PATH = '/openapi.json';

export const DOCS_PATH = '/docs';

function sessionTtlMs(config: Config): number {
  return config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

export interface AppDependencies {
  config: Config;
  database: DatabaseHandle;
  /** Only a test passes one: every other caller gets the classifier the configuration describes. */
  classifier?: FoodClassifier;
}

function classifierFor(config: Config): FoodClassifier {
  return config.OPENAI_API_KEY === ''
    ? unavailableClassifier
    : createOpenAIClassifier({
        apiKey: config.OPENAI_API_KEY,
        model: config.OPENAI_MODEL,
        baseUrl: config.OPENAI_BASE_URL,
        timeoutMs: config.OPENAI_TIMEOUT_MS,
        maxCallsPerDay: config.OPENAI_MAX_CALLS_PER_DAY,
      });
}

export async function buildApp({
  config,
  database,
  classifier,
}: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions(config.LOG_LEVEL),
    trustProxy: true,
    bodyLimit: config.MAX_BODY_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  const throttle = createLoginThrottle();

  const rateLimiter = createRateLimiter({
    read: config.RATE_LIMIT_READ_PER_MINUTE,
    write: config.RATE_LIMIT_WRITE_PER_MINUTE,
    auth: config.RATE_LIMIT_AUTH_PER_MINUTE,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const serveWebApp =
    config.WEB_ROOT === ''
      ? undefined
      : await registerWebApp(app, { root: config.WEB_ROOT, apiPathPrefix: API_PREFIX });

  registerProblemHandlers(app, serveWebApp);

  // Registered first so it runs last: Fastify calls onClose hooks in reverse order, and the
  // database file is released after the routes still using it have finished.
  app.addHook('onClose', () => {
    database.close();
  });

  // Before authentication, deliberately: Fastify stops the hook chain at the first failure, so a
  // limiter behind auth would never count requests carrying a dead credential.
  registerRateLimit(app, {
    limiter: rateLimiter,
    authPathPrefix: `${API_PREFIX}/auth`,
    exemptPaths: [HEALTH_PATH, READY_PATH],
  });

  registerSecurity(app, {
    secure: config.WEB_ORIGIN.startsWith('https://'),
    docsPathPrefix: `${API_PREFIX}${DOCS_PATH}`,
    servesWebApp: serveWebApp !== undefined,
    corsOrigins: config.CORS_ORIGINS,
  });

  // Before every register below it: its onRoute hook only sees routes added afterwards.
  registerAuth(app, {
    db: database.db,
    webOrigin: config.WEB_ORIGIN,
    sessionTtlMs: sessionTtlMs(config),
  });

  registerIdempotency(app, {
    db: database.db,
    retentionMs: config.IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000,
  });

  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Portionium API',
        description:
          'Generated from the Zod schemas the routes are validated with. Never hand edited.',
        version: '1.0.0',
      },
      // No `servers` entry: the generated paths already carry the prefix, and a server URL
      // repeating it would send a generated client to /api/v1/api/v1/health.
    },
    transform: jsonSchemaTransform,
  });

  if (config.API_DOCS_ENABLED) {
    await app.register(fastifySwaggerUi, { routePrefix: `${API_PREFIX}${DOCS_PATH}` });
  }

  await app.register(healthRoutes, { db: database.db });

  await app.register(
    (v1, _options, done) => {
      v1.get(
        OPENAPI_PATH,
        {
          config: { auth: 'public' },
          schema: {
            hide: true,
            response: { 200: z.looseObject({ openapi: z.string() }) },
          },
        },
        () => app.swagger(),
      );

      void v1.register(authRoutes, {
        db: database.db,
        throttle,
        sessionTtlMs: sessionTtlMs(config),
        cookieSecure: config.WEB_ORIGIN.startsWith('https://'),
      });

      void v1.register(foodRoutes, {
        db: database.db,
        classifier: classifier ?? classifierFor(config),
      });

      void v1.register(mealRoutes, { db: database.db });

      void v1.register(statsRoutes, {
        db: database.db,
        trendHalfLifeDays: config.WEIGHT_TREND_HALF_LIFE_DAYS,
      });

      void v1.register(weightRoutes, {
        db: database.db,
        maxDriftPerDay: config.WEIGHT_MAX_DRIFT_PER_DAY,
      });

      void v1.register(meRoutes, {
        db: database.db,
        cookieSecure: config.WEB_ORIGIN.startsWith('https://'),
      });

      done();
    },
    { prefix: API_PREFIX },
  );

  return app;
}
