import { PROBLEM, type ProblemDetails } from '@portionium/schemas';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { insertMealFavourite } from '../../src/db/meal-favourite.js';
import {
  apiTokenTable,
  mealFavouriteTable,
  entryTable,
  mealTable,
  sessionTable,
  weightEntryTable,
} from '../../src/db/schema/index.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../src/http/plugins/idempotency.js';
import { createTestFixtures, type TestFixtures, type UserRow } from '../helpers/fixtures.js';

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
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not written`);
  }

  return value;
}

interface Credential {
  name: string;
  headers(fixtures: TestFixtures, user: UserRow): Record<string, string>;
}

const CREDENTIALS: readonly Credential[] = [
  {
    name: 'a session cookie',
    headers: (fixtures, user) => ({
      cookie: `${SESSION_COOKIE_NAME}=${fixtures.create.session(user)}`,
      origin: WEB_ORIGIN,
    }),
  },
  {
    name: 'a bearer token',
    headers: (fixtures, user) => ({
      authorization: `Bearer ${fixtures.create.apiToken(user)}`,
    }),
  },
];

interface Address {
  id: string;
  path: string;
}

interface Attempt {
  method: 'GET' | 'PATCH' | 'PUT' | 'DELETE';
  url(path: string): string;
  payload?: Record<string, unknown>;
}

interface ListEndpoint {
  url: string;
  ids(body: unknown): string[];
  paged: boolean;
}

interface OwnedResource {
  name: string;
  create(fixtures: TestFixtures, owner: UserRow): Address;
  attempts: readonly Attempt[];
  snapshot(fixtures: TestFixtures, address: Address): unknown;
  absent(fixtures: TestFixtures): string;
  lists: readonly ListEndpoint[];
}

const page = (body: unknown): string[] =>
  (body as { items: { id: string }[] }).items.map((item) => item.id);

const bare = (body: unknown): string[] => (body as { id: string }[]).map((item) => item.id);

const MEAL: OwnedResource = {
  name: 'meal',
  create: (fixtures, owner) => {
    const { meal } = fixtures.create.meal(owner, { notes: 'the owner wrote this' });
    return { id: meal.id, path: meal.id };
  },
  attempts: [
    { method: 'PATCH', url: (id) => `${API_PREFIX}/meals/${id}`, payload: { notes: 'taken' } },
    { method: 'DELETE', url: (id) => `${API_PREFIX}/meals/${id}` },
  ],
  snapshot: (fixtures, { id }) => ({
    meal: fixtures.db.select().from(mealTable).where(eq(mealTable.id, id)).get(),
    entries: fixtures.db.select().from(entryTable).where(eq(entryTable.mealId, id)).all(),
  }),
  absent: (fixtures) => fixtures.create.food().id,
  lists: [{ url: `${API_PREFIX}/meals`, ids: page, paged: true }],
};

const FAVOURITE: OwnedResource = {
  name: 'favourite',
  create: (fixtures, owner) => {
    const stored = insertMealFavourite(fixtures.db, {
      userId: owner.id,
      name: 'The usual',
      type: 'lunch',
      entries: [{ foodId: fixtures.create.food().id }],
    });

    return { id: stored.id, path: stored.id };
  },
  attempts: [{ method: 'DELETE', url: (id) => `${API_PREFIX}/meals/favourites/${id}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(mealFavouriteTable).where(eq(mealFavouriteTable.id, id)).get(),
  absent: (fixtures) => fixtures.create.food().id,
  lists: [{ url: `${API_PREFIX}/meals/favourites`, ids: page, paged: true }],
};

