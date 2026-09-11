import { PROBLEM, type ProblemDetails } from '@portionium/schemas';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { insertMealFavourite } from '../../src/db/meal-favourite.js';
import {
  apiTokenTable,
  mealFavouriteTable,
  mealItemTable,
  mealTable,
  sessionTable,
  weightEntryTable,
} from '../../src/db/schema/index.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { IDEMPOTENT_REPLAYED_HEADER } from '../../src/http/plugins/idempotency.js';
import { createTestFixtures, type TestFixtures, type UserRow } from '../helpers/fixtures.js';

/**
 * What one account can reach of another's, asked of every endpoint this API has.
 *
 * The claim this file exists to hold up is that a row belonging to somebody else is not
 * refused, it is invisible: a foreign id answers exactly what a missing one answers, and the
 * row it names is untouched afterwards. ADR 003 is why that is a 404 and never a 403.
 *
 * It is built so that adding a leaky endpoint later is hard to do quietly. COVERAGE below
 * names every authenticated route and says which of four things it is, and the first test in
 * the file compares that list against the routes the router actually has. A new endpoint is
 * therefore a failing test until somebody writes down what it exposes, and writing `owned`
 * against it is not a way out: the name has to resolve to an entry in OWNED, which comes with
 * probes that run.
 *
 * Every probe runs twice, once on a session cookie and once on a bearer token, because the two
 * are resolved by different branches of the auth plugin and only one of them is exercised by a
 * browser. See CREDENTIALS.
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
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

/** A row the test just wrote and therefore knows is there. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not written`);
  }

  return value;
}

/**
 * The two ways a caller proves who they are. Worth running everything twice: the plugin
 * resolves a bearer token against api_token and a cookie against session, so a filter that is
 * right on one path is not evidence about the other.
 *
 * The cookie carries an Origin because a browser always does and a mutation without one is
 * refused before anything else happens, see the CSRF check in plugins/auth.ts.
 */
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

/** A row's id, and what addresses it over HTTP. The two differ for weight, see WEIGHT_ENTRY. */
interface Address {
  id: string;
  path: string;
}

/** One request naming somebody else's row. */
interface Attempt {
  method: 'GET' | 'PATCH' | 'PUT' | 'DELETE';
  url(path: string): string;
  payload?: Record<string, unknown>;
}

/** An endpoint answering with a page of them. */
interface ListEndpoint {
  url: string;
  ids(body: unknown): string[];
  /** Whether limit and cursor mean anything here, for the tampering case. */
  paged: boolean;
}

