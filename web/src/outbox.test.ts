import { PROBLEM, type ProblemDetails } from '@portionium/schemas';
import { describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { localDateFor } from './db';
import { backoffMs, classifyAttempt, instantFor } from './outbox';

/**
 * Two things worth pinning down without a browser: whether a refusal is worth retrying, which
 * decides between a queue that never empties and a meal that is silently dropped, and what
 * instant a write for a past day gets stamped with, which is what POR-62 fixed.
 *
 * The queue mechanics around both, the actual enqueue and drain over IndexedDB, need a real one
 * and arrive with the browser tests on POR-43, see the scope note on POR-41.
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

describe('instantFor', () => {
  it('leaves a meal logged for today stamped with the current instant', () => {
    const today = localDateFor(new Date(), 'Europe/Berlin', 4);
    const before = Date.now();

    const instant = instantFor(today, 'Europe/Berlin', 4);

    // Not reconstructed: the real clock, bracketed rather than pinned to a value that would be
    // flaky by the time this assertion runs.
    expect(instant.getTime()).toBeGreaterThanOrEqual(before);
    expect(instant.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('places a weight recorded for a past date inside that date, not on whatever today is', () => {
    const past = '2026-01-15';

    const instant = instantFor(past, 'Europe/Berlin', 4);

    expect(localDateFor(instant, 'Europe/Berlin', 4)).toBe(past);
  });

  it('holds across a DST change, since the boundary hour resolves back whichever offset is in force', () => {
    // Europe/Berlin is +01:00 in January and +02:00 in July.
    expect(localDateFor(instantFor('2026-01-15', 'Europe/Berlin', 4), 'Europe/Berlin', 4)).toBe(
      '2026-01-15',
    );
    expect(localDateFor(instantFor('2026-07-15', 'Europe/Berlin', 4), 'Europe/Berlin', 4)).toBe(
      '2026-07-15',
    );
  });

  it('holds for a zone west of UTC and a boundary at midnight', () => {
    const past = '2026-03-01';

    expect(localDateFor(instantFor(past, 'America/New_York', 0), 'America/New_York', 0)).toBe(past);
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
