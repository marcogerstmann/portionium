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
  tooManyLoginAttempts: `${PROBLEM_NAMESPACE}/too-many-login-attempts`,
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
   * token, or ending a session. A token cannot issue its own successor, so a stolen one cannot
   * be turned into a fresh credential that outlives its revocation.
   */
  sessionRequired: `${PROBLEM_NAMESPACE}/session-required`,
  /**
   * A resource that is not there, or is not the caller's. One type for both, deliberately, so
   * a client cannot use the error to work out which ids exist. See
   * docs/adr/003-multi-user-authorization.md.
   */
  notFound: `${PROBLEM_NAMESPACE}/not-found`,
  mealHasNoItems: `${PROBLEM_NAMESPACE}/meal-has-no-items`,
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
