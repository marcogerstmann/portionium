import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PROBLEM, type ProblemDetails } from '@portionium/schemas';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseConfig } from '../../src/config.js';
import { userTable, weightEntryTable } from '../../src/db/schema/index.js';
import { ResourceNotFoundError } from '../../src/domain/errors.js';
import { API_PREFIX, buildApp, DOCS_PATH } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME, UNANNOTATED_PUBLIC_PREFIXES } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';

/**
 * Who a request is from, and what that lets it do. Over the real app, a real database and real
 * session rows, because every part of this that could go wrong is a wiring mistake rather than
 * an arithmetic one.
 *
 * The routes below are declared in the test rather than shipped. No endpoint yet reads a row
 * that belongs to somebody, so the ownership rules would otherwise have nothing to be asserted
 * against until the first one arrives, which is the wrong time to find out they do not hold.
 */

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

/**
 * Three routes: one any signed in caller may have, one only an administrator may, and one that
 * reads an owned row the way every repository in this codebase does, by id and owner together.
 * That last one is the whole of the 404 rule: a row belonging to somebody else does not come
 * back from the query, so there is no branch anywhere that could have answered 403 instead.
 */
async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', ...env }),
    database: fixtures,
  });

  app.get('/who', { config: { auth: 'account' } }, (request) => request.auth);

  app.get('/admin-only', { config: { auth: 'admin' } }, () => ({ ok: true }));

  app.get(
    '/mine/:id',
    { config: { auth: 'account' }, schema: { params: z.object({ id: z.string() }) } },
    (request) => {
      // buildApp returns a plain FastifyInstance, so the type provider that would infer this
      // from the schema above does not reach a route declared out here.
      const { id } = request.params as { id: string };

      // The caller comes from the context and the id from the URL, never the other way round.
      const row = fixtures.db
        .select()
        .from(weightEntryTable)
        .where(and(eq(weightEntryTable.id, id), eq(weightEntryTable.userId, request.auth.userId)))
        .get();

      if (row === undefined) {
        throw new ResourceNotFoundError();
      }

      return { id: row.id };
    },
  );

  // Writes to the context, attempted from inside a handler the way a bug or a compromised
  // dependency would. Both are expected to fail, see the assertions at the bottom of the file.
  app.get('/tamper', { config: { auth: 'account' } }, (request) => {
    const replaced = attempt(() => {
      (request as { auth: unknown }).auth = { userId: 'someone-else' };
    });
    const edited = attempt(() => {
      (request.auth as { userId: string }).userId = 'someone-else';
    });

    return { replaced, edited, userId: request.auth.userId };
  });

  // A public route reading a context it has no business having.
  app.get('/peek', { config: { auth: 'public' } }, (request) => ({ id: request.auth.userId }));

  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

/**
 * The application exactly as it ships, with none of the routes above. The audit below is about
 * what this repository exposes, so a route a test invented would be a false entry in it.
 */
async function buildShippedApp(env: NodeJS.ProcessEnv = {}) {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', ...env }),
    database: fixtures,
  });
  await app.ready();

  open = { app, fixtures };
  return app;
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

describe('the public surface', () => {
  /**
   * The allowlist the ticket asks for, and the only place it exists. Every other route in the
   * application is authenticated, so widening this is a line in this file rather than one word
   * on a route that nobody reviews twice.
   */
  const PUBLIC = ['GET /health', 'POST /api/v1/auth/login', 'GET /api/v1/openapi.json'];

  it('is exactly the three endpoints that cannot require a credential', async () => {
    const app = await buildShippedApp({ API_DOCS_ENABLED: 'false' });

    expect([...app.publicRoutes].sort()).toEqual([...PUBLIC].sort());
  });

  it('adds nothing beyond the documentation UI when that is switched on', async () => {
    const app = await buildShippedApp({ API_DOCS_ENABLED: 'true' });

    const extra = [...app.publicRoutes].filter((route) => !PUBLIC.includes(route));

    expect(extra.length).toBeGreaterThan(0);
    for (const route of extra) {
      expect(route).toContain(`${API_PREFIX}${DOCS_PATH}`);
    }
  });

  it('exempts the documentation prefix the app actually serves that UI from', () => {
    // The plugin spells the prefix out rather than importing it, because app.ts imports the
    // plugin. This is what keeps the two spellings from drifting apart.
    expect(UNANNOTATED_PUBLIC_PREFIXES).toContain(`${API_PREFIX}${DOCS_PATH}`);
  });

  it('refuses to boot when a route says nothing about who may call it', async () => {
    const fixtures = createTestFixtures();
    const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal' }), database: fixtures });
    open = { app, fixtures };

    expect(() => app.get('/forgotten', () => ({}))).toThrow(/declares no auth/);
  });
});

