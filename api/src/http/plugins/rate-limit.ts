import type { FastifyInstance, FastifyRequest } from 'fastify';

import { hashToken } from '../../domain/auth.js';
import { bucketFor, type RateLimiter } from '../../domain/rate-limit.js';
import { readCredential } from './auth.js';

/**
 * How much traffic one caller may send. The counting is in domain/rate-limit.ts, this is the
 * hook that decides who a caller is and what their request costs.
 *
 * It is registered before the auth plugin, and that ordering is the whole point rather than an
 * accident of the file order in buildApp. Fastify stops the hook chain at the first failure, so
 * a limiter that ran after authentication would never see a request carrying a dead token,
 * which is exactly the request a flood is made of. Running first means the cheapest check
 * happens before the database is touched, before Argon2 runs, and before anything is logged.
 *
 * The cost is that this hook cannot know who the caller actually is, only what credential they
 * presented. That is enough: see the two keys below.
 */

export interface RateLimitPluginOptions {
  limiter: RateLimiter;
  /** Requests under this prefix are charged against the stricter auth allowance. */
  authPathPrefix: string;
  /**
   * Route paths that are never rate limited. One entry, the liveness probe: an orchestrator
   * reads a 429 as a dead process and restarts it, so limiting the probe turns a busy minute
   * into a restart loop. Behind a proxy that forgets X-Forwarded-For every caller shares one
   * IP, which is the case where that would actually happen.
   */
  exemptPaths: readonly string[];
}

/**
 * The keys a request is counted against. Both have to be under the limit.
 *
 * Which of the two binds when, and why one alone would not do, is on createRateLimiter. What
 * matters here is that the credential is hashed rather than used raw, so a heap dump of the
 * counter map is not a list of live credentials, and that the digest is the same one the auth
 * plugin is about to compute anyway.
 */
function keysFor(request: FastifyRequest): string[] {
  const credential = readCredential(request);
  const ip = `ip:${request.ip}`;

  return credential === undefined ? [ip] : [`token:${hashToken(credential.token)}`, ip];
}

export function registerRateLimit(
  app: FastifyInstance,
  { limiter, authPathPrefix, exemptPaths }: RateLimitPluginOptions,
): void {
  const exempt = new Set(exemptPaths);

  app.addHook('onRequest', (request, _reply, done) => {
    // The route's declared path, not the URL as sent, so a query string cannot dodge the
    // exemption and a request that matched nothing is still counted.
    const routePath = request.routeOptions.url;
    if (routePath !== undefined && exempt.has(routePath)) {
      done();
      return;
    }

    const bucket = bucketFor(request.method, (routePath ?? request.url).startsWith(authPathPrefix));

    try {
      limiter.assertWithinLimit(bucket, keysFor(request));
    } catch (error) {
      request.log.warn(
        { bucket, ip: request.ip, route: request.url },
        'request refused, over the rate limit',
      );
      done(error as Error);
      return;
    }

    done();
  });
}
