import { compileErrors, validate } from '@readme/openapi-parser';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp, DOCS_PATH, OPENAPI_PATH } from '../../src/http/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

/**
 * The application shell, exercised over app.inject() against the real Fastify instance and a
 * real migrated database. Nothing here is a stub, so a test passing means the wiring a
 * request goes through actually works.
 */

let open: { app: FastifyInstance; database: TestDatabase } | undefined;

/**
 * Builds the app and remembers it, so a test never has to remember to close it. `app.close()`
 * closes the database too, which is the behaviour one of the tests below is about.
 */
async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const database = createTestDatabase();
  // fatal keeps the request logging out of the test output without special casing the logger.
  const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal', ...env }), database });
  await app.ready();

  open = { app, database };
  return { app, database };
}

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

describe('health route', () => {
  it('answers the liveness probe', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('is not versioned, so a probe configured today survives v2', async () => {
    const { app } = await buildTestApp();

    expect((await app.inject({ url: `${API_PREFIX}/health` })).statusCode).toBe(404);
  });

  it('rejects a query parameter it does not declare', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ url: '/health?verbose=true' });

    expect(response.statusCode).toBe(400);
  });
});

describe('request validation', () => {
  /**
   * The route is defined here rather than shipped, because the shell has no endpoint that
   * takes a body yet. What is being tested is the validator wiring, not this route: any
   * route declaring a strict body schema gets the same 400.
   */
  async function buildAppWithBodyRoute() {
    const database = createTestDatabase();
    const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal' }), database });

    app.post(
      '/echo',
      { config: { auth: 'public' }, schema: { body: z.strictObject({ name: z.string() }) } },
      (request) => request.body,
    );
    await app.ready();

    open = { app, database };
    return app;
  }

  it('accepts a body that matches the schema', async () => {
    const app = await buildAppWithBodyRoute();

    const response = await app.inject({ method: 'POST', url: '/echo', payload: { name: 'oats' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: 'oats' });
  });

  it('rejects a property the body schema does not declare, rather than ignoring it', async () => {
    const app = await buildAppWithBodyRoute();

    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      payload: { name: 'oats', energyDensity: 'green' },
    });

    expect(response.statusCode).toBe(400);
    // The shape of that 400 is RFC 9457 Problem Details, see test/http/problem.test.ts.
    expect(response.json<{ type: string }>().type).toContain('validation-failed');
  });
});

/** Only the parts of the document the assertions below read. */
interface SpecDocument {
  openapi: string;
  paths: Record<
    string,
    { get: { responses: Record<string, { content: Record<string, { schema: unknown }> }> } }
  >;
}

describe('openapi document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const { app } = await buildTestApp();

    const document: unknown = (await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })).json();
    // validate() dereferences in place, so it gets a copy and the assertions below keep the
    // document the server actually served.
    const result = await validate(structuredClone(document) as Parameters<typeof validate>[0]);

    expect(result.valid, result.valid ? '' : compileErrors(result)).toBe(true);
  });

  it('describes the routes at the paths they are actually served from', async () => {
    const { app } = await buildTestApp();

    const document = (
      await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })
    ).json<SpecDocument>();

    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths).sort()).toEqual([
      `${API_PREFIX}/auth/login`,
      `${API_PREFIX}/auth/logout`,
      `${API_PREFIX}/auth/sessions`,
      `${API_PREFIX}/auth/sessions/{id}`,
      `${API_PREFIX}/auth/tokens`,
      `${API_PREFIX}/auth/tokens/{id}`,
      `${API_PREFIX}/days/{date}`,
      `${API_PREFIX}/foods`,
      `${API_PREFIX}/foods/search`,
      `${API_PREFIX}/foods/{id}`,
      `${API_PREFIX}/foods/{id}/classification`,
      `${API_PREFIX}/foods/{id}/classification/history`,
      `${API_PREFIX}/me`,
      `${API_PREFIX}/me/password`,
      `${API_PREFIX}/meals`,
      `${API_PREFIX}/meals/favourites`,
      `${API_PREFIX}/meals/favourites/{id}`,
      `${API_PREFIX}/meals/suggestions`,
      `${API_PREFIX}/meals/{id}`,
      `${API_PREFIX}/weight`,
      `${API_PREFIX}/weight/{date}`,
      '/health',
    ]);
  });

  it('generates the response schema from the Zod schema the route is serialized with', async () => {
    const { app } = await buildTestApp();

    const document = (
      await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })
    ).json<SpecDocument>();
    const ok = document.paths['/health']?.get.responses['200'];

    expect(ok?.content['application/json']?.schema).toMatchObject({
      type: 'object',
      // The literal, as JSON Schema draft 2020-12 spells one.
      properties: { status: { type: 'string', enum: ['ok'] } },
      required: ['status'],
    });
  });
});

describe('docs ui', () => {
  it('is served when API_DOCS_ENABLED is on', async () => {
    const { app } = await buildTestApp({ API_DOCS_ENABLED: 'true' });

    const response = await app.inject({ url: `${API_PREFIX}${DOCS_PATH}/` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('is gone when API_DOCS_ENABLED is off, while the document stays', async () => {
    const { app } = await buildTestApp({ API_DOCS_ENABLED: 'false' });

    expect((await app.inject({ url: `${API_PREFIX}${DOCS_PATH}/` })).statusCode).toBe(404);
    expect((await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })).statusCode).toBe(200);
  });
});

describe('shutdown', () => {
  it('releases the database when the app closes, so SIGTERM needs one call', async () => {
    const { app, database } = await buildTestApp();
    expect(database.db.$client.open).toBe(true);

    await app.close();
    open = undefined;

    expect(database.db.$client.open).toBe(false);
  });
});