interface OwnedResource {
  /** Reads as a sentence in the test name, and is the word COVERAGE refers to it by. */
  name: string;
  /** One belonging to this user. */
  create(fixtures: TestFixtures, owner: UserRow): Address;
  /** Every way the API lets a request name one. Each must answer 404 to a stranger. */
  attempts: readonly Attempt[];
  /**
   * Everything stored about it, compared before and after the stranger's attempts. A snapshot
   * rather than a "still exists" check, because a delete is not the only thing to be afraid of:
   * an edit that went through and answered 404 anyway would pass the weaker assertion.
   */
  snapshot(fixtures: TestFixtures, address: Address): unknown;
  /**
   * An address of the same shape that names nothing at all, so a foreign row and a missing one
   * can be compared answer for answer. A uuidv7 from another table is the honest version of
   * "an id that is not one of these": the params schema holds the shape, so a made up string
   * would be a 400 and would prove nothing.
   */
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
    items: fixtures.db.select().from(mealItemTable).where(eq(mealItemTable.mealId, id)).all(),
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
      items: [{ foodId: fixtures.create.food().id }],
    });

    return { id: stored.id, path: stored.id };
  },
  attempts: [{ method: 'DELETE', url: (id) => `${API_PREFIX}/meals/favourites/${id}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(mealFavouriteTable).where(eq(mealFavouriteTable.id, id)).get(),
  absent: (fixtures) => fixtures.create.food().id,
  lists: [{ url: `${API_PREFIX}/meals/favourites`, ids: page, paged: true }],
};

/**
 * No endpoint in this API names a weight entry by its id. The delete is addressed by local
 * date, which is the thing a client has, so `path` is the date and `id` is only what the
 * snapshot needs. A stranger sending the owner's date is the nearest expressible attempt, and
 * the test below it asserts that no id-addressed route appeared later.
 */
const WEIGHT_ENTRY: OwnedResource = {
  name: 'weight entry',
  create: (fixtures, owner) => {
    const entry = fixtures.create.weightEntry(owner);
    return { id: entry.id, path: entry.localDate };
  },
  attempts: [{ method: 'DELETE', url: (date) => `${API_PREFIX}/weight/${date}` }],
  snapshot: (fixtures, { id }) =>
    fixtures.db.select().from(weightEntryTable).where(eq(weightEntryTable.id, id)).get(),
  // A local date nobody in this suite records a reading on.
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

/**
 * Every user-owned thing a request can name by id today.
 *
 * Two the ticket lists are deliberately not here, because neither exists to be probed yet and
 * a probe against nothing passes for the wrong reason:
 *
 *   The export. There is no endpoint for it, so it will arrive as a route with no entry in
 *   COVERAGE, which is a failing test rather than something to remember.
 *
 *   MCP confirmation tokens. api/src/mcp is still a .gitkeep, and the adapter's own surface is
 *   not Fastify routes, so the story that adds it extends this table and gives that surface the
 *   equivalent of the COVERAGE check below.
 *
 * A meal item is not a row of its own here on purpose: nothing on the wire names one. Items are
 * written through their meal, so their isolation is the meal's, and the reference a client can
 * actually make is fromMealId, probed further down.
 */
const OWNED: readonly OwnedResource[] = [MEAL, FAVOURITE, WEIGHT_ENTRY, SESSION, API_TOKEN];

/**
 * What every authenticated route in this API exposes, in one place.
 *
 * Four answers, and the first test below is what makes writing one down unavoidable:
 *
 *   `owned`     a request can name another account's row by id. The entry in OWNED is what
 *               proves it answers 404 and changes nothing.
 *   `shared`    the route deals in the catalog, which is one set of rows for the instance on
 *               purpose. Listed here so that "everyone can see this" stays a decision.
 *   `resolved`  a shared row read through the caller's own verdict. Nothing foreign is
 *               nameable, but somebody else's opinion is exactly what must not come back.
 *   `personal`  the caller's own data, addressed by the request context and nothing else.
 *               There is no id in the request that could point somewhere else.
 */
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

  'GET /api/v1/stats/days': { personal: 'aggregates the caller own meals over a date range' },
  'GET /api/v1/stats/weight': { personal: 'aggregates the caller own weight over a date range' },
  'GET /api/v1/stats/weekly': { personal: 'both of the above, for one week' },

  'POST /api/v1/weight': { personal: 'records one for the caller' },
  'GET /api/v1/weight': { owned: 'weight entry' },
  'DELETE /api/v1/weight/:date': { owned: 'weight entry' },
};

describe('the registry', () => {
  /**
   * The whole point of the file. The router is the source, COVERAGE is the claim, and a new
   * endpoint is a failing test until somebody says what it exposes. A checklist somewhere else
   * would not have this property, which is what the ticket asks for.
   */
  it('accounts for every authenticated route the router actually has', async () => {
    const { app } = await buildTestApp();

    const authenticated = [...app.routeAuth]
      .filter(([, auth]) => auth !== 'public')
      .map(([route]) => route);

    expect(authenticated.sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  /**
   * And the obvious way out of it, closed: labelling a route `owned` is only worth something
   * if the name resolves to probes that run.
   */
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

/**
 * Weight is the one thing in here somebody would be hurt by leaking, and the ticket asks for it
 * to be verified as private rather than assumed. There is no id-addressed route at all: the
 * delete takes a local date, which is what a client has. This is what notices if one appears.
 */
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
    // There is no share, no grant and no visibility flag to test, which is the property. The
    // routes above are the whole surface and every one of them is scoped to request.auth.
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
        // A cursor is the last id of a page, so the stranger sending the owner's id is the
        // whole of "manipulating the pagination parameters": it is the one place a list takes
        // an id from the client at all.
        const queries = list.paged
          ? ['', '?limit=100', `?cursor=${theirs.id}`, `?limit=100&cursor=${theirs.id}`]
          : [''];

        for (const query of queries) {
          const where = `${list.url}${query}`;
          const response = await app.inject({ url: where, headers });

          expect(response.statusCode, where).toBe(200);
          expect(list.ids(response.json()), where).not.toContain(theirs.id);
        }

        // And the list is not empty for an unrelated reason, which would make the assertion
        // above true of a broken endpoint as easily as of a correct one.
        const mine = await app.inject({ url: list.url, headers });
        expect(list.ids(mine.json()), list.url).toContain(own.id);
      }
    });
  });
});

describe.each(CREDENTIALS)('with $name on both sides', (credential) => {
  /**
   * The catalog is shared and a verdict about it is not. Nothing here is addressable by a
   * stranger, so the failure to look for is disclosure: one household member reading a food
   * and getting the other's opinion of it back.
   */
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

      // A withdrawal is keyed by food and caller, so this one is about a verdict that is not
      // there. It must not reach across to the one that is.
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

  /**
   * The catalog itself, listed as shared on purpose. Everything above is about what one account
   * cannot reach; this is the one place where reaching across is the intended behaviour, and it
   * is asserted rather than left as an absence of tests.
   */
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

        // 403 rather than the 404 a private row gets, and it leaks nothing: every account can
        // read this id already. See requireAuthorOrAdmin in routes/foods.ts.
        expect(refused.statusCode).toBe(403);
        expect(problem(refused.payload).type).toBe(PROBLEM.insufficientScope);

        const still = await app.inject({ url: `${API_PREFIX}/foods/${id}`, headers: mine });
        expect(still.json<{ name: string }>().name).toBe('Ada Bread');
      },
    );
  });

  /**
   * A write that names somebody else's row inside its body rather than in the path. There is
   * no client supplied `mealId` on an item, items are written through their meal, so the
   * reference the ticket asks about is `fromMealId`: copy that meal's items into a new one.
   */
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
          items: [{ foodId: fixtures.create.food().id }],
        },
      });

      // The revive-on-conflict path is correlated on the owner, so a foreign id matches no row
      // to update and nothing is written. See insertMeal in db/meal.ts.
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
        payload: { name: 'Toast', type: 'breakfast', items: [{ foodId: id }] },
      });

      expect(favourite.statusCode).toBe(201);
    });
  });

  /**
   * The key is filed under the caller, so the same string from two accounts is two keys. If it
   * were not, the second account would be handed the first one's stored response body.
   */
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

  /**
   * The strongest version of the session and token cases: not just that the row survived a
   * stranger's delete, but that the credential it stands for still opens the door afterwards.
   */
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
