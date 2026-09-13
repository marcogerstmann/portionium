import { PROBLEM, type ProblemDetails } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { backoffMs, classifyAttempt } from './outbox';

/**
 * The judgement in the outbox, which is the part worth pinning down: whether a refusal is worth
 * retrying decides between a queue that never empties and a meal that is silently dropped.
 *
 * The queue mechanics around it need a real IndexedDB and arrive with the browser tests on
 * POR-43, see the scope note on POR-41.
 */

function problem(type: ProblemDetails['type'], status: number): ApiError {
  return new ApiError({
    type,
    title: 'Refused',
    status,
    detail: 'The server said no.',
    instance: '/api/v1/meals',
    requestId: 'req-1',
  });
}

describe('classifyAttempt', () => {
  it('retries anything that is not an answer from the API', () => {
    // What being offline looks like: fetch rejects, and nothing about this entry is wrong.
    expect(classifyAttempt(new TypeError('Failed to fetch'))).toBe('retry');
  });

  it('retries a server fault and a rate limit', () => {
    expect(classifyAttempt(problem(PROBLEM.internalError, 500))).toBe('retry');
    expect(classifyAttempt(problem(PROBLEM.rateLimited, 429))).toBe('retry');
  });

  it('retries a request the server is already handling', () => {
    expect(classifyAttempt(problem(PROBLEM.idempotencyRequestInProgress, 409))).toBe('retry');
  });

  it('treats a meal id conflict as already sent', () => {
    // The id was minted on this device, so the only thing that can hold it is an earlier
    // attempt at this same entry. Retrying would strand it in the queue forever.
    expect(classifyAttempt(problem(PROBLEM.mealIdConflict, 409))).toBe('sent');
  });

  it('pauses rather than fails when the session is gone', () => {
    expect(classifyAttempt(problem(PROBLEM.unauthenticated, 401))).toBe('paused');
  });

  it('gives up on a refusal about the content of the request', () => {
    expect(classifyAttempt(problem(PROBLEM.validationFailed, 400))).toBe('permanent');
    expect(classifyAttempt(problem(PROBLEM.idempotencyKeyMismatch, 422))).toBe('permanent');
    expect(classifyAttempt(problem(PROBLEM.unknownFoodReference, 422))).toBe('permanent');
    expect(classifyAttempt(problem(PROBLEM.notFound, 404))).toBe('permanent');
  });
});

describe('backoffMs', () => {
  it('doubles the wait with each failure', () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
  });

  it('stops doubling at the ceiling rather than growing without bound', () => {
    expect(backoffMs(30)).toBe(5 * 60 * 1_000);
    expect(backoffMs(300)).toBe(5 * 60 * 1_000);
  });

  it('does not wait less than the base, whatever it is handed', () => {
    expect(backoffMs(0)).toBe(1_000);
  });
});
