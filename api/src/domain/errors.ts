/**
 * Domain failures are values with a code, not strings. The code is what the transport layers
 * switch on, so an adapter never has to match on a message, and a reworded message is never a
 * behaviour change.
 *
 * Mapping these onto HTTP statuses happens in exactly one place, in http/problem.ts. Adding a
 * code here and not there is a compile error at that map, which is the point.
 */
export type DomainErrorCode = 'meal_has_no_items' | 'implausible_weight';

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
