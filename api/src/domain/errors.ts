export type DomainErrorCode =
  | 'meal_has_no_entries'
  | 'meal_id_conflict'
  | 'meal_logged_in_future'
  | 'meal_from_id_with_entries'
  | 'favourite_has_no_entries'
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
  | 'idempotency_key_mismatch'
  | 'idempotency_request_in_progress'
  | 'classifier_unavailable'
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

export class ThrottledError extends DomainError {
  readonly retryAfterSeconds: number;

  constructor(code: DomainErrorCode, message: string, retryAfterSeconds: number) {
    super(code, message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

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

export class RateLimitedError extends ThrottledError {
  constructor(retryAfterSeconds: number) {
    super('rate_limited', 'Too many requests. Slow down and try again.', retryAfterSeconds);
    this.name = 'RateLimitedError';
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor() {
    super('invalid_credentials', 'Email or password is incorrect.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * Not InvalidCredentialsError: a 401 on an authenticated request signs the user out, which is the
 * wrong answer to a mistyped field.
 */
export class InvalidCurrentPasswordError extends DomainError {
  constructor() {
    super('invalid_current_password', 'The current password is incorrect.');
    this.name = 'InvalidCurrentPasswordError';
  }
}

export class UnauthenticatedError extends DomainError {
  constructor() {
    super('unauthenticated', 'Sign in to continue.');
    this.name = 'UnauthenticatedError';
  }
}

export class InsufficientScopeError extends DomainError {
  constructor() {
    super('insufficient_scope', 'This account does not have access to that.');
    this.name = 'InsufficientScopeError';
  }
}

export class CsrfOriginRejectedError extends DomainError {
  constructor() {
    super('csrf_origin_rejected', 'This request did not come from a recognised origin.');
    this.name = 'CsrfOriginRejectedError';
  }
}

export class SessionRequiredError extends DomainError {
  constructor() {
    super('session_required', 'This action requires a signed in session, not an API token.');
    this.name = 'SessionRequiredError';
  }
}

/**
 * One error for missing and for foreign, so an answer never confirms that a guessed id is real. See
 * docs/adr/003-multi-user-authorization.md.
 */
export class ResourceNotFoundError extends DomainError {
  constructor() {
    super('resource_not_found', 'The requested resource does not exist.');
    this.name = 'ResourceNotFoundError';
  }
}

export class IdempotencyKeyMismatchError extends DomainError {
  constructor() {
    super(
      'idempotency_key_mismatch',
      'This Idempotency-Key was already used for a different request.',
    );
    this.name = 'IdempotencyKeyMismatchError';
  }
}

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
 * Its own type rather than a 500: an instance with no key is working correctly, and the composer
 * hides the row instead of showing an error beside a search that answers.
 */
export class ClassifierUnavailableError extends DomainError {
  constructor() {
    super('classifier_unavailable', 'No colour could be suggested for this. Pick one yourself.');
    this.name = 'ClassifierUnavailableError';
  }
}

export class NotReadyError extends DomainError {
  constructor() {
    super('not_ready', 'This instance is not ready to serve requests.');
  }
}
