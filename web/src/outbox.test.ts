import 'fake-indexeddb/auto';

import { PROBLEM, type ProblemDetails, type UserResponse } from '@portionium/schemas';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError } from './api';
import { database, localDateFor } from './db';
import {
  backoffMs,
  classifyAttempt,
  correctWeight,
  instantFor,
  removeWeight,
  weightSubject,
} from './outbox';

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

    expect(instant.getTime()).toBeGreaterThanOrEqual(before);
    expect(instant.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('places a weight recorded for a past date inside that date, not on whatever today is', () => {
    const past = '2026-01-15';

    const instant = instantFor(past, 'Europe/Berlin', 4);

    expect(localDateFor(instant, 'Europe/Berlin', 4)).toBe(past);
  });

  it('holds across a DST change, since the boundary hour resolves back whichever offset is in force', () => {
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

const user: UserResponse = {
  id: '01930000-0000-7000-8000-0000000000ff',
  email: 'weight-test@example.com',
  displayName: 'Weight test',
  role: 'user',
  timezone: 'Europe/Berlin',
  dayBoundaryHour: 4,
  locale: null,
};
const date = '2026-09-13';

globalThis.fetch = () => Promise.reject(new Error('no network in a unit test'));

describe('correctWeight', () => {
  afterEach(async () => {
    await database.outbox.clear();
  });

  it('queues a delete and a post when the reading being corrected has already drained', async () => {
    await correctWeight(user, 74.5, date);

    const queued = await database.outbox.orderBy('key').toArray();

    expect(queued.map((entry) => entry.method ?? 'POST')).toEqual(['DELETE', 'POST']);
    expect(queued[0]).toMatchObject({ path: `/weight/${date}`, subject: weightSubject(date) });
    expect(queued[1]).toMatchObject({
      path: '/weight',
      subject: weightSubject(date),
      body: { weightKg: 74.5 },
    });
  });

  it('rewrites the queued body and queues nothing new for a reading that has not drained yet', async () => {
    await database.outbox.add({
      key: '01930000-0000-7000-8000-000000000001',
      path: '/weight',
      method: 'POST',
      date,
      subject: weightSubject(date),
      body: { weightKg: 70, recordedAt: '2026-09-13T06:00:00.000Z' },
      attempts: 0,
      nextAttemptAt: 0,
      failure: null,
    });

    await correctWeight(user, 74.5, date);

    const queued = await database.outbox.orderBy('key').toArray();

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      key: '01930000-0000-7000-8000-000000000001',
      method: 'POST',
      body: { weightKg: 74.5 },
    });
  });
});

describe('removeWeight', () => {
  afterEach(async () => {
    await database.outbox.clear();
  });

  it('queues a delete', async () => {
    await removeWeight(date);

    const queued = await database.outbox.orderBy('key').toArray();

    expect(queued).toMatchObject([
      { method: 'DELETE', path: `/weight/${date}`, subject: weightSubject(date) },
    ]);
  });
});