const WEIGHT_ENTRY: OwnedResource = {
  name: 'weight entry',
  create: (fixtures, owner) => {
    const entry = fixtures.create.weightEntry(owner);
    return { id: entry.id, path: entry.localDate };
  },
  attempts: [{ method: 'DELETE', url: (date) => `${API_PREFIX}/weight/${date}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(weightEntryTable).where(eq(weightEntryTable.id, id)).get(),
  absent: () => '2001-02-03',
  lists: [{ url: `${API_PREFIX}/weight`, ids: page, paged: true }],
};

const SESSION: OwnedResource = {
  name: 'session',
  create: (fixtures, owner) => {
    fixtures.create.session(owner);
    const row = must(
      fixtures.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, owner.id))
        .orderBy(desc(sessionTable.id))
        .get(),
      "the owner's session",
    );

    return { id: row.id, path: row.id };
  },
  attempts: [{ method: 'DELETE', url: (id) => `${API_PREFIX}/auth/sessions/${id}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(sessionTable).where(eq(sessionTable.id, id)).get(),
  absent: (fixtures) => fixtures.create.food().id,
  lists: [{ url: `${API_PREFIX}/auth/sessions`, ids: bare, paged: false }],
};

const API_TOKEN: OwnedResource = {
  name: 'api token',
  create: (fixtures, owner) => {
    fixtures.create.apiToken(owner);
    const row = must(
      fixtures.db
        .select()
        .from(apiTokenTable)
        .where(eq(apiTokenTable.userId, owner.id))
        .orderBy(desc(apiTokenTable.id))
        .get(),
      "the owner's api token",
    );

    return { id: row.id, path: row.id };
  },
  attempts: [{ method: 'DELETE', url: (id) => `${API_PREFIX}/auth/tokens/${id}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(apiTokenTable).where(eq(apiTokenTable.id, id)).get(),
  absent: (fixtures) => fixtures.create.food().id,
  lists: [{ url: `${API_PREFIX}/auth/tokens`, ids: bare, paged: false }],
};

const OWNED: readonly OwnedResource[] = [MEAL, FAVOURITE, WEIGHT_ENTRY, SESSION, API_TOKEN];

type Coverage =
  { owned: string } | { shared: string } | { resolved: string } | { personal: string };

const COVERAGE: Record<string, Coverage> = {
  'POST /api/v1/auth/logout': { personal: 'ends the session the request arrived on' },
  'GET /api/v1/auth/sessions': { owned: 'session' },
  'DELETE /api/v1/auth/sessions/:id': { owned: 'session' },
  'POST /api/v1/auth/tokens': { personal: 'mints one for the caller, with at most their scopes' },
  'GET /api/v1/auth/tokens': { owned: 'api token' },
  'DELETE /api/v1/auth/tokens/:id': { owned: 'api token' },

  'GET /api/v1/foods': { resolved: 'the catalog, each colour resolved for the caller' },
  'GET /api/v1/foods/search': { resolved: 'the catalog, ranked by the caller own history' },
  'GET /api/v1/foods/unclassified': { resolved: 'what has no verdict visible to this caller' },
  'GET /api/v1/foods/unclassified/count': { resolved: 'the same question, counted' },
  'POST /api/v1/foods/unclassified/confirm': { resolved: 'writes verdicts owned by the caller' },
  'POST /api/v1/foods': { shared: 'adds to the one catalog, or returns the entry that matches' },
  'POST /api/v1/foods/classify': {
    shared: 'adds to the one catalog, and the model verdict it writes belongs to everybody',
  },
  'GET /api/v1/foods/:id': { resolved: 'a catalog entry, coloured for the caller' },
  'GET /api/v1/foods/:id/classification/history': {
    resolved: 'the shared verdicts and the caller own, never a third account',
  },
  'PUT /api/v1/foods/:id/classification': { resolved: 'writes a verdict owned by the caller' },
  'DELETE /api/v1/foods/:id/classification': { resolved: 'withdraws the caller own verdict' },
  'PATCH /api/v1/foods/:id': { shared: 'author or admin only, see requireAuthorOrAdmin' },
  'DELETE /api/v1/foods/:id': { shared: 'author or admin only, see requireAuthorOrAdmin' },

  'GET /api/v1/me': { personal: 'the caller, and no spelling of it takes an id' },
  'PATCH /api/v1/me': { personal: 'the caller, and no spelling of it takes an id' },
  'GET /api/v1/me/budgets': { personal: 'the caller own allowance, and no spelling takes an id' },
  'PUT /api/v1/me/budgets': { personal: 'sets the caller own allowance, nobody else reachable' },
  'POST /api/v1/me/password': { personal: 'the caller, on a session rather than a token' },

  'POST /api/v1/meals': { personal: 'logs one for the caller; fromMealId is probed below' },
  'PATCH /api/v1/meals/:id': { owned: 'meal' },
  'DELETE /api/v1/meals/:id': { owned: 'meal' },
  'GET /api/v1/meals': { owned: 'meal' },
  'GET /api/v1/days/:date': { personal: 'the caller own day, addressed by a date' },
  'GET /api/v1/meals/suggestions': { personal: 'ranked over the caller own history' },
  'POST /api/v1/meals/favourites': { personal: 'pins one for the caller' },
  'GET /api/v1/meals/favourites': { owned: 'favourite' },
  'DELETE /api/v1/meals/favourites/:id': { owned: 'favourite' },

  'GET /api/v1/stats/budget': {
    personal: 'counts the caller own week against the caller own limits',
  },
  'GET /api/v1/stats/days': { personal: 'aggregates the caller own meals over a date range' },
  'GET /api/v1/stats/weight': { personal: 'aggregates the caller own weight over a date range' },
  'GET /api/v1/stats/weekly': { personal: 'both of the above, for one week' },

  'POST /api/v1/weight': { personal: 'records one for the caller' },
  'GET /api/v1/weight': { owned: 'weight entry' },
  'DELETE /api/v1/weight/:date': { owned: 'weight entry' },
};

describe('the registry', () => {
  it('accounts for every authenticated route the router actually has', async () => {
    const { app } = await buildTestApp();

    const authenticated = [...app.routeAuth]
      .filter(([, auth]) => auth !== 'public')
      .map(([route]) => route);

    expect(authenticated.sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  it('has probes for every resource a route is labelled as owning', () => {
    const labelled = new Set(
      Object.values(COVERAGE).flatMap((entry) => ('owned' in entry ? [entry.owned] : [])),
    );

    expect([...labelled].sort()).toEqual(OWNED.map((resource) => resource.name).sort());
  });

  it('leaves the public surface to its own audit', async () => {
    const { app } = await buildTestApp();

    for (const route of app.publicRoutes) {
      expect(COVERAGE[route]).toBeUndefined();
    }
  });
});

describe('weight', () => {
  it('is never addressed by an entry id on any route', async () => {
    const { app } = await buildTestApp();

    const routes = [...app.routeAuth.keys()].filter((route) => route.includes('weight'));

    expect(routes.sort()).toEqual([
      'DELETE /api/v1/weight/:date',
      'GET /api/v1/stats/weight',
      'GET /api/v1/weight',
      'POST /api/v1/weight',
    ]);
    for (const route of routes) {
      expect(route).not.toContain(':id');
    }
  });

  it('has no endpoint that shares an entry with another account', () => {
    expect(Object.entries(COVERAGE).filter(([route]) => route.includes('weight'))).toHaveLength(4);
  });
});

describe.each(CREDENTIALS)('a stranger holding $name', (credential) => {
  describe.each(OWNED)("against another account's $name", (resource) => {
    it.each(resource.attempts)('is answered 404 by $method', async (attempt) => {
      const { app, fixtures } = await buildTestApp();
      const address = resource.create(fixtures, fixtures.userA);
      const headers = credential.headers(fixtures, fixtures.userB);

      const response = await app.inject({
        method: attempt.method,
        url: attempt.url(address.path),
        headers,
        ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
      });

      expect(response.statusCode).toBe(404);
      expect(problem(response.payload).type).toBe(PROBLEM.notFound);
    });

    it.each(resource.attempts)('changes nothing by trying $method', async (attempt) => {
      const { app, fixtures } = await buildTestApp();
      const address = resource.create(fixtures, fixtures.userA);
      const before = resource.snapshot(fixtures, address);
      const headers = credential.headers(fixtures, fixtures.userB);

      await app.inject({
        method: attempt.method,
        url: attempt.url(address.path),
        headers,
        ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
      });

      expect(resource.snapshot(fixtures, address)).toEqual(before);
    });

    it.each(resource.attempts)(
      'cannot tell it apart from one that never existed, on $method',
      async (attempt) => {
        const { app, fixtures } = await buildTestApp();
        const address = resource.create(fixtures, fixtures.userA);
        const headers = credential.headers(fixtures, fixtures.userB);

        const send = (path: string) =>
          app.inject({
            method: attempt.method,
            url: attempt.url(path),
            headers,
            ...(attempt.payload === undefined ? {} : { payload: attempt.payload }),
          });

        const foreign = problem((await send(address.path)).payload);
        const missing = problem((await send(resource.absent(fixtures))).payload);

        expect(foreign.status).toBe(missing.status);
        expect(foreign.type).toBe(missing.type);
        expect(foreign.title).toBe(missing.title);
        expect(foreign.detail).toBe(missing.detail);
      },
    );

    it('is in no page of a list, however that page is asked for', async () => {
      const { app, fixtures } = await buildTestApp();
      const theirs = resource.create(fixtures, fixtures.userA);
      const own = resource.create(fixtures, fixtures.userB);
      const headers = credential.headers(fixtures, fixtures.userB);

      for (const list of resource.lists) {
        const queries = list.paged
          ? ['', '?limit=100', `?cursor=${theirs.id}`, `?limit=100&cursor=${theirs.id}`]
          : [''];

        for (const query of queries) {
          const where = `${list.url}${query}`;
          const response = await app.inject({ url: where, headers });

          expect(response.statusCode, where).toBe(200);
          expect(list.ids(response.json()), where).not.toContain(theirs.id);
        }

        const mine = await app.inject({ url: list.url, headers });
        expect(list.ids(mine.json()), list.url).toContain(own.id);
      }
    });
  });
});

describe.each(CREDENTIALS)('with $name on both sides', (credential) => {
  describe('a private verdict on a shared food', () => {
    it('never colours the same food for anybody else', async () => {
      const { app, fixtures } = await buildTestApp();
      const skyr = fixtures.create.food({ name: 'Skyr' });
      fixtures.create.classification(skyr, { category: 'green' });
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      const overridden = await app.inject({
        method: 'PUT',
        url: `${API_PREFIX}/foods/${skyr.id}/classification`,
        headers: mine,
        payload: { category: 'orange', reasoning: 'private to user A' },
      });
      expect(overridden.statusCode).toBe(200);

      const asOwner = await app.inject({ url: `${API_PREFIX}/foods/${skyr.id}`, headers: mine });
      const asStranger = await app.inject({
        url: `${API_PREFIX}/foods/${skyr.id}`,
        headers: theirs,
      });

      expect(asOwner.json<{ category: string }>().category).toBe('orange');
      expect(asStranger.json<{ category: string }>().category).toBe('green');
    });

    it('stays out of the history another account reads', async () => {
      const { app, fixtures } = await buildTestApp();
      const skyr = fixtures.create.food({ name: 'Skyr' });
      fixtures.create.classification(skyr, { category: 'green' });
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      await app.inject({
        method: 'PUT',
        url: `${API_PREFIX}/foods/${skyr.id}/classification`,
        headers: mine,
        payload: { category: 'orange', reasoning: 'private to user A' },
      });

      const history = await app.inject({
        url: `${API_PREFIX}/foods/${skyr.id}/classification/history`,
        headers: theirs,
      });

      const rows = history.json<{ source: string; reasoning?: string }[]>();
      expect(rows.map((row) => row.source)).toEqual(['seed']);
      expect(history.payload).not.toContain('private to user A');
    });

    it('is not withdrawn by another account withdrawing theirs', async () => {
      const { app, fixtures } = await buildTestApp();
      const skyr = fixtures.create.food({ name: 'Skyr' });
      fixtures.create.classification(skyr, { category: 'green' });
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      await app.inject({
        method: 'PUT',
        url: `${API_PREFIX}/foods/${skyr.id}/classification`,
        headers: mine,
        payload: { category: 'orange' },
      });

      const withdrawn = await app.inject({
        method: 'DELETE',
        url: `${API_PREFIX}/foods/${skyr.id}/classification`,
        headers: theirs,
      });
      expect(withdrawn.statusCode).toBe(204);

      const afterwards = await app.inject({ url: `${API_PREFIX}/foods/${skyr.id}`, headers: mine });
      expect(afterwards.json<{ category: string }>().category).toBe('orange');
    });

    it('does not take the food out of anybody else review queue', async () => {
      const { app, fixtures } = await buildTestApp();
      const unjudged = fixtures.create.food({ name: 'Unjudged' });
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      await app.inject({
        method: 'PUT',
        url: `${API_PREFIX}/foods/${unjudged.id}/classification`,
        headers: mine,
        payload: { category: 'green' },
      });

      const queue = await app.inject({ url: `${API_PREFIX}/foods/unclassified`, headers: theirs });
      const count = await app.inject({
        url: `${API_PREFIX}/foods/unclassified/count`,
        headers: theirs,
      });

      expect(queue.json<{ id: string }[]>().map((food) => food.id)).toContain(unjudged.id);
      expect(count.json<{ count: number }>().count).toBeGreaterThan(0);

      const ownQueue = await app.inject({ url: `${API_PREFIX}/foods/unclassified`, headers: mine });
      expect(ownQueue.json<{ id: string }[]>().map((food) => food.id)).not.toContain(unjudged.id);
    });
  });

  describe('the shared catalog', () => {
    it('lets anybody read an entry another account added', async () => {
      const { app, fixtures } = await buildTestApp();
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      const created = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/foods`,
        headers: mine,
        payload: { name: 'Ada Bread', kind: 'ingredient' },
      });
      expect(created.statusCode).toBe(201);
      const { id } = created.json<{ id: string }>();

      const read = await app.inject({ url: `${API_PREFIX}/foods/${id}`, headers: theirs });
      expect(read.statusCode).toBe(200);
      expect(read.json<{ name: string }>().name).toBe('Ada Bread');
    });

    const writes: readonly [
      method: 'PATCH' | 'DELETE',
      payload: Record<string, unknown> | undefined,
    ][] = [
      ['PATCH', { name: 'Renamed' }],
      ['DELETE', undefined],
    ];

    it.each(writes)(
      'refuses %s of it with 403, not the 404 a private row gets',
      async (method, payload) => {
        const { app, fixtures } = await buildTestApp();
        const mine = credential.headers(fixtures, fixtures.userA);
        const theirs = credential.headers(fixtures, fixtures.userB);

        const created = await app.inject({
          method: 'POST',
          url: `${API_PREFIX}/foods`,
          headers: mine,
          payload: { name: 'Ada Bread', kind: 'ingredient' },
        });
        const { id } = created.json<{ id: string }>();

        const refused = await app.inject({
          method,
          url: `${API_PREFIX}/foods/${id}`,
          headers: theirs,
          ...(payload === undefined ? {} : { payload }),
        });

        expect(refused.statusCode).toBe(403);
        expect(problem(refused.payload).type).toBe(PROBLEM.insufficientScope);

        const still = await app.inject({ url: `${API_PREFIX}/foods/${id}`, headers: mine });
        expect(still.json<{ name: string }>().name).toBe('Ada Bread');
      },
    );
  });

  describe('a write referencing another account row', () => {
    it('cannot copy a meal it does not own', async () => {
      const { app, fixtures } = await buildTestApp();
      const { meal } = fixtures.create.meal(fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/meals`,
        headers: theirs,
        payload: { type: 'lunch', fromMealId: meal.id },
      });

      expect(response.statusCode).toBe(404);
      expect(problem(response.payload).type).toBe(PROBLEM.notFound);
    });

    it('cannot overwrite a meal by claiming its id on a create', async () => {
      const { app, fixtures } = await buildTestApp();
      const { meal } = fixtures.create.meal(fixtures.userA, { notes: 'the owner wrote this' });
      const theirs = credential.headers(fixtures, fixtures.userB);

      const response = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/meals`,
        headers: theirs,
        payload: {
          id: meal.id,
          type: 'dinner',
          notes: 'taken',
          entries: [{ foodId: fixtures.create.food().id }],
        },
      });

      expect(response.statusCode).toBe(409);

      const stored = fixtures.db.select().from(mealTable).where(eq(mealTable.id, meal.id)).get();
      expect(stored?.userId).toBe(fixtures.userA.id);
      expect(stored?.notes).toBe('the owner wrote this');
      expect(stored?.type).toBe('lunch');
    });

    it('can still point a favourite at a food somebody else added, which is the catalog', async () => {
      const { app, fixtures } = await buildTestApp();
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      const created = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/foods`,
        headers: mine,
        payload: { name: 'Ada Bread', kind: 'ingredient' },
      });
      const { id } = created.json<{ id: string }>();

      const favourite = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/meals/favourites`,
        headers: theirs,
        payload: { name: 'Toast', type: 'breakfast', entries: [{ foodId: id }] },
      });

      expect(favourite.statusCode).toBe(201);
    });
  });

  describe('an idempotency key', () => {
    const KEY = 'a-key-both-accounts-happen-to-pick';
    const body = { weightKg: 81 };

    it('is not replayable by anybody else', async () => {
      const { app, fixtures } = await buildTestApp();
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);

      const first = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/weight`,
        headers: { ...mine, 'idempotency-key': KEY },
        payload: body,
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/weight`,
        headers: { ...theirs, 'idempotency-key': KEY },
        payload: body,
      });

      expect(second.statusCode).toBe(201);
      expect(second.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();

      const mineId = first.json<{ id: string }>().id;
      const theirsId = second.json<{ id: string }>().id;
      expect(theirsId).not.toBe(mineId);

      const row = fixtures.db
        .select()
        .from(weightEntryTable)
        .where(eq(weightEntryTable.id, theirsId))
        .get();
      expect(row?.userId).toBe(fixtures.userB.id);
    });

    it('still replays for the account that stored it', async () => {
      const { app, fixtures } = await buildTestApp();
      const mine = credential.headers(fixtures, fixtures.userA);
      const theirs = credential.headers(fixtures, fixtures.userB);
      const headers = { ...mine, 'idempotency-key': KEY };

      const first = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/weight`,
        headers,
        payload: body,
      });

      await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/weight`,
        headers: { ...theirs, 'idempotency-key': KEY },
        payload: body,
      });

      const replay = await app.inject({
        method: 'POST',
        url: `${API_PREFIX}/weight`,
        headers,
        payload: body,
      });

      expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe('true');
      expect(replay.payload).toBe(first.payload);
    });
  });

  describe('a credential somebody else tried to revoke', () => {
    it('still authenticates its owner', async () => {
      const { app, fixtures } = await buildTestApp();
      const ownToken = fixtures.create.apiToken(fixtures.userA);
      const row = must(
        fixtures.db
          .select()
          .from(apiTokenTable)
          .where(eq(apiTokenTable.userId, fixtures.userA.id))
          .orderBy(desc(apiTokenTable.id))
          .get(),
        "the owner's api token",
      );
      const theirs = credential.headers(fixtures, fixtures.userB);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `${API_PREFIX}/auth/tokens/${row.id}`,
        headers: theirs,
      });
      expect(revoked.statusCode).toBe(404);

      const afterwards = await app.inject({
        url: `${API_PREFIX}/me`,
        headers: { authorization: `Bearer ${ownToken}` },
      });

      expect(afterwards.statusCode).toBe(200);
      expect(afterwards.json<{ id: string }>().id).toBe(fixtures.userA.id);
    });
  });
});
