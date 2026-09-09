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
  | 'csrf_origin_rejected'
  | 'session_required'
  | 'resource_not_found'
  | 'idempotency_key_mismatch'
  | 'idempotency_request_in_progress';

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
 * A mutating request that arrived on a session cookie from an origin this instance does not
 * serve, or from none at all.
 *
 * The cookie was valid and the browser was right to send it: a browser attaches cookies to a
 * cross site form post exactly as willingly as to a first party fetch, which is the whole of
 * CSRF. What a page cannot do is forge the `Origin` header, so that header is what decides,
 * and a request that omits it is refused rather than trusted. See WEB_ORIGIN in config.ts.
 *
 * Bearer requests never reach this. A token is not attached by a browser, so there is nothing
 * for a third party page to make the victim's browser do with one.
 */
export class CsrfOriginRejectedError extends DomainError {
  constructor() {
    super('csrf_origin_rejected', 'This request did not come from a recognised origin.');
    this.name = 'CsrfOriginRejectedError';
  }
}

/**
 * A valid API token asking for something only a signed in person may do: minting another token,
 * or ending a session.
 *
 * A token that could mint its own successor is a token whose revocation means nothing, because
 * whoever stole it made a fresh one before anybody noticed. Requiring a password typed into a
 * browser to create the next credential is the cheapest way to make revocation final.
 */
export class SessionRequiredError extends DomainError {
  constructor() {
    super('session_required', 'This action requires a signed in session, not an API token.');
    this.name = 'SessionRequiredError';
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

/**
 * An `Idempotency-Key` this user already sent, attached to a request that asks for something
 * else: a different method, path or body. The stored answer belongs to the first request and
 * would be a wrong answer to this one, so neither is given. A client that reuses keys across
 * distinct operations has a bug, and this is the message that says so.
 */
export class IdempotencyKeyMismatchError extends DomainError {
  constructor() {
    super(
      'idempotency_key_mismatch',
      'This Idempotency-Key was already used for a different request.',
    );
    this.name = 'IdempotencyKeyMismatchError';
  }
}

/**
 * The first request carrying this key has not finished. Two copies of one request arrived
 * close enough together that the second found the key claimed and the answer not yet written.
 * The client retries after the first one completes and gets its stored response.
 */
export class IdempotencyRequestInProgressError extends DomainError {
  constructor() {
    super(
      'idempotency_request_in_progress',
      'A request with this Idempotency-Key is still being processed. Retry shortly.',
    );
    this.name = 'IdempotencyRequestInProgressError';
  }
}
