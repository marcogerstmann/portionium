import { PROBLEM, userResponseSchema } from '@portionium/schemas';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { ApiError, request, session, UNAUTHENTICATED_EVENT } from './api';

const USER = {
  id: '019627c8-0000-7000-8000-000000000001',
  email: 'ada@example.com',
  displayName: 'Ada',
  role: 'user',
  timezone: 'Europe/Berlin',
  dayBoundaryHour: 4,
};

function answer(status: number, payload: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

function problem(type: string, status: number) {
  return {
    type,
    title: 'No',
    status,
    detail: 'No.',
    instance: '/api/v1/me',
    requestId: 'req-1',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('parses a response with the schema the server produced it from', async () => {
  answer(200, USER);

  await expect(request('/me', userResponseSchema)).resolves.toEqual(USER);
});

test('a response the contract does not describe fails here rather than in a component', async () => {
  answer(200, { ...USER, dayBoundaryHour: 'four' });

  await expect(request('/me', userResponseSchema)).rejects.toThrow(z.ZodError);
});

test('a problem document is thrown whole, so a caller can branch on its type', async () => {
  answer(404, problem(PROBLEM.notFound, 404));

  await expect(request('/me', userResponseSchema)).rejects.toThrow(ApiError);
});

test('a dead session is announced once, and still throws', async () => {
  answer(401, problem(PROBLEM.unauthenticated, 401));
  const heard = vi.fn();
  session.addEventListener(UNAUTHENTICATED_EVENT, heard);

  await expect(request('/me', userResponseSchema)).rejects.toThrow(ApiError);
  expect(heard).toHaveBeenCalledTimes(1);

  session.removeEventListener(UNAUTHENTICATED_EVENT, heard);
});

test('a 204 has no body to parse', async () => {
  answer(204, null);

  await expect(request('/auth/logout', z.null(), { method: 'POST' })).resolves.toBeNull();
});
