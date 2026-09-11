import type {
  DayResponse,
  FavouriteResponse,
  MealResponse,
  MealSuggestionResponse,
  ProblemDetails,
} from '@portionium/schemas';
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
const meal = (id: string) => `${MEALS}/${id}`;
const days = (date: string) => `${API_PREFIX}/days/${date}`;
const SUGGESTIONS = `${API_PREFIX}/meals/suggestions`;
const FAVOURITES = `${API_PREFIX}/meals/favourites`;
const favourite = (id: string) => `${FAVOURITES}/${id}`;

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

describe('editing a meal', () => {
  it('moves a meal across a local day boundary and reports the new date explicitly', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    // 05:00 UTC is 06:00 in Berlin, on 2026-03-02.
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-02T05:00:00.000Z'),
      items: [{ foodId: food.id }],
    });
    expect(stored.localDate).toBe('2026-03-02');

    // 03:00 UTC is 04:00 in Berlin, exactly the day boundary, so it lands on the next day.
    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: { loggedAt: '2026-03-03T03:00:00.000Z' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MealResponse>().localDate).toBe('2026-03-03');

    // The day it left shows nothing, the day it landed on shows it, with no cache to catch up.
    const oldDay = await app.inject({ url: days('2026-03-02'), headers: browser(token) });
    const newDay = await app.inject({ url: days('2026-03-03'), headers: browser(token) });
    expect(oldDay.json<DayResponse>().meals).toHaveLength(0);
    expect(newDay.json<DayResponse>().meals).toHaveLength(1);
  });

  it('updates type, notes and the item list', async () => {
    const { app, fixtures } = await buildTestApp();
    const original = fixtures.create.food();
    const added = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      items: [{ foodId: original.id }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: {
        type: 'dinner',
        notes: 'ate later than planned',
        items: [{ foodId: added.id }, { foodId: original.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MealResponse>();
    expect(body).toMatchObject({ type: 'dinner', notes: 'ate later than planned' });
    // Reordered: the newly added item now leads, and positions are dense from zero.
    expect(body.items.map((item) => [item.foodId, item.position])).toEqual([
      [added.id, 0],
      [original.id, 1],
    ]);
  });

  it('leaves fields an edit does not mention untouched', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      type: 'lunch',
      notes: 'original note',
    });

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: { notes: 'updated note' },
    });

    const body = response.json<MealResponse>();
    expect(body.type).toBe('lunch');
    expect(body.notes).toBe('updated note');
    expect(body.items).toHaveLength(1);
  });

  it('refuses to remove the last item, suggesting deletion instead', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: { items: [] },
    });

    expect(response.statusCode).toBe(422);
    const body = problem(response.payload);
    expect(body.type).toBe('https://portionium.dev/problems/meal-has-no-items');
    expect(body.detail).toMatch(/delete the meal/i);
  });

  it('refuses to move a meal further into the future than clock skew excuses', async () => {
    freezeTime('2026-05-01T12:00:00.000Z');
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-05-01T12:00:00.000Z'),
    });

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: { loggedAt: '2026-05-02T00:00:00.000Z' },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/meal-logged-in-future',
    );
  });

  it('answers 404 for a meal id nothing serves, and never touches a foreign meal', async () => {
    const { app, fixtures } = await buildTestApp();
    const tokenA = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userB);

    const ghost = await app.inject({
      method: 'PATCH',
      url: meal('0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31'),
      headers: browser(tokenA),
      payload: { notes: 'x' },
    });
    const foreign = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(tokenA),
      payload: { notes: 'x' },
    });

    expect(ghost.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
  });
});

describe('deleting a meal', () => {
  it('soft deletes, so the meal disappears from the feed and the day it was on', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const loggedAt = new Date('2026-04-10T08:00:00.000Z');
    const { meal: stored } = fixtures.create.meal(fixtures.userA, { loggedAt });

    const response = await app.inject({
      method: 'DELETE',
      url: meal(stored.id),
      headers: browser(token),
    });
    expect(response.statusCode).toBe(204);

    const day = await app.inject({ url: days('2026-04-10'), headers: browser(token) });
    expect(day.json<DayResponse>().meals).toHaveLength(0);

    // Already gone counts as nothing to delete, so a second delete is 404 rather than 204 again.
    const second = await app.inject({
      method: 'DELETE',
      url: meal(stored.id),
      headers: browser(token),
    });
    expect(second.statusCode).toBe(404);
  });

  it('lets a client undo a delete by recreating the meal with the same id', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const clientId = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
    const payload = { id: clientId, type: 'lunch', items: [{ foodId: food.id }] };

    const created = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload,
    });
    expect(created.statusCode).toBe(201);

    const deleted = await app.inject({
      method: 'DELETE',
      url: meal(clientId),
      headers: browser(token),
    });
    expect(deleted.statusCode).toBe(204);

    // The same request the client would replay to undo its own delete: same id, same payload.
    const recreated = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload,
    });

    expect(recreated.statusCode).toBe(201);
    expect(recreated.json<MealResponse>().id).toBe(clientId);

    // Live again: a normal read finds it, and a second delete has something to act on.
    const list = await app.inject({ url: MEALS, headers: browser(token) });
    expect(list.json<{ items: MealResponse[] }>().items.map((item) => item.id)).toContain(clientId);
  });

  it('never revives a soft deleted meal for anybody but the account that owned it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const tokenA = fixtures.create.session(fixtures.userA);
    const tokenB = fixtures.create.session(fixtures.userB);
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      items: [{ foodId: food.id }],
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: meal(stored.id),
      headers: browser(tokenA),
    });
    expect(deleted.statusCode).toBe(204);

    // userB tries to claim userA's now-deleted id as their own new meal.
    const claimed = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(tokenB),
      payload: { id: stored.id, type: 'dinner', items: [{ foodId: food.id }] },
    });

    expect(claimed.statusCode).toBe(409);
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

