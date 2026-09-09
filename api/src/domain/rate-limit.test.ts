import { describe, expect, it } from 'vitest';

import { RateLimitedError } from './errors.js';
import { bucketFor, createRateLimiter, RATE_LIMIT_WINDOW_MS } from './rate-limit.js';

const LIMITS = { read: 3, write: 2, auth: 1 };

describe('bucketFor', () => {
  it('charges safe methods as reads and everything else as writes', () => {
    expect(bucketFor('GET', false)).toBe('read');
    expect(bucketFor('HEAD', false)).toBe('read');
    expect(bucketFor('OPTIONS', false)).toBe('read');
    expect(bucketFor('POST', false)).toBe('write');
    expect(bucketFor('DELETE', false)).toBe('write');
  });

  it('charges anything under the auth prefix to the auth bucket, whatever the method', () => {
    expect(bucketFor('GET', true)).toBe('auth');
    expect(bucketFor('POST', true)).toBe('auth');
  });
});

describe('createRateLimiter', () => {
  it('allows exactly the configured number of requests and refuses the next one', () => {
    const limiter = createRateLimiter(LIMITS);

    for (let sent = 0; sent < LIMITS.read; sent += 1) {
      expect(() => limiter.assertWithinLimit('read', ['ip:a'])).not.toThrow();
    }

    expect(() => limiter.assertWithinLimit('read', ['ip:a'])).toThrow(RateLimitedError);
  });

  it('counts each bucket separately, so reads do not spend the write allowance', () => {
    const limiter = createRateLimiter(LIMITS);

    for (let sent = 0; sent < LIMITS.read; sent += 1) {
      limiter.assertWithinLimit('read', ['ip:a']);
    }

    expect(() => limiter.assertWithinLimit('write', ['ip:a'])).not.toThrow();
  });

  it("counts each key separately, so one caller does not spend another's allowance", () => {
    const limiter = createRateLimiter(LIMITS);

    for (let sent = 0; sent < LIMITS.auth; sent += 1) {
      limiter.assertWithinLimit('auth', ['ip:a']);
    }

    expect(() => limiter.assertWithinLimit('auth', ['ip:b'])).not.toThrow();
    expect(() => limiter.assertWithinLimit('auth', ['ip:a'])).toThrow(RateLimitedError);
  });

  /**
   * The reason a credential is counted as well as an address. One token spread over many
   * addresses leaves every address counter untouched, so the address key alone would see
   * nothing at all.
   */
  it('refuses one credential used from many addresses', () => {
    const limiter = createRateLimiter(LIMITS);

    for (let sent = 0; sent < LIMITS.read; sent += 1) {
      limiter.assertWithinLimit('read', ['token:t', `ip:${sent}`]);
    }

    expect(() => limiter.assertWithinLimit('read', ['token:t', 'ip:fresh'])).toThrow(
      RateLimitedError,
    );
  });

  /**
   * The reason an address is counted as well as a credential. Without it, sending a different
   * forged token on every request buys an unlimited number of buckets.
   */
  it('refuses many forged credentials from one address', () => {
    const limiter = createRateLimiter(LIMITS);

    for (let sent = 0; sent < LIMITS.read; sent += 1) {
      limiter.assertWithinLimit('read', [`token:forged${sent}`, 'ip:a']);
    }

    expect(() => limiter.assertWithinLimit('read', ['token:forgedAgain', 'ip:a'])).toThrow(
      RateLimitedError,
    );
  });

  it('tells the caller how long to wait, never longer than the window', () => {
    const limiter = createRateLimiter(LIMITS);

    limiter.assertWithinLimit('auth', ['ip:a']);

    try {
      limiter.assertWithinLimit('auth', ['ip:a']);
      expect.unreachable('the second request is over the limit of one');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitedError);
      const { retryAfterSeconds } = error as RateLimitedError;
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(RATE_LIMIT_WINDOW_MS / 1000);
    }
  });
});
