import type { FastifyInstance, FastifyRequest } from 'fastify';

import { hashToken } from '../../domain/auth.js';
import { bucketFor, type RateLimiter } from '../../domain/rate-limit.js';
import { readCredential } from './auth.js';

export interface RateLimitPluginOptions {
  limiter: RateLimiter;
  authPathPrefix: string;
  exemptPaths: readonly string[];
}

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