describe('repeating a meal with fromMealId', () => {
  it('copies the items of an existing meal into a new one logged now', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: original } = fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      items: [{ foodId: food.id, quantity: 150 }],
    });

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'breakfast', fromMealId: original.id },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<MealResponse>();
    expect(body.id).not.toBe(original.id);
    expect(body.items).toEqual([
      expect.objectContaining({ foodId: food.id, quantity: 150, position: 0 }) as MealResponse,
    ]);
  });

  it('refuses items and fromMealId together rather than picking one silently', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: original } = fixtures.create.meal(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', fromMealId: original.id, items: [{ foodId: food.id }] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/meal-from-id-with-items',
    );
  });

  it('answers 404 for a fromMealId nothing serves, and never copies a foreign meal', async () => {
    const { app, fixtures } = await buildTestApp();
    const tokenA = fixtures.create.session(fixtures.userA);
    const { meal: foreign } = fixtures.create.meal(fixtures.userB);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(tokenA),
      payload: { type: 'lunch', fromMealId: foreign.id },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('meal suggestions', () => {
  it('answers an empty list for a caller with no history, rather than an error', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=breakfast`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<MealSuggestionResponse[]>()).toEqual([]);
  });

  it('ranks the more frequently logged composition first, with its colour resolved', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    const croissant = fixtures.create.food({ name: 'Croissant' });
    const token = fixtures.create.session(fixtures.userA);

    for (let day = 1; day <= 3; day += 1) {
      fixtures.create.meal(fixtures.userA, {
        type: 'breakfast',
        loggedAt: new Date(2026, 3, day, 8),
        items: [{ foodId: skyr.id }],
      });
    }
    fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      loggedAt: new Date(2026, 3, 4, 8),
      items: [{ foodId: croissant.id }],
    });

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=breakfast`,
      headers: browser(token),
    });

    const body = response.json<MealSuggestionResponse[]>();
    expect(body[0]?.items).toEqual([{ foodId: skyr.id, category: 'green' }]);
    expect(body[0]?.mealId).toEqual(expect.any(String) as string);
  });

  it('treats the same foods logged in a different order as one composition', async () => {
    const { app, fixtures } = await buildTestApp();
    const a = fixtures.create.food();
    const b = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    fixtures.create.meal(fixtures.userA, {
      type: 'lunch',
      items: [{ foodId: a.id }, { foodId: b.id }],
    });
    fixtures.create.meal(fixtures.userA, {
      type: 'lunch',
      items: [{ foodId: b.id }, { foodId: a.id }],
    });

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=lunch`,
      headers: browser(token),
    });

    expect(response.json<MealSuggestionResponse[]>()).toHaveLength(1);
  });

  it('never suggests from another meal type or another account', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    fixtures.create.meal(fixtures.userA, { type: 'dinner' });
    fixtures.create.meal(fixtures.userB, { type: 'breakfast' });

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=breakfast`,
      headers: browser(token),
    });

    expect(response.json<MealSuggestionResponse[]>()).toEqual([]);
  });
});

describe('pinning a favourite', () => {
  it('stores it with a resolved category per item, private to the caller', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(token),
      payload: {
        name: 'Standard Frühstück',
        type: 'breakfast',
        items: [{ foodId: skyr.id, quantity: 200 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<FavouriteResponse>();
    expect(body).toMatchObject({ name: 'Standard Frühstück', type: 'breakfast' });
    expect(body.items).toEqual([{ foodId: skyr.id, quantity: 200, category: 'green' }]);
  });

  it('rejects an empty favourite as a domain error rather than an empty row', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(token),
      payload: { name: 'Nothing', type: 'snack', items: [] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/favourite-has-no-items',
    );
  });

  it("lists only the caller's own favourites, newest first", async () => {
    const { app, fixtures } = await buildTestApp();
    const foodA = fixtures.create.food();
    const foodB = fixtures.create.food();
    const tokenA = fixtures.create.session(fixtures.userA);
    const tokenB = fixtures.create.session(fixtures.userB);

    await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenA),
      payload: { name: 'First', type: 'breakfast', items: [{ foodId: foodA.id }] },
    });
    await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenB),
      payload: { name: 'Not yours', type: 'breakfast', items: [{ foodId: foodB.id }] },
    });
    const second = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenA),
      payload: { name: 'Second', type: 'breakfast', items: [{ foodId: foodA.id }] },
    });

    const response = await app.inject({ url: FAVOURITES, headers: browser(tokenA) });

    const body = response.json<{ items: FavouriteResponse[] }>();
    expect(body.items.map((item) => item.name)).toEqual(['Second', 'First']);
    expect(body.items[0]?.id).toBe(second.json<FavouriteResponse>().id);
  });

  it('deletes one, and answers 404 for a caller that does not own it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const tokenA = fixtures.create.session(fixtures.userA);
    const tokenB = fixtures.create.session(fixtures.userB);

    const created = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenA),
      payload: { name: 'Mine', type: 'lunch', items: [{ foodId: food.id }] },
    });
    const id = created.json<FavouriteResponse>().id;

    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: favourite(id),
      headers: browser(tokenB),
    });
    expect(foreignDelete.statusCode).toBe(404);

    const ownDelete = await app.inject({
      method: 'DELETE',
      url: favourite(id),
      headers: browser(tokenA),
    });
    expect(ownDelete.statusCode).toBe(204);

    const list = await app.inject({ url: FAVOURITES, headers: browser(tokenA) });
    expect(list.json<{ items: FavouriteResponse[] }>().items).toEqual([]);
  });
});
