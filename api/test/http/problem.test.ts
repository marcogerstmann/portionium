import { PROBLEM, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseConfig } from '../../src/config.js';
import { DomainError } from '../../src/domain/errors.js';
import { API_PREFIX, buildApp, OPENAPI_PATH } from '../../src/http/app.js';
import { problemResponses } from '../../src/http/problem.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

/**
 * Error handling, over the real app. Every route below is declared inside the test rather
 * than shipped, because the shell has no endpoint yet that takes a body or throws. What is
 * under test is the handler in src/http/problem.ts, not any route: a route is only the
 * shortest way to make each kind of failure actually happen inside Fastify.
 */

let open: { app: FastifyInstance; database: TestDatabase } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

/**
 * Builds the app and adds the routes each test needs to provoke a failure. `fatal` keeps the
 * expected stack traces out of the test output.
 */
async function buildTestApp() {
  const database = createTestDatabase();
  const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal' }), database });

  app.post(
    '/echo',
    {
      // Public, like every route in this file: what is under test is how a failure is
      // rendered, and a credential check in front of it would only add a way for these tests
      // to fail for a reason that has nothing to do with the error handler.
      config: { auth: 'public' },
      schema: {
        body: z.strictObject({ name: z.string(), portions: z.int().positive() }),
        response: { 200: z.object({ name: z.string() }), ...problemResponses },
      },
    },
    (request) => ({ name: (request.body as { name: string }).name }),
  );

  app.get('/domain-failure', { config: { auth: 'public' } }, () => {
    throw new DomainError('meal_has_no_items', 'A meal must contain at least one item.');
  });

  app.get(
    '/bug',
    { config: { auth: 'public' }, schema: { response: { ...problemResponses } } },
    () => {
      throw new Error('connection string was postgres://admin:hunter2@internal');
    },
  );

  await app.ready();

  open = { app, database };
  return app;
}

/** Every problem is parsed with the schema the client would parse it with. */
function readProblem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

describe('problem details', () => {
  it('answers a validation failure with the field paths taken from the Zod error', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 42, portions: -1 },
    });

    expect(response.statusCode).toBe(400);
    const problem = readProblem(response.payload);
    expect(problem.type).toBe(PROBLEM.validationFailed);
    expect(problem.status).toBe(400);
    expect(problem.errors).toEqual([
      { path: '/name', message: expect.any(String) as string },
      { path: '/portions', message: expect.any(String) as string },
    ]);
  });

  it('names the undeclared property, and points at the payload rather than a field', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 'oats', portions: 1, energyDensity: 'green' },
    });

    expect(response.statusCode).toBe(400);
    const [issue] = readProblem(response.payload).errors ?? [];
    expect(issue?.message).toContain('energyDensity');
    // The whole document, as RFC 6901 spells it. The key that was rejected is not a path
    // into the request, because the request has no such field.
    expect(issue?.path).toBe('');
  });

  it('is served as application/problem+json, which is what RFC 9457 defines', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ url: '/health?verbose=true' });

    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });

  it('carries every member of the RFC on every error', async () => {
    const app = await buildTestApp();

    const problem = readProblem((await app.inject({ url: '/health?verbose=true' })).payload);

    expect(problem).toMatchObject({
      type: expect.any(String) as string,
      title: expect.any(String) as string,
      status: 400,
      detail: expect.any(String) as string,
      instance: '/health?verbose=true',
      requestId: expect.any(String) as string,
    });
  });

  it('maps a domain error to its own type and a 422, without the domain knowing the status', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ url: '/domain-failure' });

    expect(response.statusCode).toBe(422);
    expect(readProblem(response.payload)).toMatchObject({
      type: PROBLEM.mealHasNoItems,
      status: 422,
      // The domain's own message, which is written to be read by a person.
      detail: 'A meal must contain at least one item.',
    });
  });

  it('answers an unexpected exception with a generic 500 that leaks nothing', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ url: '/bug' });

    expect(response.statusCode).toBe(500);
    const problem = readProblem(response.payload);
    expect(problem.type).toBe(PROBLEM.internalError);
    // Not the message, not the stack, not the thing the message happened to contain.
    expect(response.payload).not.toContain('hunter2');
    expect(response.payload).not.toContain('postgres://');
    expect(problem.detail).toContain('request id');
  });

  it('answers an unknown route with a problem too, rather than Fastify default', async () => {
    const app = await buildTestApp();

    const response = await app.inject({ url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(readProblem(response.payload)).toMatchObject({
      type: PROBLEM.unclassified,
      title: 'Not Found',
      status: 404,
    });
  });

  it('answers a framework level rejection as about:blank, with its status phrase', async () => {
    const app = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ this is not json',
    });

    expect(response.statusCode).toBe(400);
    expect(readProblem(response.payload)).toMatchObject({
      type: PROBLEM.unclassified,
      title: 'Bad Request',
      status: 400,
    });
  });

  it('gives each failure its own request id, which is the id it was logged under', async () => {
    const app = await buildTestApp();

    const first = readProblem((await app.inject({ url: '/bug' })).payload);
    const second = readProblem((await app.inject({ url: '/bug' })).payload);

    // Fastify generates these and does not take them from a request header, so a client
    // cannot poison the logs by choosing its own. Two reports of the same broken endpoint
    // therefore point at two different log lines.
    expect(first.requestId).not.toBe(second.requestId);
    expect(first.requestId).not.toHaveLength(0);
  });
});

/** Only the parts of the document the assertions below read. */
interface SpecDocument {
  paths: Record<
    string,
    {
      get: {
        responses: Record<
          string,
          { description?: string; content: Record<string, { schema: { properties?: unknown } }> }
        >;
      };
    }
  >;
}

describe('problem details in the openapi document', () => {
  async function fetchSpec(app: FastifyInstance) {
    return (await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })).json<SpecDocument>();
  }

  it('documents every declared problem type, so a client can enumerate what it must handle', async () => {
    const app = await buildTestApp();

    const document = await fetchSpec(app);
    const schema = document.paths['/health']?.get.responses['400']?.content[PROBLEM_CONTENT_TYPE]
      ?.schema as { properties: { type: { enum: string[] } } };

    expect([...schema.properties.type.enum].sort()).toEqual([...Object.values(PROBLEM)].sort());
  });

  it('describes the error responses under the media type they are actually sent with', async () => {
    const app = await buildTestApp();

    const responses = (await fetchSpec(app)).paths['/health']?.get.responses;

    expect(Object.keys(responses ?? {}).sort()).toEqual(['200', '400', '429', '500']);
    expect(responses?.['500']?.content[PROBLEM_CONTENT_TYPE]).toBeDefined();
  });
});
