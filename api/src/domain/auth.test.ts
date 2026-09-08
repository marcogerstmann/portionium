import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ARGON2_OPTIONS,
  createLoginThrottle,
  createSessionToken,
  DUMMY_PASSWORD_HASH,
  hashPassword,
  hashSessionToken,
  LOGIN_ATTEMPT_WINDOW_MS,
  maskEmail,
  MAX_ATTEMPTS_PER_EMAIL,
  MAX_ATTEMPTS_PER_IP,
  SESSION_TTL_MS,
  verifyPassword,
} from './auth.js';
import { DomainError, TooManyLoginAttemptsError } from './errors.js';

const EMAIL = 'ada@example.test';
const IP = '198.51.100.7';

afterEach(() => {
  vi.useRealTimers();
});

/** Everything before the salt in a PHC string: the algorithm, the version and the cost. */
function parametersOf(phc: string): string {
  return phc.split('$').slice(1, 4).join('$');
}

describe('password hashing', () => {
  it('produces an Argon2id hash carrying the configured parameters', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(parametersOf(hash)).toBe('argon2id$v=19$m=19456,t=2,p=1');
    expect(ARGON2_OPTIONS.memoryCost).toBe(19_456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
  });

  it('salts, so the same password twice is two different hashes', async () => {
    const [first, second] = await Promise.all([hashPassword('same'), hashPassword('same')]);

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, 'same')).resolves.toBe(true);
    await expect(verifyPassword(second, 'same')).resolves.toBe(true);
  });

  it('accepts the right password and refuses everything else', async () => {
    const hash = await hashPassword('correct horse battery staple');

    await expect(verifyPassword(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(verifyPassword(hash, 'Correct horse battery staple')).resolves.toBe(false);
    await expect(verifyPassword(hash, '')).resolves.toBe(false);
  });

  it('answers false for a stored value it cannot read, rather than throwing', async () => {
    // A row holding something that is not a PHC string is a bug worth a log line. It is not a
    // reason to answer 500 on a login form, and nobody gets in either way.
    await expect(verifyPassword('not a hash', 'anything')).resolves.toBe(false);
  });

  /**
   * The guard on the timing defence. The dummy hash is a constant, so nothing recomputes it
   * when the parameters above are raised, and a dummy that is cheaper than the real thing puts
   * the gap between "no such account" and "wrong password" back where it started.
   */
  it('verifies the dummy hash at exactly the cost of a real one', async () => {
    expect(parametersOf(DUMMY_PASSWORD_HASH)).toBe(
      parametersOf(await hashPassword('anything at all')),
    );
  });

  it('never matches anything, whatever is tried against it', async () => {
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, '')).resolves.toBe(false);
    await expect(verifyPassword(DUMMY_PASSWORD_HASH, 'password')).resolves.toBe(false);
  });
});

describe('session tokens', () => {
  it('stores a digest and hands out the token', () => {
    const { token, tokenHash, expiresAt } = createSessionToken(new Date('2026-03-01T12:00:00Z'));

    expect(tokenHash).toBe(hashSessionToken(token));
    expect(tokenHash).not.toContain(token);
    expect(expiresAt).toEqual(
      new Date(new Date('2026-03-01T12:00:00Z').getTime() + SESSION_TTL_MS),
    );
  });

  it('mints 256 bits of randomness, not an ordered id', () => {
    const tokens = Array.from({ length: 100 }, () => createSessionToken().token);

    expect(new Set(tokens).size).toBe(100);
    // 32 bytes, base64url, no padding.
    expect(tokens[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Sorted order must not be issue order, which is exactly what a UUIDv7 would give.
    expect([...tokens].sort()).not.toEqual(tokens);
  });
});

describe('maskEmail', () => {
  it('keeps the domain and loses the person', () => {
    expect(maskEmail('ada@example.test')).toBe('a***@example.test');
  });

  it('drops a local part short enough that its first character is all of it', () => {
    expect(maskEmail('a@example.test')).toBe('***@example.test');
  });

  it('reveals nothing about a string that is not an address', () => {
    expect(maskEmail('nonsense')).toBe('***');
    expect(maskEmail('@example.test')).toBe('***');
  });
});

describe('login throttle', () => {
  it('allows the documented number of failures before it locks an address', () => {
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      expect(() => throttle.assertNotLockedOut(EMAIL, IP)).not.toThrow();
      throttle.recordFailure(EMAIL, IP);
    }

    expect(() => throttle.assertNotLockedOut(EMAIL, IP)).toThrow(TooManyLoginAttemptsError);
  });

  it('locks that address everywhere, not only the address and IP that reached the limit', () => {
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      throttle.recordFailure(EMAIL, IP);
    }

    // Moving to another network is the first thing an attacker does. The address is the key.
    expect(() => throttle.assertNotLockedOut(EMAIL, '203.0.113.9')).toThrow(DomainError);
  });

  it('locks an IP that is working through addresses without ever reaching a per address limit', () => {
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_IP; attempt += 1) {
      // A different address every time, so no email counter gets anywhere near its own limit.
      throttle.recordFailure(`user-${attempt}@example.test`, IP);
    }

    expect(() => throttle.assertNotLockedOut('someone-new@example.test', IP)).toThrow(DomainError);
  });

  it('reports how long is left, rounded up', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      throttle.recordFailure(EMAIL, IP);
    }

    vi.setSystemTime(new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS - 1500));

    try {
      throttle.assertNotLockedOut(EMAIL, IP);
      expect.unreachable('should have been locked out');
    } catch (error) {
      expect(error).toBeInstanceOf(TooManyLoginAttemptsError);
      expect((error as TooManyLoginAttemptsError).retryAfterSeconds).toBe(2);
    }
  });

  it('lets the window close', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      throttle.recordFailure(EMAIL, IP);
    }

    vi.setSystemTime(new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS));

    expect(() => throttle.assertNotLockedOut(EMAIL, IP)).not.toThrow();
  });

  it('does not let a steady drip of attempts hold the window open forever', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-01T12:00:00Z') });
    const throttle = createLoginThrottle();

    throttle.recordFailure(EMAIL, IP);
    vi.setSystemTime(new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS - 1));
    throttle.recordFailure(EMAIL, IP);

    // The window started at the first failure. The second one does not move it.
    vi.setSystemTime(new Date(Date.now() + 1));
    expect(() => throttle.assertNotLockedOut(EMAIL, IP)).not.toThrow();
  });

  it('forgets an address that signed in successfully', () => {
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      throttle.recordFailure(EMAIL, IP);
    }
    throttle.clearEmail(EMAIL);

    expect(() => throttle.assertNotLockedOut(EMAIL, IP)).not.toThrow();
  });

  it('keeps counting an IP that signed in successfully, so one good password does not reset a spray', () => {
    const throttle = createLoginThrottle();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_IP; attempt += 1) {
      throttle.recordFailure(`user-${attempt}@example.test`, IP);
    }
    throttle.clearEmail('user-0@example.test');

    expect(() => throttle.assertNotLockedOut('user-0@example.test', IP)).toThrow(DomainError);
  });

  it('gives each instance its own memory', () => {
    const throttle = createLoginThrottle();
    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      throttle.recordFailure(EMAIL, IP);
    }

    expect(() => createLoginThrottle().assertNotLockedOut(EMAIL, IP)).not.toThrow();
  });
});