describe('establishing who is calling', () => {
  it('resolves a bearer token into a context carrying the id, role and scopes', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: '/who',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: fixtures.userA.id,
      role: 'user',
      scopes: ['account'],
    });
  });

  it('resolves the same session from a cookie, which is what a browser will send', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: '/who',
      headers: { cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ userId: string }>().userId).toBe(fixtures.userA.id);
  });

  it('gives an administrator every scope a user has, and one more', async () => {
    const { app, fixtures } = await buildTestApp();
    const admin = fixtures.create.user({ role: 'admin' });
    const token = fixtures.create.session(admin);

    const response = await app.inject({
      url: '/who',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.json<{ scopes: string[] }>().scopes).toEqual(['account', 'admin']);
  });
});

describe('refusing a request', () => {
  it('answers 401 when no credential was sent at all', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ url: '/who' });

    expect(response.statusCode).toBe(401);
    expect(problem(response.payload).type).toBe(PROBLEM.unauthenticated);
  });

  it.each([
    ['a token nobody issued', 'not-a-real-token'],
    ['an empty bearer header', ''],
  ])('answers 401 for %s', async (_name, token) => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      url: '/who',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('answers 401 once the session has expired, without deleting anything', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA, {
      expiresAt: new Date(Date.now() - 1000),
    });

    expect(
      (await app.inject({ url: '/who', headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(401);
  });

  it('answers 401 for a live session whose account has since been deleted', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    fixtures.db
      .update(userTable)
      .set({ deletedAt: new Date() })
      .where(eq(userTable.id, fixtures.userA.id))
      .run();

    expect(
      (await app.inject({ url: '/who', headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(401);
  });

  it('answers 403 when the caller is known and the scope is not theirs', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: '/admin-only',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.insufficientScope);
  });

  it('says nothing about the account in the body of either refusal', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const refused = await app.inject({
      url: '/admin-only',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(refused.payload).not.toContain(fixtures.userA.email);
    expect(refused.payload).not.toContain(fixtures.userA.id);
  });
});

describe("another user's row", () => {
  it('answers 404 rather than 403, so an id cannot be probed for existence', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const theirs = fixtures.create.weightEntry(fixtures.userB);

    const foreign = await app.inject({
      url: `/mine/${theirs.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(foreign.statusCode).toBe(404);
    expect(problem(foreign.payload).type).toBe(PROBLEM.notFound);
  });

  it('is indistinguishable from a row that never existed', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const headers = { authorization: `Bearer ${token}` };
    const theirs = fixtures.create.weightEntry(fixtures.userB);

    const foreign = await app.inject({ url: `/mine/${theirs.id}`, headers });
    const missing = await app.inject({ url: '/mine/does-not-exist', headers });

    const [a, b] = [problem(foreign.payload), problem(missing.payload)];
    expect(a.status).toBe(b.status);
    expect(a.type).toBe(b.type);
    expect(a.title).toBe(b.title);
    expect(a.detail).toBe(b.detail);
  });

  it('still answers the owner', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const mine = fixtures.create.weightEntry(fixtures.userA);

    const response = await app.inject({
      url: `/mine/${mine.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: mine.id });
  });
});

describe('the context itself', () => {
  it('cannot be replaced or edited by a handler', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const body = await app
      .inject({ url: '/tamper', headers: { authorization: `Bearer ${token}` } })
      .then((response) => response.json<{ replaced: boolean; edited: boolean; userId: string }>());

    expect(body.replaced).toBe(false);
    expect(body.edited).toBe(false);
    expect(body.userId).toBe(fixtures.userA.id);
  });

  it('is not there at all on a public route, so reading it is a loud failure', async () => {
    const { app } = await buildTestApp();

    // A 500 with nothing in the body, and the reason in the log. See http/problem.ts.
    expect((await app.inject({ url: '/peek' })).statusCode).toBe(500);
  });
});

/** Whether a write went through. Strict mode throws on a frozen field, sloppy mode ignores it. */
function attempt(write: () => void): boolean {
  try {
    write();
    return true;
  } catch {
    return false;
  }
}

describe('where a handler is allowed to learn who is calling', () => {
  /**
   * The rule is that a user id comes from the request context and from nowhere else. Two things
   * hold it up. Every request schema in @portionium/schemas is strict, so a `userId` a client
   * sends is a 400 rather than a value, which is asserted next to those schemas. And an adapter
   * never reads one out of an incoming payload, which is what this checks.
   *
   * A grep rather than an ESLint rule, because a custom rule is a package, a build step and a
   * plugin to maintain, and the mistake it would catch is one line long and looks like this.
   * Write the rule the day this stops being enough.
   */
  const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

  const adapterSources = readdirSync(sourceRoot, { recursive: true, encoding: 'utf8' })
    .filter((file) => /^(http|mcp)\/.*\.ts$/.test(file) && !file.endsWith('.test.ts'))
    .map((file) => [file, readFileSync(sourceRoot + file, 'utf8')] as const);

  it('finds the adapter sources it is meant to be checking', () => {
    expect(adapterSources.length).toBeGreaterThan(0);
  });

  it.each(adapterSources)('%s takes no user id from a body, query or path', (_file, source) => {
    expect(source).not.toMatch(/\b(body|params|query|querystring)\s*[.[]\s*'?userId/);
  });
});
