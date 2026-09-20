import { PROBLEM, problemDetailsSchema, type ProblemDetails } from '@portionium/schemas';
import type { z } from 'zod';

const API_PREFIX = '/api/v1';

export const session = new EventTarget();

export const UNAUTHENTICATED_EVENT = 'portionium:unauthenticated';

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
}

export async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  { method = 'GET', body, idempotencyKey }: RequestOptions = {},
): Promise<z.infer<T>> {
  const headers: Record<string, string> = {};

  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  if (idempotencyKey !== undefined) {
    headers['idempotency-key'] = idempotencyKey;
  }

  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const payload: unknown = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    const problem = problemDetailsSchema.parse(payload);

    // `detail` is written to be shown to a person and is the only part safe to put on screen.
    if (problem.type === PROBLEM.unauthenticated) {
      session.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }

    throw new ApiError(problem);
  }

  return schema.parse(payload);
}
