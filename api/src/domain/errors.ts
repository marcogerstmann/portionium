/**
 * Domain failures are values with a code, not strings. The code is what the transport layers
 * switch on, so an adapter never has to match on a message, and a reworded message is never a
 * behaviour change.
 *
 * Mapping these onto HTTP statuses happens in exactly one place, in http/problem.ts. Adding a
 * code here and not there is a compile error at that map, which is the point.
 */
export type DomainErrorCode =
  | 'meal_has_no_items'
  | 'implausible_weight'
  | 'invalid_credentials'
  | 'too_many_login_attempts'
  | 'unauthenticated'
  | 'insufficient_scope'
  | 'resource_not_found';

export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}

/**
 * Carries the one thing a client can act on: how long to wait. The base class has no room for
 * extra data on purpose, and this is the only failure so far that needs any, because a 429
 * without a Retry-After tells a caller to guess and they will guess wrong in both directions.
 *
 * Its message says nothing about which limit was reached, per email or per IP. Which one it was
 * is in the log, where the person reading it is entitled to know.
 */
export class TooManyLoginAttemptsError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('too_many_login_attempts', 'Too many failed sign in attempts. Try again later.');
    this.name = 'TooManyLoginAttemptsError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The one answer to every failed sign in. Wrong password, unknown address, deleted account:
 * one code, one message, one status, so the response body cannot be read as an answer to the
 * question "does this account exist".
 */
export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('invalid_credentials', 'Email or password is incorrect.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * No credential, or one that no longer resolves to anybody: expired, revoked, or belonging to
 * an account that has since been deleted. All four are one failure, because the caller's next
 * move is the same in every case, and because distinguishing them tells whoever is holding a
 * stolen token which kind of dead it is.
 */
export class UnauthenticatedError extends DomainError {
  constructor() {
    super('unauthenticated', 'Sign in to continue.');
    this.name = 'UnauthenticatedError';
  }
}

/**
 * A known caller who may not do this. The one place a 403 is correct: the request failed on
 * what the caller is allowed to do, not on what exists, so there is nothing to leak by saying
 * so. Ownership is the other case and it is deliberately not this one, see ResourceNotFound.
 */
export class InsufficientScopeError extends DomainError {
  constructor() {
    super('insufficient_scope', 'This account does not have access to that.');
    this.name = 'InsufficientScopeError';
  }
}

/**
 * A row that does not exist, or exists and belongs to somebody else. Deliberately one error
 * for both, so an answer never tells a caller that an id they guessed is real. See
 * docs/adr/003-multi-user-authorization.md, which is where that tradeoff is argued.
 *
 * Repositories filter by userId, so a foreign row simply does not come back, and a caller
 * raising this has no way to tell which of the two happened either.
 */
export class ResourceNotFoundError extends DomainError {
  constructor() {
    super('resource_not_found', 'The requested resource does not exist.');
    this.name = 'ResourceNotFoundError';
  }
}
