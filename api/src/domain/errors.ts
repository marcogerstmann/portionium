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
  | 'meal_id_conflict'
  | 'meal_logged_in_future'
  | 'meal_from_id_with_items'
  | 'favourite_has_no_items'
  | 'unknown_food_reference'
  | 'implausible_weight'
  | 'invalid_credentials'
  | 'invalid_current_password'
  | 'too_many_login_attempts'
  | 'rate_limited'
  | 'unauthenticated'
  | 'insufficient_scope'
  | 'csrf_origin_rejected'
  | 'session_required'
  | 'resource_not_found'
  | 'food_in_use'
  | 'idempotency_key_mismatch'
  | 'idempotency_request_in_progress'
  | 'not_ready';

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
 * extra data on purpose, and these two are the only failures that need any, because a 429
 * without a Retry-After tells a caller to guess and they will guess wrong in both directions.
 *
 * http/problem.ts turns this one field into the header, for anything that extends this, so a
 * third throttle cannot ship a 429 that forgot it.
 */
export class ThrottledError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(code: DomainErrorCode, message: string, retryAfterSeconds: number) {
    super(code, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Too many failed sign in attempts for this address or from this IP.
 *
 * Its message says nothing about which limit was reached, per email or per IP. Which one it was
 * is in the log, where the person reading it is entitled to know.
 */
export class TooManyLoginAttemptsError extends ThrottledError {
  constructor(retryAfterSeconds: number) {
    super(
      'too_many_login_attempts',
      'Too many failed sign in attempts. Try again later.',
      retryAfterSeconds,
    );
    this.name = 'TooManyLoginAttemptsError';
  }
}

/**
 * Too many requests from one credential or one address. Distinct from the login lockout, which
 * counts failures rather than requests and is about guessing a password rather than about load,
 * so a client can tell "slow down" apart from "you are being locked out".
 */
export class RateLimitedError extends ThrottledError {
  constructor(retryAfterSeconds: number) {
    super('rate_limited', 'Too many requests. Slow down and try again.', retryAfterSeconds);
    this.name = 'RateLimitedError';
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
 * The current password sent with a password change was wrong.
 *
 * Not InvalidCredentialsError, and the distinction is the whole reason this exists. That one
 * is a 401, which every sensible client reads as "your session is over" and reacts to by
 * throwing the user back to the sign in form. Here the session is fine and one field of a form
 * was mistyped, so the answer says the caller may not do this rather than that they are nobody.
 */
export class InvalidCurrentPasswordError extends DomainError {
  constructor() {
    super('invalid_current_password', 'The current password is incorrect.');
    this.name = 'InvalidCurrentPasswordError';
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
 * ending a session, or changing the password.
 *
 * A token that could mint its own successor is a token whose revocation means nothing, because
 * whoever stole it made a fresh one before anybody noticed. Requiring a password typed into a
 * browser to create the next credential is the cheapest way to make revocation final.
 *
 * The password change is here for the same reason read backwards. A token is a credential
 * issued to a script, and a script that can change the password can lock its owner out of the
 * account it was given limited access to, which is a stolen token turned into a takeover.
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
 * A catalog entry somebody has already eaten. Deleting it would leave every meal that names it
 * pointing at a row no read path returns, so a history that was correct when it was written
 * would quietly develop holes.
 *
 * Not a 404 and not a permission failure: the food is there, the caller may well be allowed to
 * remove it, and the answer is that this particular one cannot go. Renaming it is the way out,
 * which is why PATCH does not care how often a food has been eaten.
 */
export class FoodInUseError extends DomainError {
  constructor() {
    super('food_in_use', 'This food is used by a meal and cannot be deleted.');
    this.name = 'FoodInUseError';
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

/**
 * This instance cannot serve requests. Raised by the readiness probe alone, never by a route
 * doing work: a request that fails because the database has gone away is a 500 with a stack in
 * the log, which is the honest answer to an unexpected failure.
 *
 * The message is deliberately all a caller is told. Why it is not ready names the database path
 * and the schema version, which is configuration, so it goes to the log instead. See
 * databaseNotReadyReason in db/client.ts.
 */
export class NotReadyError extends DomainError {
  constructor() {
    super('not_ready', 'This instance is not ready to serve requests.');
  }
}
