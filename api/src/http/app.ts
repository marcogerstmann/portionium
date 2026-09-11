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
import { createRateLimiter } from '../domain/rate-limit.js';
import { registerAuth } from './plugins/auth.js';
import { registerIdempotency } from './plugins/idempotency.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerSecurity } from './plugins/security.js';
import { registerProblemHandlers } from './problem.js';
import { authRoutes } from './routes/auth.js';
import { foodRoutes } from './routes/foods.js';
import { healthRoutes, HEALTH_PATH } from './routes/health.js';
import { mealRoutes } from './routes/meals.js';
import { meRoutes } from './routes/me.js';
import { weightRoutes } from './routes/weight.js';

/**
 * The Fastify shell. Everything about how a route is written is decided here, once.
 *
 * A route declares Zod schemas and nothing else. The type provider infers the handler's
 * parameter and return types from those schemas, so there is no second place where a request
 * or response shape is written down and no cast at the boundary. The same schemas are what
 * the OpenAPI document is generated from, which is why there is no hand written spec in this
 * repository and no way for the spec and the code to disagree.
 *
 * How a failure leaves the building is decided here too, once, see problem.ts. Every error
 * response is RFC 9457 Problem Details, whoever raised it. So is who a request is from, see
 * plugins/auth.ts: routes are authenticated by default and one that says nothing about who may
 * call it stops this function from returning.
 */

/**
 * Where v1 lives. One constant, so a future v2 is a second register call here rather than an
 * edit in every route file.
 */
export const API_PREFIX = '/api/v1';

/** Path of the generated document, relative to the prefix. Also the path CI validates. */
export const OPENAPI_PATH = '/openapi.json';

/** Path of the browsable UI, relative to the prefix. Served only when API_DOCS_ENABLED. */
export const DOCS_PATH = '/docs';

/** Days on the wire of a config file, milliseconds everywhere the code does arithmetic. */
function sessionTtlMs(config: Config): number {
  return config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
}

export interface AppDependencies {
  config: Config;
  /**
   * Taken as the handle rather than the `Db`, because closing it is part of shutting the app
   * down: `app.close()` is the single call that stops accepting requests, drains the ones in
   * flight and then releases the database file.
   */
  database: DatabaseHandle;
}

/**
 * Builds a ready to use server without listening. Tests get the real app this way, over
 * `app.inject()`, rather than a stub that can drift from it.
 */
export async function buildApp({ config, database }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    // Behind a proxy this is what makes request.ip and the logged protocol honest.
    trustProxy: true,
    // Refused before the body is read into memory, which is what makes it a limit rather than
    // a check. Fastify answers 413 itself and the error handler turns it into a problem
    // document like any other. See MAX_BODY_BYTES in config.ts.
    bodyLimit: config.MAX_BODY_BYTES,
  }).withTypeProvider<ZodTypeProvider>();

  // One per process. It counts failed logins in its own memory, so it has to outlive a request
  // and must not outlive the app: a second instance would mean two half filled counters and an
  // effective limit of twice what is documented.
  const throttle = createLoginThrottle();

  // The same reasoning, for the same reason: one set of counters per process, or the documented
  // limit is not the limit.
  const rateLimiter = createRateLimiter({
    read: config.RATE_LIMIT_READ_PER_MINUTE,
    write: config.RATE_LIMIT_WRITE_PER_MINUTE,
    auth: config.RATE_LIMIT_AUTH_PER_MINUTE,
  });

  // Zod replaces Ajv on both sides of a request. Validation rejects a bad body with the Zod
  // issues attached, serialization runs the response through its declared schema, so a
  // handler that returns a field the contract does not have fails here rather than in a
  // client six weeks later.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Registered on the root instance, before any route, so nothing can be registered later that
  // answers an error in its own shape.
  registerProblemHandlers(app);

  // Closing the app closes the database. Registered before anything else so it runs last:
  // Fastify calls onClose hooks in reverse order, so the file is released after the routes
  // that might still be using it have finished.
  app.addHook('onClose', () => {
    database.close();
  });

  // First of the three request hooks, and deliberately before authentication. Fastify stops
  // the chain at the first failure, so a limiter placed after auth would never count a request
  // carrying a dead credential, which is what a flood is made of. See http/plugins/rate-limit.ts.
  registerRateLimit(app, {
    limiter: rateLimiter,
    authPathPrefix: `${API_PREFIX}/auth`,
    exemptPaths: [HEALTH_PATH],
  });

  // Second, so a CORS preflight is answered before anything asks it for a credential it cannot
  // carry, and so the headers are on an error response as well as a successful one. See
  // http/plugins/security.ts.
  registerSecurity(app, {
    // Same derivation as the session cookie's Secure flag, from the same variable.
    secure: config.WEB_ORIGIN.startsWith('https://'),
    docsPathPrefix: `${API_PREFIX}${DOCS_PATH}`,
    corsOrigins: config.CORS_ORIGINS,
  });

  // Before every register below it, for two reasons: its onRoute hook only sees routes added
  // after it, and a route that forgets to say who may call it has to fail here rather than
  // answer. See http/plugins/auth.ts.
  registerAuth(app, {
    db: database.db,
    webOrigin: config.WEB_ORIGIN,
    sessionTtlMs: sessionTtlMs(config),
  });

  // After auth, because a key is filed under the caller auth has just established, and on the
  // root instance for the same reason auth is: every write gets it, none can opt out. See
  // http/plugins/idempotency.ts.
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
      // No `servers` entry for the prefix. The generated paths already carry it, because
      // they are the URLs Fastify actually routes, and a server URL of /api/v1 on top of
      // them would send a generated client to /api/v1/api/v1/health.
    },
    transform: jsonSchemaTransform,
  });

  if (config.API_DOCS_ENABLED) {
    await app.register(fastifySwaggerUi, { routePrefix: `${API_PREFIX}${DOCS_PATH}` });
  }

  // Non-versioned endpoints
  await app.register(healthRoutes);

  await app.register(
    (v1, _options, done) => {
      // The document describing this prefix, served from inside it. Hidden from itself: a
      // meaningful response schema for it would be the whole OpenAPI meta schema, and an
      // entry for it in its own paths tells a client nothing it can call.
      v1.get(
        OPENAPI_PATH,
        {
          // The contract a client is built from, which is a document it reads before it has
          // ever signed in. The Swagger UI over it is public for the same reason, and is
          // behind API_DOCS_ENABLED besides.
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
        // A cookie marked Secure is dropped by a browser over plain http, so the flag follows
        // the origin the app is actually served from rather than a second variable that can be
        // set to the wrong half of the pair. See WEB_ORIGIN in config.ts.
        cookieSecure: config.WEB_ORIGIN.startsWith('https://'),
      });

      void v1.register(foodRoutes, { db: database.db });

      void v1.register(mealRoutes, { db: database.db });

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
