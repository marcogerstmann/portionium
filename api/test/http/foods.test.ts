import {
  PROBLEM,
  type FoodClassificationResponse,
  type FoodDetailResponse,
  type FoodResponse,
  type ProblemDetails,
} from '@portionium/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { foodTable } from '../../src/db/schema/index.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type FoodRow, type TestFixtures } from '../helpers/fixtures.js';

/**
 * The catalog, over the real app and a real database.
 *
 * Two accounts exist in every one of these tests, and they are here for a different reason than
 * they are in me.test.ts. A food is not owned, so the interesting property is not that user B
 * cannot reach user A's entries, it is that both reach the same entry and are told different
 * things about what colour it is.
 */

const WEB_ORIGIN = 'http://localhost:5173';
const FOODS = `${API_PREFIX}/foods`;

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

function storedFood(fixtures: TestFixtures, id: string) {
  return fixtures.db.select().from(foodTable).where(eq(foodTable.id, id)).get();
}

describe('browsing the catalog', () => {
  it('answers with the colour resolved for the caller, never a global one', async () => {
    const { app, fixtures } = await buildTestApp();
    const skyr = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(skyr, { category: 'green' });
    fixtures.create.classification(skyr, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userB.id,
    });

    const forA = await app.inject({
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });
    const forB = await app.inject({
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userB)),
    });

    expect(forA.json<{ items: FoodResponse[] }>().items[0]?.category).toBe('green');
    expect(forB.json<{ items: FoodResponse[] }>().items[0]?.category).toBe('orange');
  });

  it('reports no colour as null rather than leaving the field out', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.food({ name: 'Kohlrabi' });

    const response = await app.inject({
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    const [item] = response.json<{ items: FoodResponse[] }>().items;
    expect(item).toHaveProperty('category', null);
  });

  it('pages by cursor and closes the last page with a null one', async () => {
    const { app, fixtures } = await buildTestApp();
    const ids = Array.from({ length: 5 }, (_, index) =>
      fixtures.create.food({ name: `Food ${index}` }),
    ).map((food) => food.id);
    const headers = browser(fixtures.create.session(fixtures.userA));

    const first = await app.inject({ url: `${FOODS}?limit=2`, headers });
    const firstPage = first.json<{ items: FoodResponse[]; nextCursor: string | null }>();

    expect(firstPage.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(firstPage.nextCursor).toBe(ids[1]);

    const last = await app.inject({
      url: `${FOODS}?limit=10&cursor=${firstPage.nextCursor}`,
      headers,
    });
    const lastPage = last.json<{ items: FoodResponse[]; nextCursor: string | null }>();

    expect(lastPage.items.map((item) => item.id)).toEqual(ids.slice(2));
    expect(lastPage.nextCursor).toBeNull();
  });

  it('narrows to one kind', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.food({ name: 'Haferflocken', kind: 'ingredient' });
    fixtures.create.food({ name: 'Spaghetti Bolognese', kind: 'dish' });

    const response = await app.inject({
      url: `${FOODS}?kind=dish`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    const { items } = response.json<{ items: FoodResponse[] }>();
    expect(items.map((item) => item.name)).toEqual(['Spaghetti Bolognese']);
  });

  it('narrows to what has no colour for this caller, which is not the same list for both', async () => {
    const { app, fixtures } = await buildTestApp();
    const judged = fixtures.create.food({ name: 'Apfel' });
    fixtures.create.classification(judged, { category: 'green' });
    const mine = fixtures.create.food({ name: 'Erdnussbutter' });
    fixtures.create.classification(mine, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userB.id,
    });
    fixtures.create.food({ name: 'Kohlrabi' });

    const forA = await app.inject({
      url: `${FOODS}?unclassified=true`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });
    const forB = await app.inject({
      url: `${FOODS}?unclassified=true`,
      headers: browser(fixtures.create.session(fixtures.userB)),
    });

    // The peanut butter has a verdict, but it is user B's, so it is still on user A's pile.
    expect(forA.json<{ items: FoodResponse[] }>().items.map((item) => item.name)).toEqual([
      'Erdnussbutter',
      'Kohlrabi',
    ]);
    expect(forB.json<{ items: FoodResponse[] }>().items.map((item) => item.name)).toEqual([
      'Kohlrabi',
    ]);
  });

  it('leaves deleted entries out', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Gone' });
    fixtures.db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(eq(foodTable.id, food.id))
      .run();

    const response = await app.inject({
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.json<{ items: FoodResponse[] }>().items).toEqual([]);
  });

  it('needs a credential like everything else', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ url: FOODS });

    expect(response.statusCode).toBe(401);
  });
});

