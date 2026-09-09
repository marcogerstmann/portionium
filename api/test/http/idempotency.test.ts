import { PROBLEM, type CreateApiTokenResponse, type ProblemDetails } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { purgeIdempotencyKeys } from '../../src/db/idempotency.js';
import { apiTokenTable, idempotencyKeyTable } from '../../src/db/schema/index.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
} from '../../src/http/plugins/idempotency.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';
import { freezeTime } from '../helpers/time.js';

/**
 * A retried write, over the real app and a real table. The shipped token endpoints are the
 * writes under test, because they are the ones that exist. Two routes are declared here on
 * top: one slow enough for two copies of a request to overlap, and one that breaks.
 */

const WEB_ORIGIN = 'http://localhost:5173';

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

async function buildTestApp() {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN }),
    database: fixtures,
  });

  const executions = { slow: 0, boom: 0 };

  app.post('/slow', { config: { auth: 'write' } }, async () => {
    executions.slow += 1;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { execution: executions.slow };
  });

  app.post('/boom', { config: { auth: 'write' } }, () => {
    executions.boom += 1;
    throw new Error('not today');
  });

  await app.ready();

  open = { app, fixtures };
  return { app, fixtures, executions };
}

function url(path: string): string {
  return `${API_PREFIX}${path}`;
}

/** A browser with the outbox header on: cookie, origin, and the key it chose for this write. */
function browser(token: string, key?: string) {
  return {
    cookie: `${SESSION_COOKIE_NAME}=${token}`,
    origin: WEB_ORIGIN,
    ...(key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }),
  };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

function mintToken(
  app: FastifyInstance,
  headers: Record<string, string>,
  body: Record<string, unknown> = { name: 'Deploy script', scopes: ['read'] },
) {
  return app.inject({ method: 'POST', url: url('/auth/tokens'), headers, payload: body });
}

describe('replaying a successful write', () => {
  it('answers the retry with the stored response and runs nothing twice', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = browser(fixtures.create.session(fixtures.userA), 'outbox-1');

    const first = await mintToken(app, headers);
    const second = await mintToken(app, headers);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    // Byte for byte, including the one time secret. The retry is the same request.
    expect(second.payload).toBe(first.payload);
    expect(second.headers['content-type']).toBe(first.headers['content-type']);
    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(1);
  });

  it('runs a request without a key every time it is sent', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = browser(fixtures.create.session(fixtures.userA));

    await mintToken(app, headers);
    await mintToken(app, headers);

    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(2);
  });

  it('replays a 204, so a retried delete is not a 404', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);
    const token = await mintToken(app, browser(session)).then((r) =>
      r.json<CreateApiTokenResponse>(),
    );
    const request = {
      method: 'DELETE' as const,
      url: url(`/auth/tokens/${token.id}`),
      headers: browser(session, 'outbox-2'),
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });

  it('replays a domain failure too, because that answer is as final as a success', async () => {
    const { app, fixtures } = await buildTestApp();
    const request = {
      method: 'DELETE' as const,
      url: url('/auth/tokens/0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b'),
      headers: browser(fixtures.create.session(fixtures.userA), 'outbox-3'),
    };

    await app.inject(request);
    const second = await app.inject(request);

    expect(second.statusCode).toBe(404);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
    expect(problem(second.payload).type).toBe(PROBLEM.notFound);
  });

  it('scopes keys per user, so two accounts choosing the same key do not collide', async () => {
    const { app, fixtures } = await buildTestApp();

    const a = await mintToken(app, browser(fixtures.create.session(fixtures.userA), 'same'));
    const b = await mintToken(app, browser(fixtures.create.session(fixtures.userB), 'same'));

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(2);
  });
});

