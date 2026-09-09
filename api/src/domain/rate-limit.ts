import { RateLimitedError } from './errors.js';
import { createWindowCounters, retryAfterSeconds } from './window-counter.js';

/**
 * How much traffic one caller may send, with no request object in sight.
 *
 * Three buckets rather than one number, because the three cost wildly different things. A read
 * is a SQLite query on a file already in the page cache. A write is a transaction, an fsync and
 * an idempotency row. A sign in is an Argon2id verification, deliberately 19 MiB and two passes,
 * which is the most expensive thing this server does and therefore the most attractive thing to
 * point a flood at.
 *
 * State lives in this process and nowhere else, see docs/adr/005-no-redis-no-metrics-stack.md.
 */

/** One minute, and the unit the configured limits are expressed in. */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export type RateLimitBucket = 'read' | 'write' | 'auth';

/** Requests per minute per caller, per bucket. Comes from config, see RATE_LIMIT_* there. */
export type RateLimits = Record<RateLimitBucket, number>;

/** Safe methods cost a read, everything else is charged as a write. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Which allowance a request is charged against. The method decides it, not the scope the route
 * declares: a scope is about what a caller may do, this is about what the server has to spend.
 */
export function bucketFor(method: string, isAuthEndpoint: boolean): RateLimitBucket {
  if (isAuthEndpoint) {
    return 'auth';
  }

  return SAFE_METHODS.has(method) ? 'read' : 'write';
}

export interface RateLimiter {
  /**
   * Counts one request against every key given and throws if any of them is over the bucket's
   * limit. Every key is counted even when an earlier one already failed, so a caller cannot
   * spend somebody else's allowance for free by tripping their own first.
   */
  assertWithinLimit(bucket: RateLimitBucket, keys: readonly string[]): void;
}

/**
 * Callers are keyed twice, and both counters have to be under the limit. Neither key is
 * decoration and neither would do on its own.
 *
 * The address is what makes a limit hold at all. A caller with no credential has no other key,
 * and one presenting a forged credential could otherwise mint itself a fresh allowance on every
 * request simply by sending different nonsense, which is the entire flood this exists to stop.
 *
 * The credential is what a shared address cannot say. The same token used from a hundred
 * addresses is a hundred untouched address counters and one credential counter that is over its
 * limit, so a stolen token spread across a botnet is caught by the key that follows it.
 *
 * For one person on one address the address counter is the binding one, since it counts every
 * request the credential counter does and more. That is the expected case and it is fine: the
 * credential key earns its place in the case the address key cannot see.
 *
 * The bucket is part of the key, so a minute of reads does not consume the allowance for writes.
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
