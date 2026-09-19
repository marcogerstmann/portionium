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
        entries: [{ foodId: skyr.id, quantity: 200 }],
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
    expect(body.entries).toEqual([
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
        entries: [{ foodId: c.id }, { foodId: a.id }, { foodId: b.id }],
      },
    });

    const body = response.json<MealResponse>();
    expect(body.entries.map((entry) => [entry.foodId, entry.position])).toEqual([
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
      payload: { type: 'snack', entries: [{ foodId: food.id }] },
    });

    expect(response.json<MealResponse>().entries[0]).toHaveProperty('category', null);
  });

  it('rejects an empty meal as a domain error rather than an empty row', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/meal-has-no-entries',
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
      payload: { type: 'lunch', entries: [{ foodId: ghost }] },
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
      payload: { id: clientId, type: 'dinner', entries: [{ foodId: food.id }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<MealResponse>().id).toBe(clientId);
  });

  it('refuses an id that already belongs to a meal rather than overwriting it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const clientId = '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31';
    const payload = { id: clientId, type: 'dinner', entries: [{ foodId: food.id }] };

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
      entries: [{ foodId: food.id }],
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
      entries: [{ foodId: original.id }],
    });

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: {
        type: 'dinner',
        notes: 'ate later than planned',
        entries: [{ foodId: added.id }, { foodId: original.id }],
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MealResponse>();
    expect(body).toMatchObject({ type: 'dinner', notes: 'ate later than planned' });
    // Reordered: the newly added item now leads, and positions are dense from zero.
    expect(body.entries.map((entry) => [entry.foodId, entry.position])).toEqual([
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
    expect(body.entries).toHaveLength(1);
  });

  it('refuses to remove the last entry, suggesting deletion instead', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: stored } = fixtures.create.meal(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: meal(stored.id),
      headers: browser(token),
      payload: { entries: [] },
    });

    expect(response.statusCode).toBe(422);
    const body = problem(response.payload);
    expect(body.type).toBe('https://portionium.dev/problems/meal-has-no-entries');
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
    const payload = { id: clientId, type: 'lunch', entries: [{ foodId: food.id }] };

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
    expect(list.json<{ items: MealResponse[] }>().items.map((meal) => meal.id)).toContain(clientId);
  });

  it('never revives a soft deleted meal for anybody but the account that owned it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const tokenA = fixtures.create.session(fixtures.userA);
    const tokenB = fixtures.create.session(fixtures.userB);
    const { meal: stored } = fixtures.create.meal(fixtures.userA, {
      entries: [{ foodId: food.id }],
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
      payload: { id: stored.id, type: 'dinner', entries: [{ foodId: food.id }] },
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

    expect(firstPage.items.map((meal) => meal.id)).toEqual(newestFirst.slice(0, 2));
    expect(firstPage.nextCursor).toBe(newestFirst[1]);

    const last = await app.inject({
      url: `${MEALS}?limit=10&cursor=${firstPage.nextCursor}`,
      headers: browser(token),
    });
    const lastPage = last.json<{ items: MealResponse[]; nextCursor: string | null }>();

    expect(lastPage.items.map((meal) => meal.id)).toEqual(newestFirst.slice(2));
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
      entries: [{ foodId: green.id }, { foodId: orange.id }, { foodId: unclassified.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json<DayResponse>();
    expect(body.date).toBe('2026-04-10');
    expect(body.meals).toHaveLength(1);
    expect(body.meals[0]?.entries).toHaveLength(3);
    expect(body.weightEntry).toBeNull();
    expect(body.colourCounts).toEqual({ green: 1, yellow: 0, orange: 1, unclassified: 1 });

    // The names the items point at, resolved to the same colours the items carry. Without this
    // a client has identifiers to render and nothing to render them as, see dayResponseSchema.
    expect(body.foods).toEqual([
      expect.objectContaining({ id: green.id, name: 'Skyr', category: 'green' }),
      expect.objectContaining({ id: orange.id, name: 'Peanut butter', category: 'orange' }),
      expect.objectContaining({ id: unclassified.id, name: 'Mystery item', category: null }),
    ]);
  });

  it('names a food once however many of the meals on the day ate it', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Skyr' });
    const loggedAt = new Date('2026-04-10T08:00:00.000Z');
    fixtures.create.meal(fixtures.userA, {
      loggedAt,
      type: 'breakfast',
      entries: [{ foodId: food.id }, { foodId: food.id }],
    });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-04-10T12:00:00.000Z'),
      type: 'lunch',
      entries: [{ foodId: food.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: days('2026-04-10'), headers: browser(token) });

    expect(response.json<DayResponse>().foods).toHaveLength(1);
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
      foods: [],
      budget: {
        green: { limit: null, count: 0, remaining: null },
        yellow: { limit: null, count: 0, remaining: null },
        orange: { limit: null, count: 0, remaining: null },
        unclassified: 0,
      },
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
      payload: { type: 'breakfast', entries: [{ foodId: food.id }] },
    });
    const localDate = created.json<MealResponse>().localDate;

    const response = await app.inject({ url: days(localDate), headers: browser(token) });

    expect(response.json<DayResponse>().meals).toHaveLength(1);
  });

  /**
   * The point of it being here at all: the Today screen draws the week's allowance
   * without asking a second endpoint for it. The week is the ISO one this date falls in, so a
   * meal from Monday counts towards the number a Wednesday shows.
   */
  it("carries the week's budget status, counting the whole ISO week rather than the day", async () => {
    freezeTime('2026-03-11T10:00:00.000Z');
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/me/budgets`,
      headers: browser(token),
      payload: { orange: 4 },
    });
    // Monday and Wednesday of the week 2026-03-09 to 2026-03-15, plus the Sunday before it.
    for (const date of ['2026-03-09', '2026-03-11', '2026-03-08']) {
      fixtures.create.meal(fixtures.userA, {
        loggedAt: new Date(`${date}T05:00:00.000Z`),
        entries: [{ category: 'orange' }],
      });
    }

    const { colourCounts, budget } = (
      await app.inject({ url: days('2026-03-11'), headers: browser(token) })
    ).json<DayResponse>();

    // The day counts one, the week counts the two inside it and not the Sunday outside.
    expect(colourCounts.orange).toBe(1);
    expect(budget.orange).toEqual({ limit: 4, count: 2, remaining: 2 });
    expect(budget.green).toEqual({ limit: null, count: 0, remaining: null });
  });
});

describe('repeating a meal with fromMealId', () => {
  it('copies the items of an existing meal into a new one logged now', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: original } = fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      entries: [{ foodId: food.id, quantity: 150 }],
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
    expect(body.entries).toEqual([
      expect.objectContaining({ foodId: food.id, quantity: 150, position: 0 }) as MealResponse,
    ]);
  });

  it('refuses entries and fromMealId together rather than picking one silently', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);
    const { meal: original } = fixtures.create.meal(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', fromMealId: original.id, entries: [{ foodId: food.id }] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/meal-from-id-with-entries',
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
        entries: [{ foodId: skyr.id }],
      });
    }
    fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      loggedAt: new Date(2026, 3, 4, 8),
      entries: [{ foodId: croissant.id }],
    });

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=breakfast`,
      headers: browser(token),
    });

    const body = response.json<MealSuggestionResponse[]>();
    expect(body[0]?.entries).toEqual([{ foodId: skyr.id, foodName: 'Skyr', category: 'green' }]);
    expect(body[0]?.mealId).toEqual(expect.any(String) as string);
  });

  it("resolves a suggested food's colour to the caller's own override, not the shared one", async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    fixtures.create.meal(fixtures.userA, {
      type: 'breakfast',
      entries: [{ foodId: skyr.id }],
    });
    fixtures.create.classification(skyr, {
      userId: fixtures.userA.id,
      source: 'user',
      category: 'orange',
    });

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=breakfast`,
      headers: browser(token),
    });

    const body = response.json<MealSuggestionResponse[]>();
    expect(body[0]?.entries).toEqual([{ foodId: skyr.id, foodName: 'Skyr', category: 'orange' }]);
  });

  it('suggests a composition made of a bare colour, with no food name to carry', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    for (let day = 1; day <= 2; day += 1) {
      fixtures.create.meal(fixtures.userA, {
        type: 'snack',
        loggedAt: new Date(2026, 3, day, 12),
        entries: [{ category: 'green' }],
      });
    }

    const response = await app.inject({
      url: `${SUGGESTIONS}?type=snack`,
      headers: browser(token),
    });

    const body = response.json<MealSuggestionResponse[]>();
    expect(body).toHaveLength(1);
    expect(body[0]?.entries).toEqual([{ category: 'green' }]);
  });

  it('treats the same foods logged in a different order as one composition', async () => {
    const { app, fixtures } = await buildTestApp();
    const a = fixtures.create.food();
    const b = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    fixtures.create.meal(fixtures.userA, {
      type: 'lunch',
      entries: [{ foodId: a.id }, { foodId: b.id }],
    });
    fixtures.create.meal(fixtures.userA, {
      type: 'lunch',
      entries: [{ foodId: b.id }, { foodId: a.id }],
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
        entries: [{ foodId: skyr.id, quantity: 200 }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<FavouriteResponse>();
    expect(body).toMatchObject({ name: 'Standard Frühstück', type: 'breakfast' });
    expect(body.entries).toEqual([
      { foodId: skyr.id, foodName: 'Skyr', quantity: 200, category: 'green' },
    ]);
  });

  it('resolves a food entry to a name and colour, and leaves a bare entry with neither to look up', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(token),
      payload: {
        name: 'Mixed',
        type: 'snack',
        entries: [{ foodId: skyr.id }, { category: 'orange' }],
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<FavouriteResponse>();
    expect(body.entries).toEqual([
      { foodId: skyr.id, foodName: 'Skyr', category: 'green' },
      { category: 'orange' },
    ]);
  });

  it('rejects an empty favourite as a domain error rather than an empty row', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(token),
      payload: { name: 'Nothing', type: 'snack', entries: [] },
    });

    expect(response.statusCode).toBe(422);
    expect(problem(response.payload).type).toBe(
      'https://portionium.dev/problems/favourite-has-no-entries',
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
      payload: { name: 'First', type: 'breakfast', entries: [{ foodId: foodA.id }] },
    });
    await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenB),
      payload: { name: 'Not yours', type: 'breakfast', entries: [{ foodId: foodB.id }] },
    });
    const second = await app.inject({
      method: 'POST',
      url: FAVOURITES,
      headers: browser(tokenA),
      payload: { name: 'Second', type: 'breakfast', entries: [{ foodId: foodA.id }] },
    });

    const response = await app.inject({ url: FAVOURITES, headers: browser(tokenA) });

    const body = response.json<{ items: FavouriteResponse[] }>();
    expect(body.items.map((favourite) => favourite.name)).toEqual(['Second', 'First']);
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
      payload: { name: 'Mine', type: 'lunch', entries: [{ foodId: food.id }] },
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

/**
 * The half of "an entry is a colour" that the rest of this file only sees the shadow of: when
 * the colour is decided, and what can and cannot change it afterwards. See
 * docs/adr/011-an-entry-is-a-colour.md.
 */
describe('an entry carries the colour it was logged with', () => {
  it('stamps a food entry from the verdict standing at the moment it was logged', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{ foodId: skyr.id }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<MealResponse>().entries[0]?.category).toBe('green');
  });

  it('keeps the colour a bare entry named, and takes no food id with it', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{ category: 'orange' }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<MealResponse>().entries[0]).toMatchObject({
      foodId: null,
      category: 'orange',
    });
  });

  it('takes both kinds in one meal, and counts them together on the day', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const unjudged = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    const created = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: skyr.id }, { category: 'orange' }, { foodId: unjudged.id }],
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json<MealResponse>().entries.map((entry) => entry.category)).toEqual([
      'green',
      'orange',
      null,
    ]);

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    expect(day.json<DayResponse>().colourCounts).toEqual({
      green: 1,
      yellow: 0,
      orange: 1,
      unclassified: 1,
    });
  });

  it('counts the same mixture over a stats range', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: skyr.id }, { category: 'orange' }],
      },
    });

    const stats = await app.inject({
      url: `${API_PREFIX}/stats/days?from=2026-04-01&to=2026-04-01`,
      headers: browser(token),
    });

    expect(stats.json<{ days: { counts: Record<string, number> }[] }>().days[0]?.counts).toEqual({
      green: 1,
      yellow: 0,
      orange: 1,
      unclassified: 0,
    });
  });

  it('refuses an entry naming neither a food nor a colour, before it reaches the CHECK', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{}] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('lets an explicit colour beside a food win, and keeps the food as provenance', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{ foodId: skyr.id, category: 'orange' }] },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<MealResponse>().entries[0]).toMatchObject({
      foodId: skyr.id,
      category: 'orange',
    });
  });

  it('leaves the day a meal was logged on alone when the food is recoloured afterwards', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: skyr.id }],
      },
    });

    const overridden = await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
      payload: { category: 'orange' },
    });
    expect(overridden.statusCode).toBe(200);

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    const body = day.json<DayResponse>();

    // The entry keeps what it was logged with; the catalog entry beside it carries the new
    // verdict, which is the trap this story names out loud.
    expect(body.meals[0]?.entries[0]?.category).toBe('green');
    expect(body.foods[0]?.category).toBe('orange');
    expect(body.colourCounts).toMatchObject({ green: 1, orange: 0 });
  });

  it('colours the entries that were waiting when their owner gives the food a verdict', async () => {
    const { app, fixtures } = await buildTestApp();
    const unjudged = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: unjudged.id }],
      },
    });

    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${unjudged.id}/classification`,
      headers: browser(token),
      payload: { category: 'yellow' },
    });

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    expect(day.json<DayResponse>().meals[0]?.entries[0]?.category).toBe('yellow');
  });

  it('never reaches the other account, whose waiting entries stay waiting', async () => {
    const { app, fixtures } = await buildTestApp();
    const unjudged = fixtures.create.food();
    const tokenA = fixtures.create.session(fixtures.userA);
    const tokenB = fixtures.create.session(fixtures.userB);

    for (const token of [tokenA, tokenB]) {
      await app.inject({
        method: 'POST',
        url: MEALS,
        headers: browser(token),
        payload: {
          type: 'lunch',
          loggedAt: '2026-04-01T10:00:00.000Z',
          entries: [{ foodId: unjudged.id }],
        },
      });
    }

    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${unjudged.id}/classification`,
      headers: browser(tokenA),
      payload: { category: 'yellow' },
    });

    // userB is America/New_York, so 10:00 UTC is still the 1st there too.
    const dayB = await app.inject({ url: days('2026-04-01'), headers: browser(tokenB) });
    expect(dayB.json<DayResponse>().meals[0]?.entries[0]?.category).toBeNull();
  });

  it('leaves an entry that already has a colour alone, whoever says otherwise', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: skyr.id }],
      },
    });

    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
      payload: { category: 'orange' },
    });

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    expect(day.json<DayResponse>().meals[0]?.entries[0]?.category).toBe('green');
  });

  it('is not touched by a seed or an AI verdict, only by the account speaking for itself', async () => {
    const { app, fixtures } = await buildTestApp();
    const unjudged = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: unjudged.id }],
      },
    });

    // Both written straight through the log, which is the door an AI adapter will come in by.
    fixtures.create.classification(unjudged, { category: 'green', source: 'seed' });
    fixtures.create.classification(unjudged, { category: 'yellow', source: 'ai_text' });

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    expect(day.json<DayResponse>().meals[0]?.entries[0]?.category).toBeNull();
  });

  it('does not un-colour an entry when its owner withdraws the verdict that coloured it', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: {
        type: 'lunch',
        loggedAt: '2026-04-01T10:00:00.000Z',
        entries: [{ foodId: skyr.id }],
      },
    });
    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
      payload: { category: 'yellow' },
    });
    await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
    });

    const day = await app.inject({ url: days('2026-04-01'), headers: browser(token) });
    expect(day.json<DayResponse>().meals[0]?.entries[0]?.category).toBe('yellow');
  });

  it('restamps a repeat from the food as it stands now, and copies a bare colour as it was', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const original = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{ foodId: skyr.id }, { category: 'orange' }] },
    });

    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
      payload: { category: 'yellow' },
    });

    const repeat = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'dinner', fromMealId: original.json<MealResponse>().id },
    });

    expect(repeat.statusCode).toBe(201);
    expect(repeat.json<MealResponse>().entries.map((entry) => entry.category)).toEqual([
      'yellow',
      'orange',
    ]);
  });

  it('restamps a replaced entry list on a PATCH, and leaves one it does not name', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food();
    fixtures.create.classification(skyr, { category: 'green' });
    const token = fixtures.create.session(fixtures.userA);

    const created = await app.inject({
      method: 'POST',
      url: MEALS,
      headers: browser(token),
      payload: { type: 'lunch', entries: [{ foodId: skyr.id }] },
    });
    const id = created.json<MealResponse>().id;

    await app.inject({
      method: 'PUT',
      url: `${API_PREFIX}/foods/${skyr.id}/classification`,
      headers: browser(token),
      payload: { category: 'orange' },
    });

    const renamed = await app.inject({
      method: 'PATCH',
      url: meal(id),
      headers: browser(token),
      payload: { notes: 'at the desk' },
    });
    expect(renamed.json<MealResponse>().entries[0]?.category).toBe('green');

    const replaced = await app.inject({
      method: 'PATCH',
      url: meal(id),
      headers: browser(token),
      payload: { entries: [{ foodId: skyr.id }] },
    });
    expect(replaced.json<MealResponse>().entries[0]?.category).toBe('orange');
  });
});