describe('adding to the catalog', () => {
  it('creates an entry, records who added it, and defaults the kind', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: 'Skyr' },
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<FoodResponse>();
    expect(created).toMatchObject({
      name: 'Skyr',
      kind: 'ingredient',
      createdBy: fixtures.userA.id,
      category: null,
    });
    expect(storedFood(fixtures, created.id)?.createdBy).toBe(fixtures.userA.id);
  });

  it('hands back the entry that already means this, rather than a near duplicate', async () => {
    const { app, fixtures } = await buildTestApp();
    const existing = fixtures.create.food({ name: 'Skyr' });
    fixtures.create.classification(existing, { category: 'green' });

    const response = await app.inject({
      method: 'POST',
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: '  sKyR  ' },
    });

    // 200 rather than 201, so a client can tell its entry is not the one that got made.
    expect(response.statusCode).toBe(200);
    expect(response.json<FoodResponse>()).toMatchObject({
      id: existing.id,
      name: 'Skyr',
      category: 'green',
    });
    expect(fixtures.db.select().from(foodTable).all()).toHaveLength(1);
  });

  it('refuses a category, because a colour is a verdict and not a field', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: 'Skyr', category: 'green' },
    });

    expect(response.statusCode).toBe(400);
    expect(problem(response.payload).type).toBe(PROBLEM.validationFailed);
  });

  it('refuses a name that is only whitespace', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: FOODS,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers a retry carrying the same Idempotency-Key without creating a second entry', async () => {
    const { app, fixtures } = await buildTestApp();
    const headers = {
      ...browser(fixtures.create.session(fixtures.userA)),
      'idempotency-key': 'k1',
    };

    const first = await app.inject({
      method: 'POST',
      url: FOODS,
      headers,
      payload: { name: 'Skyr' },
    });
    const retry = await app.inject({
      method: 'POST',
      url: FOODS,
      headers,
      payload: { name: 'Skyr' },
    });

    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(fixtures.db.select().from(foodTable).all()).toHaveLength(1);
  });
});

describe('reading one entry', () => {
  it('says which verdict won and where it came from', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Erdnussbutter' });
    fixtures.create.classification(food, { category: 'yellow' });
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'ai_text',
      model: 'claude-test',
      confidence: 0.62,
      reasoning: 'Energy dense as eaten.',
      assumptions: ['A normal spoonful'],
    });

    const response = await app.inject({
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(200);
    const detail = response.json<FoodDetailResponse>();
    expect(detail.category).toBe('orange');
    expect(detail.classification).toMatchObject({
      category: 'orange',
      source: 'ai_text',
      model: 'claude-test',
      confidence: 0.62,
      assumptions: ['A normal spoonful'],
    });
  });

  it('says null rather than inventing provenance for a food nobody judged', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Kohlrabi' });

    const response = await app.inject({
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.json<FoodDetailResponse>().classification).toBeNull();
  });

  it('answers a food that never existed and a deleted one the same way', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Gone' });
    fixtures.db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(eq(foodTable.id, food.id))
      .run();
    const headers = browser(fixtures.create.session(fixtures.userA));

    const deleted = await app.inject({ url: `${FOODS}/${food.id}`, headers });
    const never = await app.inject({
      url: `${FOODS}/0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31`,
      headers,
    });

    expect(deleted.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    expect(problem(deleted.payload).type).toBe(PROBLEM.notFound);
  });
});