describe('a key reused for a different request', () => {
  it('answers 422 with its own problem type and runs nothing', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = browser(fixtures.create.session(fixtures.userA), 'outbox-4');

    await mintToken(app, headers, { name: 'Deploy script', scopes: ['read'] });
    const other = await mintToken(app, headers, { name: 'Something else', scopes: ['read'] });

    expect(other.statusCode).toBe(422);
    expect(problem(other.payload).type).toBe(PROBLEM.idempotencyKeyMismatch);
    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(1);
  });

  it('does not care what order the client wrote the body in', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = browser(fixtures.create.session(fixtures.userA), 'outbox-5');

    await mintToken(app, headers, { name: 'Deploy script', scopes: ['read'] });
    const reordered = await mintToken(app, headers, { scopes: ['read'], name: 'Deploy script' });

    expect(reordered.statusCode).toBe(201);
    expect(reordered.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
  });
});

describe('two copies of one request at the same time', () => {
  it('runs one, answers the other 409, and replays the first once it is done', async () => {
    const { app, fixtures, executions } = await buildTestApp();
    const request = {
      method: 'POST' as const,
      url: '/slow',
      headers: browser(fixtures.create.session(fixtures.userA), 'outbox-6'),
    };

    const [a, b] = await Promise.all([app.inject(request), app.inject(request)]);

    expect(executions.slow).toBe(1);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const refused = a.statusCode === 409 ? a : b;
    expect(problem(refused.payload).type).toBe(PROBLEM.idempotencyRequestInProgress);

    const later = await app.inject(request);
    expect(later.statusCode).toBe(200);
    expect(later.json()).toEqual({ execution: 1 });
    expect(executions.slow).toBe(1);
  });
});

describe('a request that broke', () => {
  it('keeps nothing, so the retry runs the request again', async () => {
    const { app, fixtures, executions } = await buildTestApp();
    const request = {
      method: 'POST' as const,
      url: '/boom',
      headers: browser(fixtures.create.session(fixtures.userA), 'outbox-7'),
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(500);
    expect(second.statusCode).toBe(500);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(executions.boom).toBe(2);
    expect(fixtures.db.select().from(idempotencyKeyTable).all()).toHaveLength(0);
  });
});

describe('the retention window', () => {
  const RETENTION_MS = 24 * 60 * 60 * 1000;

  it('purges a key older than the window and leaves a younger one', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);

    freezeTime('2026-09-09T10:00:00Z');
    await mintToken(app, browser(session, 'old'));
    vi.setSystemTime(new Date('2026-09-10T09:00:00Z'));
    await mintToken(app, browser(session, 'young'));
    vi.setSystemTime(new Date('2026-09-10T11:00:00Z'));

    const dropped = purgeIdempotencyKeys(fixtures.db, new Date(Date.now() - RETENTION_MS));

    expect(dropped).toBe(1);
    expect(
      fixtures.db
        .select()
        .from(idempotencyKeyTable)
        .all()
        .map((row) => row.key),
    ).toEqual(['young']);
  });

  it('lets a purged key be used again for a fresh request', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = browser(fixtures.create.session(fixtures.userA), 'reused');

    freezeTime('2026-09-09T10:00:00Z');
    const first = await mintToken(app, headers);
    vi.setSystemTime(new Date('2026-09-10T11:00:00Z'));
    purgeIdempotencyKeys(fixtures.db, new Date(Date.now() - RETENTION_MS));
    const second = await mintToken(app, headers);

    expect(second.statusCode).toBe(201);
    expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    expect(second.payload).not.toBe(first.payload);
    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(2);
  });
});

describe('the contract', () => {
  it('documents 409 and 422 on a write, so a generated client knows to handle them', async () => {
    const { app } = await buildTestApp();

    const document = await app
      .inject({ url: url('/openapi.json') })
      .then((r) => r.json<{ paths: Record<string, { post: { responses: object } }> }>());

    const responses = Object.keys(document.paths[url('/auth/tokens')]!.post.responses);
    expect(responses).toContain('409');
    expect(responses).toContain('422');
  });
});
