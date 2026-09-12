import { PROBLEM, problemDetailsSchema, type ProblemDetails } from '@portionium/schemas';
import type { z } from 'zod';

/**
 * The one place this client talks to the API.
 *
 * Every response is parsed with the schema the server produced it from, taken from
 * `@portionium/schemas`. There are no hand written request or response types here and there
 * will not be any: a field that is renamed on the server breaks the typecheck on this side in
 * the same commit, and a server that answers with something else fails here loudly rather than
 * handing a half shaped object to a component that renders `undefined`.
 *
 * Two things about credentials are deliberate and invisible in the code below.
 *
 * The session cookie is `HttpOnly`, so nothing here reads it, sets it or could leak it. The
 * browser attaches it because the request goes to the origin this app was served from, which is
 * also why `credentials` is same origin rather than `include`: a cross origin request from this
 * client is a bug, not a case to configure for.
 *
 * The CSRF check the API runs, `Origin` equal to WEB_ORIGIN, needs nothing from this file. A
 * browser sets that header itself on every request with a method that can change something,
 * same origin or not, and a page cannot forge it. Satisfying the check is therefore a matter of
 * being served from the origin the API is configured with, which in development is the Vite dev
 * server proxying /api here and in production is the API serving this bundle itself.
 */

/** Everything the API owns, written down once. A future v2 changes this line and no other. */
const API_PREFIX = '/api/v1';

/**
 * Where this module says the credential is dead, and the name it says it under.
 *
 * An event rather than a callback threaded through the app, because the thing that notices is a
 * fetch buried somewhere and the thing that reacts is the root component, and the outbox WEB 2
 * adds will be a third party to the same fact. Its own `EventTarget` rather than `window`, so
 * nothing outside this app can fire it and a test needs no DOM to hear it.
 *
 * Reacting means rendering the login screen. It deliberately does not mean clearing anything:
 * whatever is queued for sending is still the user's, and signing back in should send it rather
 * than ask them to type it all again.
 */
export const session = new EventTarget();

export const UNAUTHENTICATED_EVENT = 'portionium:unauthenticated';

/** A response that arrived, parsed, and said no. Carries the problem document verbatim. */
export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. Absent for a request that carries nothing. */
  body?: unknown;
}

/**
 * One call, validated on the way out of the wire and into the app.
 *
 * `schema` is the contract, so a caller passes the same constant the route declares. A 204
 * carries no body and is parsed as null, which is what `z.null()` is for at those call sites.
 */
export async function request<T extends z.ZodType>(
  path: string,
  schema: T,
  { method = 'GET', body }: RequestOptions = {},
): Promise<z.infer<T>> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    method,
    credentials: 'same-origin',
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });

  const payload: unknown = response.status === 204 ? null : await response.json();

  if (!response.ok) {
    const problem = problemDetailsSchema.parse(payload);

    // The session died, was signed out elsewhere, or expired while a phone was in a pocket.
    // Announced rather than handled here, see UNAUTHENTICATED_EVENT. Still thrown, because the
    // caller asked for something and did not get it.
    if (problem.type === PROBLEM.unauthenticated) {
      session.dispatchEvent(new Event(UNAUTHENTICATED_EVENT));
    }

    throw new ApiError(problem);
  }

  return schema.parse(payload);
}