describe('correcting an entry', () => {
  it('changes the name and the kind, and leaves the colour where it was', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({
      name: 'Spagetti Bolognese',
      kind: 'ingredient',
      createdBy: fixtures.userA.id,
    });
    fixtures.create.classification(food, { category: 'yellow' });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: 'Spaghetti Bolognese', kind: 'dish' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<FoodResponse>()).toMatchObject({
      name: 'Spaghetti Bolognese',
      kind: 'dish',
      category: 'yellow',
    });
  });

  it('has no field for a category at all, so one sent is a 400 rather than an edit', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Skyr', createdBy: fixtures.userA.id });
    fixtures.create.classification(food, { category: 'green' });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { category: 'orange' },
    });

    expect(response.statusCode).toBe(400);
  });

  it("refuses to let one user rename another user's entry", async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Skyr', createdBy: fixtures.userA.id });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userB)),
      payload: { name: 'Skyr Natur' },
    });

    // A rename is not the gentler half of a delete on a shared catalog. It takes the entry out
    // of the author's search and mislabels it in their history, meals included.
    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.insufficientScope);
    expect(storedFood(fixtures, food.id)?.name).toBe('Skyr');
  });

  it('refuses a seeded entry, which belongs to nobody and therefore to no user', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Skyr' });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: { name: 'Skyr Natur' },
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets an administrator correct somebody else's entry", async () => {
    const { app, fixtures } = await buildTestApp();
    const admin = fixtures.create.user({ role: 'admin' });
    const food = fixtures.create.food({ name: 'Spagetti', createdBy: fixtures.userA.id });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(admin)),
      payload: { name: 'Spaghetti' },
    });

    expect(response.statusCode).toBe(200);
    expect(storedFood(fixtures, food.id)?.name).toBe('Spaghetti');
  });

  it('treats an empty body as asking for nothing', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Skyr', createdBy: fixtures.userA.id });

    const response = await app.inject({
      method: 'PATCH',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<FoodResponse>().name).toBe('Skyr');
  });
});

