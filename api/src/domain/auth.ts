import { createHash, randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';

import { TooManyLoginAttemptsError } from './errors.js';

/**
 * The decisions behind signing in, with no database and no request in sight: how a password is
 * turned into a hash, how a session credential is minted, how many failures are too many, and
 * how much of an email address is safe to write to a log.
 *
 * The queries live in db/auth.ts and the endpoint in http/routes/auth.ts. Everything here is
 * either pure or owns nothing but its own memory, which is what makes the interesting parts,
 * the lockout arithmetic and the constant work on an unknown address, testable without a server.
 */

/**
 * OWASP's current recommendation for Argon2id: 19 MiB of memory, two passes, one lane. Written
 * out rather than left to the library's defaults, because a security parameter that lives in
 * someone else's package can change under us in a patch release without anybody deciding to.
 *
 * Memory is the point of this family. Two passes over 19 MiB is cheap for one login on a server
 * and expensive for an attacker who wanted to try millions of them in parallel on a GPU.
 *
 * Raising these later needs no migration: the PHC string each hash carries records the cost it
 * was made with, so old hashes keep verifying. It does need a rehash on next successful login
 * to be worth anything, which is a few lines nobody should write until the numbers move.
 */
export const ARGON2_OPTIONS = {
  // @node-rs/argon2 publishes Algorithm and Version as ambient const enums, which this
  // repository's verbatimModuleSyntax cannot reference at all. The two values are written out
  // under the names that package gives them: Algorithm.Argon2id and Version.V0x13, the latter
  // being the 19 that every hash below carries as `v=19`.
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * A real Argon2id hash of a random string nobody kept.
 *
 * It exists so that a login for an address with no account can do the same work as a login for
 * an address with one. Without it, "no such user" returns in a fraction of a millisecond while
 * a wrong password takes the full cost of the hash, and the difference is measurable from the
 * outside: an attacker learns which of two addresses is registered without ever guessing a
 * password. Verifying against this constant always fails, and always costs what a real check
 * costs.
 *
 * Its parameters have to match ARGON2_OPTIONS or the timings drift apart again, which is what
 * the test beside this file asserts rather than trusts.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$FnecUL8/j8GZJ3uH9Rzq2Q$L9BILNoXDYqbNHip2bd9SaypxwvXiW9l7NocxgiEyZA';

/** Produces a PHC string that carries the parameters above, so verification needs no context. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

/**
 * False rather than a throw for a hash this cannot read. A stored value that is not a PHC
 * string is a bug worth a log line, not a 500 on a login form, and either way nobody gets in.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** Thirty days. Sliding expiry, refreshed on activity, belongs to the sessions story. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface NewSessionToken {
  /** Handed to the client once and never recoverable afterwards. */
  token: string;
  /** What is actually stored. */
  tokenHash: string;
  expiresAt: Date;
}

/**
 * 256 bits from the platform CSPRNG, base64url so it survives a cookie and a header unescaped.
 *
 * Not a UUIDv7 like every other id in this schema. Those are two thirds timestamp and sort by
 * creation time, which is exactly what an identifier should do and exactly what a credential
 * must not: a value somebody can narrow down by knowing roughly when it was issued is a value
 * worth guessing at. This one is unguessable and carries no information.
 */
export function createSessionToken(now: Date = new Date()): NewSessionToken {
  const token = randomBytes(32).toString('base64url');

  return {
    token,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  };
}

/**
 * SHA-256, not Argon2id, and the difference is the input rather than the use.
 *
 * A password is short and human, so it has to be made expensive to guess. This token is 256
 * random bits, so there is nothing to guess at whatever the cost, and a fast digest is the
 * right primitive. It also has to be fast: this runs on every authenticated request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Enough of an address to recognise a pattern of attempts, not enough to be a record of who
 * holds an account here. The domain stays, because a burst of failures against one domain is
 * the shape worth noticing, and the local part goes.
 *
 * A one character local part is returned as nothing at all, since its first character is the
 * whole of it.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }

  const local = email.slice(0, at);
  const domain = email.slice(at);

  return local.length < 2 ? `***${domain}` : `${local[0]}***${domain}`;
}

/**
 * The lockout policy, in numbers. Documented in AGENTS.md, enforced below, and asserted in the
 * test beside this file, so the three cannot disagree quietly.
 *
 * Five per address is roughly where a person who genuinely forgot which password they used
 * stops and an attacker is still at the beginning. Twenty per address gives a household or an
 * office behind one NAT room to fumble without one person locking out the other, while still
 * ending an untargeted spray. Fifteen minutes is short enough that a locked out user waits
 * rather than files a ticket.
 */
export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS_PER_EMAIL = 5;
export const MAX_ATTEMPTS_PER_IP = 20;

/**
 * Above this many tracked keys the map is swept for expired entries. Failed logins are the only
 * thing that creates a key, so reaching this at all means something is spraying addresses, which
 * is the one case where the bookkeeping needs a bound.
 *
 * ponytail: fixed window in process memory, swept on write. Limits reset when the process does,
 * which is the same tradeoff the rate limiting story records for its own state. Move both to a
 * SQLite table together if a restart loop ever becomes a way through the door.
 */
const SWEEP_THRESHOLD = 1000;

interface Counter {
  failures: number;
  resetAt: number;
}

export interface LoginThrottle {
  /**
   * Called before any work is done on the credentials, so a locked out request costs a map
   * lookup rather than an Argon2 verification. Throws when locked, returns otherwise.
   */
  assertNotLockedOut(email: string, ip: string): void;
  recordFailure(email: string, ip: string): void;
  /** A password that turned out to be right clears that address. */
  clearEmail(email: string): void;
}

/**
 * Counts failures per address and per IP in a fixed window.
 *
 * Both keys are counted for every failure, whether or not the address belongs to an account.
 * Skipping the count for an unknown address would make a lockout something that only ever
 * happens to real accounts, which is the same disclosure the identical error message is there
 * to prevent, arrived at from the other direction.
 *
 * Each instance owns its own map, so a test gets a fresh one by calling this and the process
 * gets exactly one, created in buildApp.
 */
export function createLoginThrottle(): LoginThrottle {
  const counters = new Map<string, Counter>();

  /** Returns a live counter, dropping it first if its window has closed. */
  function live(key: string, now: number): Counter | undefined {
    const counter = counters.get(key);
    if (counter === undefined) {
      return undefined;
    }

    if (counter.resetAt <= now) {
      counters.delete(key);
      return undefined;
    }

    return counter;
  }

  /** Milliseconds left on this key's lockout, or zero if it is not at its limit. */
  function remainingLockMs(key: string, now: number, limit: number): number {
    const counter = live(key, now);
    return counter !== undefined && counter.failures >= limit ? counter.resetAt - now : 0;
  }

  return {
    assertNotLockedOut(email, ip) {
      const now = Date.now();
      const remaining = Math.max(
        remainingLockMs(`email:${email}`, now, MAX_ATTEMPTS_PER_EMAIL),
        remainingLockMs(`ip:${ip}`, now, MAX_ATTEMPTS_PER_IP),
      );

      if (remaining > 0) {
        // Rounded up, so a client that waits exactly this long is past the window rather than
        // one millisecond short of it and immediately refused again.
        throw new TooManyLoginAttemptsError(Math.ceil(remaining / 1000));
      }
    },

    recordFailure(email, ip) {
      const now = Date.now();

      if (counters.size > SWEEP_THRESHOLD) {
        for (const [key, counter] of counters) {
          if (counter.resetAt <= now) {
            counters.delete(key);
          }
        }
      }

      for (const key of [`email:${email}`, `ip:${ip}`]) {
        const counter = live(key, now);
        if (counter === undefined) {
          // The window starts at the first failure and does not move, so a steady drip of
          // attempts cannot hold a key locked forever by refreshing it.
          counters.set(key, { failures: 1, resetAt: now + LOGIN_ATTEMPT_WINDOW_MS });
        } else {
          counter.failures += 1;
        }
      }
    },

    clearEmail(email) {
      counters.delete(`email:${email}`);
    },
  };
}
