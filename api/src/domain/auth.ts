import { createHash, randomBytes } from 'node:crypto';

import { hash, verify } from '@node-rs/argon2';
import { API_TOKEN_PREFIX, expandScopes, type Scope, type UserRole } from '@portionium/schemas';

import { TooManyLoginAttemptsError } from './errors.js';
import { createWindowCounters, retryAfterSeconds } from './window-counter.js';

export const ARGON2_OPTIONS = {
  // Algorithm.Argon2id and Version.V0x13 written out: @node-rs/argon2 publishes them as ambient
  // const enums, which verbatimModuleSyntax cannot reference.
  algorithm: 2,
  version: 1,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * Verified against when no account exists, so an unknown address costs the same time as a wrong
 * password.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$FnecUL8/j8GZJ3uH9Rzq2Q$L9BILNoXDYqbNHip2bd9SaypxwvXiW9l7NocxgiEyZA';

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ACTIVITY_INTERVAL_MS = 60 * 1000;

export interface NewCredential {
  token: string;
  tokenHash: string;
}

export interface NewSessionToken extends NewCredential {
  expiresAt: Date;
}

/**
 * Not a UUIDv7 like the ids here: those encode their creation time, which a credential must not.
 */
export function createSessionToken(
  now: Date = new Date(),
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): NewSessionToken {
  const token = randomBytes(32).toString('base64url');

  return { token, tokenHash: hashToken(token), expiresAt: new Date(now.getTime() + ttlMs) };
}

/**
 * The prefix exists to be recognised by secret scanners, and to pick the table to look the
 * credential up in.
 */
export function createApiToken(): NewCredential {
  const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

  return { token, tokenHash: hashToken(token) };
}

export function isApiToken(token: string): boolean {
  return token.startsWith(API_TOKEN_PREFIX);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function shouldRecordActivity(lastActivityAt: Date | null, now: Date): boolean {
  return (
    lastActivityAt === null || now.getTime() - lastActivityAt.getTime() >= ACTIVITY_INTERVAL_MS
  );
}

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) {
    return '***';
  }

  const local = email.slice(0, at);
  const domain = email.slice(at);

  return local.length < 2 ? `***${domain}` : `${local[0]}***${domain}`;
}

export const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS_PER_EMAIL = 5;
export const MAX_ATTEMPTS_PER_IP = 20;

export interface LoginThrottle {
  assertNotLockedOut(email: string, ip: string): void;
  recordFailure(email: string, ip: string): void;
  clearEmail(email: string): void;
}

export function createLoginThrottle(): LoginThrottle {
  const counters = createWindowCounters();

  function remainingLock(key: string, limit: number): number {
    const window = counters.peek(key);
    return window !== undefined && window.count >= limit ? retryAfterSeconds(window) : 0;
  }

  return {
    assertNotLockedOut(email, ip) {
      const remaining = Math.max(
        remainingLock(`email:${email}`, MAX_ATTEMPTS_PER_EMAIL),
        remainingLock(`ip:${ip}`, MAX_ATTEMPTS_PER_IP),
      );

      if (remaining > 0) {
        throw new TooManyLoginAttemptsError(remaining);
      }
    },

    recordFailure(email, ip) {
      counters.hit(`email:${email}`, LOGIN_ATTEMPT_WINDOW_MS);
      counters.hit(`ip:${ip}`, LOGIN_ATTEMPT_WINDOW_MS);
    },

    clearEmail(email) {
      counters.clear(`email:${email}`);
    },
  };
}

const ROLE_SCOPES: Record<UserRole, readonly Scope[]> = {
  user: expandScopes(['write']),
  admin: expandScopes(['admin']),
};

export function scopesForRole(role: UserRole): readonly Scope[] {
  return ROLE_SCOPES[role];
}

export function canGrantScopes(role: UserRole, requested: readonly Scope[]): boolean {
  const held = scopesForRole(role);
  return expandScopes(requested).every((scope) => held.includes(scope));
}
