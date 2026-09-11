import { z } from 'zod';

/**
 * Errors on the wire, as RFC 9457 Problem Details. Every non 2xx response this API produces
 * has this shape, served as `application/problem+json`.
 *
 * It lives here rather than in the API because `type` is what a client branches on. The web
 * app narrows an error response with the same definition the server produced it from, so a
 * problem type that is renamed or removed breaks the typecheck on both sides in one commit.
 *
 * What maps onto which status code is not here. That is a transport decision and it lives in
 * exactly one place, api/src/http/problem.ts.
 */

/**
 * The namespace every problem type is minted under. It does not resolve to a page yet, and it
 * does not have to: RFC 9457 asks for a stable identifier, not a live document. It is a domain
 * we control, so it can grow a page later without any client having to change.
 */
export const PROBLEM_NAMESPACE = 'https://portionium.dev/problems';

/**
 * Every problem type this API can answer with. The URIs are written out rather than assembled
 * from the namespace, so the string a client receives is the string this repository can be
 * grepped for.
 *
 * `about:blank` is the one the RFC itself defines, for a response that carries no more meaning
 * than its status code already does. A 415 from the framework is that. Anything a client would
 * reasonably want to branch on gets its own URI instead.
 */
export const PROBLEM = {
  unclassified: 'about:blank',
  validationFailed: `${PROBLEM_NAMESPACE}/validation-failed`,
  invalidCredentials: `${PROBLEM_NAMESPACE}/invalid-credentials`,
  /**
   * The current password sent with a password change did not match. Separate from
   * invalidCredentials, which is a 401 and tells a client its credential is dead: this request
   * arrived on a perfectly good session and a client that reacted to it by signing the user
   * out would be reacting to a typo in a form field.
   */
  invalidCurrentPassword: `${PROBLEM_NAMESPACE}/invalid-current-password`,
  tooManyLoginAttempts: `${PROBLEM_NAMESPACE}/too-many-login-attempts`,
  /**
   * Too many requests, per credential or per address. Separate from the login lockout so a
   * client can tell "wait and retry the same call" apart from "this account is being locked
   * out". Both carry `Retry-After`, which is the field to obey rather than a backoff guess.
   */
  rateLimited: `${PROBLEM_NAMESPACE}/rate-limited`,
  unauthenticated: `${PROBLEM_NAMESPACE}/unauthenticated`,
  insufficientScope: `${PROBLEM_NAMESPACE}/insufficient-scope`,
  /**
   * A mutating request that arrived on a session cookie without an Origin this instance
   * recognises. The browser attached the cookie because browsers always do, which is the whole
   * of CSRF, so the header rather than the cookie is what decides it.
   */
  csrfOriginRejected: `${PROBLEM_NAMESPACE}/csrf-origin-rejected`,
  /**
   * A valid API token asking for something only a signed in person may do: minting another
   * token, ending a session, or changing the password. A token cannot issue its own successor,
   * so a stolen one cannot be turned into a fresh credential that outlives its revocation, and
   * it cannot lock its owner out of the account it was issued limited access to.
   */
  sessionRequired: `${PROBLEM_NAMESPACE}/session-required`,
  /**
   * A resource that is not there, or is not the caller's. One type for both, deliberately, so
   * a client cannot use the error to work out which ids exist. See
   * docs/adr/003-multi-user-authorization.md.
   */
  notFound: `${PROBLEM_NAMESPACE}/not-found`,
  /**
   * An Idempotency-Key the caller already used, sent with a different method, path or body.
   * The stored answer belongs to another request, so neither it nor a fresh execution is given.
   */
  idempotencyKeyMismatch: `${PROBLEM_NAMESPACE}/idempotency-key-mismatch`,
  /**
   * The first request carrying this Idempotency-Key has not finished yet. Retry once it has
   * and the stored response comes back.
   */
  idempotencyRequestInProgress: `${PROBLEM_NAMESPACE}/idempotency-request-in-progress`,
  /**
   * A food that at least one meal names. It is not deleted, because a meal pointing at a row
   * nothing returns is a history with holes in it. Rename it instead.
   */
  foodInUse: `${PROBLEM_NAMESPACE}/food-in-use`,
  mealHasNoItems: `${PROBLEM_NAMESPACE}/meal-has-no-items`,
  /** A client supplied a meal id that already belongs to a row. Retry with a new one. */
  mealIdConflict: `${PROBLEM_NAMESPACE}/meal-id-conflict`,
  /**
   * `loggedAt` sits further into the future than clock skew accounts for. Backdating is always
   * allowed, this is the one direction a meal cannot move.
   */
  mealLoggedInFuture: `${PROBLEM_NAMESPACE}/meal-logged-in-future`,
  /** An item named a food id the catalog has no live entry for. */
  unknownFoodReference: `${PROBLEM_NAMESPACE}/unknown-food-reference`,
  implausibleWeight: `${PROBLEM_NAMESPACE}/implausible-weight`,
  internalError: `${PROBLEM_NAMESPACE}/internal-error`,
} as const;

export type ProblemType = (typeof PROBLEM)[keyof typeof PROBLEM];

/**
 * The media type RFC 9457 defines. Responses are sent with it, and the OpenAPI document
 * declares it, so a client that content negotiates gets told the truth.
 */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/**
 * One failed field. `path` is the JSON Pointer the validator produced, so `/items/0/quantity`
 * addresses the offending value inside the request exactly as RFC 6901 spells it. It is taken
 * from the Zod issue rather than rewritten, because a path that is reformatted by hand is a
 * path that can be wrong.
 */
export const problemValidationErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ProblemValidationError = z.infer<typeof problemValidationErrorSchema>;

/**
 * The RFC leaves every member optional. This API sends all five on every error anyway: a
 * client that has to check whether `title` is there is a client with two code paths for one
 * response, and the field that gets omitted is always the one someone needed.
 *
 * `requestId` and `errors` are extension members, which the RFC allows and expects.
 */
export const problemDetailsSchema = z.object({
  /** Stable identifier for the kind of failure. The only field worth branching on. */
  type: z.enum(PROBLEM),
  /** Human readable, the same for every occurrence of this type. */
  title: z.string(),
  /** Repeated from the status line, so a logged or forwarded body still says what happened. */
  status: z.int().min(400).max(599),
  /** Human readable and specific to this occurrence. Safe to show a user, never a stack. */
  detail: z.string(),
  /** The request this happened to. */
  instance: z.string(),
  /**
   * The id of the request that failed, which is also the id on the server side log line. It is
   * what turns "it broke yesterday" into a single log lookup, so it is on every error whether
   * or not anything was logged for it.
   */
  requestId: z.string(),
  /** Present on a validation failure and nowhere else. */
  errors: z.array(problemValidationErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
