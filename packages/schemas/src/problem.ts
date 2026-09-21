import { z } from 'zod';

export const PROBLEM_NAMESPACE = 'https://portionium.dev/problems';

export const PROBLEM = {
  unclassified: 'about:blank',
  validationFailed: `${PROBLEM_NAMESPACE}/validation-failed`,
  invalidCredentials: `${PROBLEM_NAMESPACE}/invalid-credentials`,
  invalidCurrentPassword: `${PROBLEM_NAMESPACE}/invalid-current-password`,
  tooManyLoginAttempts: `${PROBLEM_NAMESPACE}/too-many-login-attempts`,
  rateLimited: `${PROBLEM_NAMESPACE}/rate-limited`,
  unauthenticated: `${PROBLEM_NAMESPACE}/unauthenticated`,
  insufficientScope: `${PROBLEM_NAMESPACE}/insufficient-scope`,
  csrfOriginRejected: `${PROBLEM_NAMESPACE}/csrf-origin-rejected`,
  sessionRequired: `${PROBLEM_NAMESPACE}/session-required`,
  notFound: `${PROBLEM_NAMESPACE}/not-found`,
  idempotencyKeyMismatch: `${PROBLEM_NAMESPACE}/idempotency-key-mismatch`,
  idempotencyRequestInProgress: `${PROBLEM_NAMESPACE}/idempotency-request-in-progress`,
  mealHasNoEntries: `${PROBLEM_NAMESPACE}/meal-has-no-entries`,
  mealIdConflict: `${PROBLEM_NAMESPACE}/meal-id-conflict`,
  mealLoggedInFuture: `${PROBLEM_NAMESPACE}/meal-logged-in-future`,
  unknownFoodReference: `${PROBLEM_NAMESPACE}/unknown-food-reference`,
  mealFromIdWithEntries: `${PROBLEM_NAMESPACE}/meal-from-id-with-entries`,
  favouriteHasNoEntries: `${PROBLEM_NAMESPACE}/favourite-has-no-entries`,
  implausibleWeight: `${PROBLEM_NAMESPACE}/implausible-weight`,
  classifierUnavailable: `${PROBLEM_NAMESPACE}/classifier-unavailable`,
  notReady: `${PROBLEM_NAMESPACE}/not-ready`,
  internalError: `${PROBLEM_NAMESPACE}/internal-error`,
} as const;

export type ProblemType = (typeof PROBLEM)[keyof typeof PROBLEM];

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export const problemValidationErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

export type ProblemValidationError = z.infer<typeof problemValidationErrorSchema>;

export const problemDetailsSchema = z.object({
  type: z.enum(PROBLEM),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  requestId: z.string(),
  errors: z.array(problemValidationErrorSchema).optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