describe('removing an entry', () => {
  function ownedBy(fixtures: TestFixtures, ownerId: string | null): FoodRow {
    return fixtures.create.food({
      name: `Owned ${ownerId ?? 'nobody'}`,
      ...(ownerId === null ? {} : { createdBy: ownerId }),
    });
  }

  it('soft deletes an entry its author added', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, fixtures.userA.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(204);
    expect(storedFood(fixtures, food.id)?.deletedAt).toBeInstanceOf(Date);
  });

  it("refuses to let one user remove another user's entry", async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, fixtures.userA.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userB)),
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.insufficientScope);
    expect(storedFood(fixtures, food.id)?.deletedAt).toBeNull();
  });

  it('refuses a seeded entry, which belongs to nobody and therefore to no user', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, null);

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(403);
  });

  it("lets an administrator remove somebody else's entry", async () => {
    const { app, fixtures } = await buildTestApp();
    const admin = fixtures.create.user({ role: 'admin' });
    const food = ownedBy(fixtures, fixtures.userA.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(admin)),
    });

    expect(response.statusCode).toBe(204);
  });

  it('refuses a food a meal names, so a history cannot grow holes', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, fixtures.userA.id);
    fixtures.create.meal(fixtures.userB, { items: [{ foodId: food.id }] });

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(409);
    expect(problem(response.payload).type).toBe(PROBLEM.foodInUse);
    expect(storedFood(fixtures, food.id)?.deletedAt).toBeNull();
  });

  it('answers a second delete as a 404 rather than a second success', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, fixtures.userA.id);
    const headers = browser(fixtures.create.session(fixtures.userA));

    await app.inject({ method: 'DELETE', url: `${FOODS}/${food.id}`, headers });
    const again = await app.inject({ method: 'DELETE', url: `${FOODS}/${food.id}`, headers });

    expect(again.statusCode).toBe(404);
  });

  it('refuses a mutation a browser sent from an origin this instance does not serve', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = ownedBy(fixtures, fixtures.userA.id);

    const response = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${fixtures.create.session(fixtures.userA)}`,
        origin: 'https://evil.test',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.csrfOriginRejected);
  });
});

/**
 * The log itself, unresolved. Every other endpoint in this file answers with the one verdict
 * that won, which is the only thing a client renders; this one answers with all of them, and
 * that is a question worth asking only because nothing ever overwrites one. See
 * docs/adr/007-append-only-classification-log.md.
 */
describe('the classification history of a food', () => {
  /**
   * Verdicts a minute apart. The factory stamps `createdAt` with the clock, so a chain written
   * in one test arrives inside a single millisecond and any assertion about its order would be
   * asserting the tiebreak instead of the ordering.
   */
  function minutesAgo(minutes: number): Date {
    return new Date(Date.UTC(2026, 0, 1, 12, 60 - minutes));
  }

  function historyOf(app: FastifyInstance, foodId: string, token: string) {
    return app.inject({
      url: `${FOODS}/${foodId}/classification/history`,
      headers: browser(token),
    });
  }

  it('answers with the whole chain, newest first', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food({ name: 'Peanut butter' });
    fixtures.create.classification(food, { category: 'orange', createdAt: minutesAgo(30) });
    fixtures.create.classification(food, {
      category: 'yellow',
      source: 'ai_text',
      model: 'claude-test',
      confidence: 0.62,
      createdAt: minutesAgo(20),
    });
    fixtures.create.classification(food, {
      category: 'green',
      source: 'user',
      userId: fixtures.userA.id,
      createdAt: minutesAgo(10),
    });

    const response = await historyOf(app, food.id, fixtures.create.session(fixtures.userA));
    const history = response.json<FoodClassificationResponse[]>();

    expect(response.statusCode).toBe(200);
    expect(history.map((row) => row.source)).toEqual(['user', 'ai_text', 'seed']);
    expect(history.map((row) => row.category)).toEqual(['green', 'yellow', 'orange']);
    // The provenance is the point of keeping the row rather than overwriting it: this is what
    // says the model was 62 percent sure of something a human then disagreed with.
    expect(history[1]).toMatchObject({ model: 'claude-test', confidence: 0.62 });
  });

  it('keeps the superseded verdict when a user changes their mind twice', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    const mine = { source: 'user', userId: fixtures.userA.id } as const;
    fixtures.create.classification(food, { category: 'green', ...mine, createdAt: minutesAgo(30) });
    fixtures.create.classification(food, {
      category: 'orange',
      ...mine,
      createdAt: minutesAgo(20),
    });
    fixtures.create.classification(food, {
      category: 'yellow',
      ...mine,
      createdAt: minutesAgo(10),
    });

    const history = (await historyOf(app, food.id, fixtures.create.session(fixtures.userA))).json<
      FoodClassificationResponse[]
    >();

    expect(history.map((row) => row.category)).toEqual(['yellow', 'orange', 'green']);
  });

  it("never shows one household member the other's opinion", async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    fixtures.create.classification(food, { category: 'green', createdAt: minutesAgo(30) });
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userB.id,
      createdAt: minutesAgo(10),
    });

    const forA = (await historyOf(app, food.id, fixtures.create.session(fixtures.userA))).json<
      FoodClassificationResponse[]
    >();
    const forB = (await historyOf(app, food.id, fixtures.create.session(fixtures.userB))).json<
      FoodClassificationResponse[]
    >();

    // A shares the shipped verdict with B and sees nothing else. B sees their own on top of it.
    expect(forA.map((row) => row.source)).toEqual(['seed']);
    expect(forB.map((row) => row.source)).toEqual(['user', 'seed']);
    // And the detail view agrees with the history it belongs to.
    const detail = await app.inject({
      url: `${FOODS}/${food.id}`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });
    expect(detail.json<FoodDetailResponse>().category).toBe('green');
  });

  it('answers with an empty chain for a food nobody has judged', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();

    const response = await historyOf(app, food.id, fixtures.create.session(fixtures.userA));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('answers 404 for a food that is not there, the same as the detail view', async () => {
    const { app, fixtures } = await buildTestApp();
    // Created by this user, so they are allowed to remove it. A deleted food and a food that
    // never existed get the same answer here, for the reason requireFood exists.
    const food = fixtures.create.food({ createdBy: fixtures.userA.id });
    const token = fixtures.create.session(fixtures.userA);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${FOODS}/${food.id}`,
      headers: browser(token),
    });
    expect(deleted.statusCode).toBe(204);

    expect((await historyOf(app, food.id, token)).statusCode).toBe(404);
  });
});

