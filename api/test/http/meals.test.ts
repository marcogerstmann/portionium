import type { DayResponse, MealResponse, ProblemDetails } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';
import { freezeTime } from '../helpers/time.js';

/**
 * The primary write path, over the real app and a real database. userA is Europe/Berlin and
 * userB is America/New_York, which is what makes a wrong local date or a leaked meal visible
 * rather than the same answer by luck.
 */

const WEB_ORIGIN = 'http://localhost:5173';
const MEALS = `${API_PREFIX}/meals`;
const days = (date: string) => `${API_PREFIX}/days/${date}`;

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

describe('logging a meal', () => {
  it('stores it with a resolved category per item and derives the local date', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    // 05:00 UTC is 06:00 in Berlin, an hour past the default 04:00 boundary, so it belongs to
    // the day it falls on rather than the day before.
    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'breakfast',
        loggedAt: '2026-03-02T05:00:00.000Z',
        notes: 'with berries',
        items: [{ foodId: skyr.id, quantity: 200 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<MealResponse>();
    expect(body).toMatchObject({
      userId: fixtures.userA.id,
      type: 'breakfast',
      localDate: '2026-03-02',
      notes: 'with berries',
    });
    expect(body.items).toEqual([
      {
        id: expect.any(String) as string,
        foodId: skyr.id,
        quantity: 200,
        position: 0,
        category: 'green',
      },
    ]);
  });

  it('assigns dense positions from the order items arrived in', async () => {
    const { app, fixtures } = await buildTestApp();
    const a = fixtures.create.food();
    const b = fixtures.create.food();
    const c = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        items: [{ foodId: c.id }, { foodId: a.id }, { foodId: b.id }],
      },
    });

    const body = response.json<MealResponse>();
    expect(body.items.map((item) => [item.foodId, item.position])).toEqual([
      [c.id, 0],
      [a.id, 1],
      [b.id, 2],
    ]);
  });

  it('reports no colour as null rather than leaving the field out', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'snack', items: [{ foodId: food.id }] },
    });

    expect(response.json<MealResponse>().items[0]).toHaveProperty('category', null);
  });

  it('rejects an empty meal as a domain error rather than an empty row', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', items: [] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/meal-has-no-items',
    );
  });

  it('answers a clear validation problem for a food id nothing serves, not a 500', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const ghost = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', items: [{ foodId: ghost }] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/unknown-food-reference',
    );
  });

  it('lets a client supply the id, for a meal logged offline', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const clientId = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { id: clientId, type: 'dinner', items: [{ foodId: food.id }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<MealResponse>().id).toBe(clientId);
  });

  it('refuses an id that already belongs to a meal rather than overwriting it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const clientId = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
    const payload = { id: clientId, type: 'dinner', items: [{ foodId: food.id }] };

    const first = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { ...payload, notes: 'a different meal' },
    });

    expect(second.statusCode).toBe(409);
    expect(problem(second.payload).type).toBe('https://portionium.dev/problems/meal-id-conflict');
  });
});

