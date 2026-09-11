import type {
  ProblemDetails,
  WeightEntryCreateResponse,
  WeightEntryResponse,
} from '@portionium/schemas';
import { PROBLEM } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';
import { freezeTime } from '../helpers/time.js';

/**
 * The write path for weight, over the real app and a real database. userA is Europe/Berlin and
 * userB is America/New_York, the same reasoning as meals.test.ts: a wrong local date or a
 * leaked reading shows up rather than answering right by luck.
 */

const WEB_ORIGIN = 'http://localhost:5173';
const WEIGHT = `${API_PREFIX}/weight`;
const weightOn = (date: string) => `${WEIGHT}/${date}`;
const days = (date: string) => `${API_PREFIX}/days/${date}`;

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN, ...env }),
    database: fixtures,
  });
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

/** A browser: the cookie, and the Origin header a browser always attaches to a mutation. */
function browser(token: string) {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: WEB_ORIGIN };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

describe('recording a weight', () => {
  it('stores it and derives the local date from recordedAt', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    // 05:00 UTC is 06:00 in Berlin, past the default 04:00 boundary.
    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 82.4, recordedAt: '2026-03-02T05:00:00.000Z' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WeightEntryCreateResponse>();
    expect(body).toMatchObject({
      userId: fixtures.userA.id,
      weightKg: 82.4,
      localDate: '2026-03-02',
      warning: null,
    });
  });

  it('defaults recordedAt to now, resolved the same way a POST /meals would', async () => {
    freezeTime('2026-04-10T05:30:00.000Z');
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 80 },
    });

    expect(response.json<WeightEntryCreateResponse>().localDate).toBe('2026-04-10');
  });

  it('rejects a reading outside the plausible human range with a validation problem', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 8.24 },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(PROBLEM.implausibleWeight);
  });

  it('flags, but still records, an implausible day-over-day jump', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.weightEntry(fixtures.userA, {
      weightGrams: 82_400,
      recordedAt: new Date('2026-09-05T06:00:00.000Z'),
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 92.4, recordedAt: '2026-09-06T06:00:00.000Z' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<WeightEntryCreateResponse>();
    expect(body.weightKg).toBe(92.4);
    expect(body.warning).toMatch(/82\.4 kg recorded on 2026-09-05/);

    // Not blocked: a second read finds both readings.
    const list = await app.inject({ url: WEIGHT, headers: browser(token) });
    expect(
      list.json<{ items: WeightEntryResponse[]; nextCursor: string | null }>().items,
    ).toHaveLength(2);
  });

  it('judges the jump against the caller alone, never another account’s history', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.weightEntry(fixtures.userB, { weightGrams: 120_000 });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 82.4 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<WeightEntryCreateResponse>().warning).toBeNull();
  });

  it('rejects a query parameter nobody declared', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: WEIGHT,
      headers: browser(token),
      payload: { weightKg: 80, bogus: true },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('browsing weight', () => {
  it('never shows a caller a reading that belongs to somebody else', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.weightEntry(fixtures.userA);
    fixtures.create.weightEntry(fixtures.userB);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: WEIGHT, headers: browser(token) });

    const body = response.json<{ items: WeightEntryResponse[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.userId).toBe(fixtures.userA.id);
  });

  it('filters by a local date range', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.weightEntry(fixtures.userA, {
      recordedAt: new Date('2026-01-01T12:00:00.000Z'),
    });
    fixtures.create.weightEntry(fixtures.userA, {
      recordedAt: new Date('2026-06-01T12:00:00.000Z'),
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT}?from=2026-05-01&to=2026-06-30`,
      headers: browser(token),
    });

    const body = response.json<{ items: WeightEntryResponse[]; nextCursor: string | null }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.localDate).toBe('2026-06-01');
  });

  it('pages newest first and closes the last page with a null cursor', async () => {
    const { app, fixtures } = await buildTestApp();
    const entries = Array.from({ length: 3 }, (_, index) =>
      fixtures.create.weightEntry(fixtures.userA, {
        recordedAt: new Date(2026, 0, index + 1, 12),
      }),
    );
    const newestFirst = [...entries].reverse().map((e) => e.id);
    const token = fixtures.create.session(fixtures.userA);

    const first = await app.inject({ url: `${WEIGHT}?limit=2`, headers: browser(token) });
    const firstPage = first.json<{ items: WeightEntryResponse[]; nextCursor: string | null }>();

    expect(firstPage.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 2));
    expect(firstPage.nextCursor).toBe(newestFirst[1]);

    const last = await app.inject({
      url: `${WEIGHT}?limit=10&cursor=${firstPage.nextCursor}`,
      headers: browser(token),
    });
    const lastPage = last.json<{ items: WeightEntryResponse[]; nextCursor: string | null }>();

    expect(lastPage.items.map((item) => item.id)).toEqual(newestFirst.slice(2));
    expect(lastPage.nextCursor).toBeNull();
  });
});

describe('deleting a weight entry', () => {
  it('removes the reading recorded for that date', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const recordedAt = new Date('2026-04-10T08:00:00.000Z');
    fixtures.create.weightEntry(fixtures.userA, { recordedAt });

    const response = await app.inject({
      method: 'DELETE',
      url: weightOn('2026-04-10'),
      headers: browser(token),
    });
    expect(response.statusCode).toBe(204);

    const day = await app.inject({ url: days('2026-04-10'), headers: browser(token) });
    expect(day.json<{ weightEntry: WeightEntryResponse | null }>().weightEntry).toBeNull();

    // Already gone counts as nothing to delete, so a second delete is 404 rather than 204 again.
    const second = await app.inject({
      method: 'DELETE',
      url: weightOn('2026-04-10'),
      headers: browser(token),
    });
    expect(second.statusCode).toBe(404);
  });

  it('removes only the most recently recorded reading when there were two that day', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    fixtures.create.weightEntry(fixtures.userA, {
      weightGrams: 82_000,
      recordedAt: new Date('2026-04-10T07:00:00.000Z'),
    });
    fixtures.create.weightEntry(fixtures.userA, {
      weightGrams: 82_500,
      recordedAt: new Date('2026-04-10T20:00:00.000Z'),
    });

    const response = await app.inject({
      method: 'DELETE',
      url: weightOn('2026-04-10'),
      headers: browser(token),
    });
    expect(response.statusCode).toBe(204);

    const day = await app.inject({ url: days('2026-04-10'), headers: browser(token) });
    expect(day.json<{ weightEntry: WeightEntryResponse | null }>().weightEntry).toMatchObject({
      weightKg: 82,
    });
  });

  it('answers 404 for a date nothing was recorded on, and never touches a foreign reading', async () => {
    const { app, fixtures } = await buildTestApp();
    const recordedAt = new Date('2026-04-10T08:00:00.000Z');
    fixtures.create.weightEntry(fixtures.userB, { recordedAt });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'DELETE',
      url: weightOn('2026-04-10'),
      headers: browser(token),
    });

    expect(response.statusCode).toBe(404);
    expect(problem(response.payload).type).toBe(PROBLEM.notFound);

    // Still there for its owner.
    const tokenB = fixtures.create.session(fixtures.userB);
    const day = await app.inject({ url: days('2026-04-10'), headers: browser(tokenB) });
    expect(day.json<{ weightEntry: WeightEntryResponse | null }>().weightEntry).not.toBeNull();
  });
});