describe('searching the catalog', () => {
  const SEARCH = `${FOODS}/search`;

  it('ranks the caller own foods first, and answers with the colour resolved for them', async () => {
    const { app, fixtures } = await buildTestApp();
    const plain = fixtures.create.food({ name: 'Skyr Plain' });
    const mango = fixtures.create.food({ name: 'Skyr Mango' });
    fixtures.create.classification(plain, { category: 'green' });
    fixtures.create.classification(mango, { category: 'green' });
    fixtures.create.classification(mango, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
    });
    fixtures.create.meal(fixtures.userA, { items: [{ foodId: mango.id }] });

    const response = await app.inject({
      method: 'GET',
      url: `${SEARCH}?q=skyr`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(200);
    const results = JSON.parse(response.payload) as FoodResponse[];
    // The colour is here rather than a request away, which is the whole point: a dropdown that
    // fetches a category per row is a dropdown that draws grey and then repaints.
    expect(results.map((food) => [food.name, food.category])).toEqual([
      ['Skyr Mango', 'orange'],
      ['Skyr Plain', 'green'],
    ]);
  });

  it('gives the other household member their own colour and their own order', async () => {
    const { app, fixtures } = await buildTestApp();
    const plain = fixtures.create.food({ name: 'Skyr Plain' });
    const mango = fixtures.create.food({ name: 'Skyr Mango' });
    fixtures.create.classification(plain, { category: 'green' });
    fixtures.create.classification(mango, { category: 'green' });
    fixtures.create.classification(mango, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
    });
    fixtures.create.meal(fixtures.userA, { items: [{ foodId: mango.id }] });
    fixtures.create.meal(fixtures.userB, { items: [{ foodId: plain.id }] });

    const response = await app.inject({
      method: 'GET',
      url: `${SEARCH}?q=skyr`,
      headers: browser(fixtures.create.session(fixtures.userB)),
    });

    const results = JSON.parse(response.payload) as FoodResponse[];
    expect(results.map((food) => [food.name, food.category])).toEqual([
      ['Skyr Plain', 'green'],
      ['Skyr Mango', 'green'],
    ]);
  });

  it('answers an empty box with the useful default rather than a 400', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.food({ name: 'Aardvark Steak' });
    const usual = fixtures.create.food({ name: 'Zucchini' });
    fixtures.create.meal(fixtures.userA, { items: [{ foodId: usual.id }] });

    const response = await app.inject({
      method: 'GET',
      url: SEARCH,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.payload) as FoodResponse[])[0]?.name).toBe('Zucchini');
  });

  it('honours the limit and refuses one outside the range', async () => {
    const { app, fixtures } = await buildTestApp();
    for (const name of ['Skyr A', 'Skyr B', 'Skyr C']) {
      fixtures.create.food({ name });
    }
    const cookie = browser(fixtures.create.session(fixtures.userA));

    const page = await app.inject({
      method: 'GET',
      url: `${SEARCH}?q=skyr&limit=2`,
      headers: cookie,
    });
    expect(JSON.parse(page.payload)).toHaveLength(2);

    const tooMany = await app.inject({
      method: 'GET',
      url: `${SEARCH}?q=skyr&limit=500`,
      headers: cookie,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it('refuses a parameter nobody declared, the way every query string here does', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `${SEARCH}?q=skyr&kind=dish`,
      headers: browser(fixtures.create.session(fixtures.userA)),
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not let a query be read as FTS5 syntax', async () => {
    const { app, fixtures } = await buildTestApp();
    fixtures.create.food({ name: 'Skyr' });
    const cookie = browser(fixtures.create.session(fixtures.userA));

    for (const q of ['skyr OR quark', 'sky*', 'sky"r', '"', '((']) {
      const response = await app.inject({
        method: 'GET',
        url: `${SEARCH}?q=${encodeURIComponent(q)}`,
        headers: cookie,
      });

      expect(response.statusCode, `searching for ${q}`).toBe(200);
    }
  });

  it('needs a credential, like everything else in the catalog', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: `${SEARCH}?q=skyr` });

    expect(response.statusCode).toBe(401);
    expect(problem(response.payload).type).toBe(PROBLEM.unauthenticated);
  });
});