describe('browsing meals', () => {
  it('never shows a caller a meal that belongs to somebody else', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.meal(fixtures.userA);
    fixtures.create.meal(fixtures.userB);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: MEALS, headers: browser(token) });

    const body = response.json<{ items: MealResponse[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.userId).toBe(fixtures.userA.id);
  });

  it('filters by meal type', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.meal(fixtures.userA, { type: 'breakfast' });
    fixtures.create.meal(fixtures.userA, { type: 'dinner' });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${MEALS}?type=dinner`, headers: browser(token) });

    const body = response.json<{ items: MealResponse[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.type).toBe('dinner');
  });

  it('filters by a local date range', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.meal(fixtures.userA, { loggedAt: new Date('2026-01-01T12:00:00.000Z') });
    fixtures.create.meal(fixtures.userA, { loggedAt: new Date('2026-06-01T12:00:00.000Z') });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${MEALS}?from=2026-05-01&to=2026-06-30`,
      headers: browser(token),
    });

    const body = response.json<{ items: MealResponse[] }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.localDate).toBe('2026-06-01');
  });

  it('pages newest first and closes the last page with a null cursor', async () => {
    const { app, fixtures } = await buildTestApp();
    const meals = Array.from({ length: 3 }, (_, index) =>
      fixtures.create.meal(fixtures.userA, {
        loggedAt: new Date(2026, 0, index + 1, 12),
      }),
    );
    const newestFirst = [...meals].reverse().map((m) => m.meal.id);
    const token = fixtures.create.session(fixtures.userA);

    const first = await app.inject({ url: `${MEALS}?limit=2`, headers: browser(token) });
    const firstPage = first.json<{ items: MealResponse[]; nextCursor: string | null }>();

    expect(firstPage.items.map((item) => item.id)).toEqual(newestFirst.slice(0, 2));
    expect(firstPage.nextCursor).toBe(newestFirst[1]);

    const last = await app.inject({
      url: `${MEALS}?limit=10&cursor=${firstPage.nextCursor}`,
      headers: browser(token),
    });
    const lastPage = last.json<{ items: MealResponse[]; nextCursor: string | null }>();

    expect(lastPage.items.map((item) => item.id)).toEqual(newestFirst.slice(2));
    expect(lastPage.nextCursor).toBeNull();
  });

  it('rejects a query parameter nobody declared', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${MEALS}?bogus=1`, headers: browser(token) });

    expect(response.statusCode).toBe(400);
  });
});

describe('one local day', () => {
  it('returns meals, items and colours, a null weight, and the counts by colour', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(green, { category: 'green' });
    const orange = fixtures.create.food({ name: 'Peanut butter' });
    fixtures.create.classification(orange, { category: 'orange' });
    const unclassified = fixtures.create.food({ name: 'Mystery item' });

    const loggedAt = new Date('2026-04-10T08:00:00.000Z');
    fixtures.create.meal(fixtures.userA, {
      loggedAt,
      items: [{ foodId: green.id }, { foodId: orange.id }, { foodId: unclassified.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json<DayResponse>();
    expect(body.date).toBe('2026-04-10');
    expect(body.meals).toHaveLength(1);
    expect(body.meals[0]?.items).toHaveLength(3);
    expect(body.weightEntry).toBeNull();
    expect(body.colourCounts).toEqual({ green: 1, yellow: 0, orange: 1, unclassified: 1 });
  });

  it('includes the weight entry recorded on the same local day', async () => {
    const { app, fixtures } = await buildTestApp();
    const recordedAt = new Date('2026-04-10T07:00:00.000Z');
    fixtures.create.weightEntry(fixtures.userA, { weightGrams: 82_000, recordedAt });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.json<DayResponse>().weightEntry).toMatchObject({ weightKg: 82 });
  });

  it('shows nothing for a day with nothing logged, rather than a 404', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.statusCode).toBe(200);
    expect(response.json<DayResponse>()).toEqual({
      date: '2026-04-10',
      meals: [],
      weightEntry: null,
      colourCounts: { green: 0, yellow: 0, orange: 0, unclassified: 0 },
    });
  });

  it('never mixes in another account, even one that ate on the same calendar date', async () => {
    const { app, fixtures } = await buildTestApp();
    const loggedAt = new Date('2026-04-10T12:00:00.000Z');
    fixtures.create.meal(fixtures.userB, { loggedAt });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.json<DayResponse>().meals).toEqual([]);
  });

  it('resolves what "today" means from a frozen clock, exactly like a POST would', async () => {
    freezeTime('2026-04-10T05:30:00.000Z');
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    // No loggedAt: the server stamps now, which is what the frozen clock fixes for this test.
    const created = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'breakfast', items: [{ foodId: food.id }] },
    });
    const localDate = created.json<MealResponse>().localDate;

    const response = await app.inject({ url: days(localDate), headers: browser(token) });

    expect(response.json<DayResponse>().meals).toHaveLength(1);
  });
});
