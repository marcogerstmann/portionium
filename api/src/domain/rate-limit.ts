import { RateLimitedError } from './errors.js';
import { createWindowCounters, retryAfterSeconds } from './window-counter.js';

export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export type RateLimitBucket = 'read' | 'write' | 'auth';

export type RateLimits = Record<RateLimitBucket, number>;

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function bucketFor(method: string, isAuthEndpoint: boolean): RateLimitBucket {
  if (isAuthEndpoint) {
    return 'auth';
  }

  return SAFE_METHODS.has(method) ? 'read' : 'write';
}

export interface RateLimiter {
  assertWithinLimit(bucket: RateLimitBucket, keys: readonly string[]): void;
}

/**
 * Both keys have to be under the limit. Without the address key a forged token per request buys
 * unlimited buckets; without the credential key one stolen token spreads over a hundred addresses.
 */
export function createRateLimiter(limits: RateLimits): RateLimiter {
  const counters = createWindowCounters();

  return {
    assertWithinLimit(bucket, keys) {
      const limit = limits[bucket];
      let worst = 0;

      for (const key of keys) {
        const window = counters.hit(`${bucket}:${key}`, RATE_LIMIT_WINDOW_MS);
        if (window.count > limit) {
          worst = Math.max(worst, retryAfterSeconds(window));
        }
      }

      if (worst > 0) {
        throw new RateLimitedError(worst);
      }
    },
  };
}
