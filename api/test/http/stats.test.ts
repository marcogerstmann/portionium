import type { StatsDaysResponse } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';

/**
 * GET /stats/days, POR-36. userA is Europe/Berlin, the same reasoning as meals.test.ts: a
 * timezone that is not UTC is what makes a wrong local date visible instead of right by luck.
 */

const WEB_ORIGIN = 'http://localhost:5173';
const STATS = `${API_PREFIX}/stats/days`;

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

function browser(token: string) {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: WEB_ORIGIN };
}

describe('GET /stats/days', () => {
  it('groups by local date and separates unclassified from any colour', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    const unjudged = fixtures.create.food();

    // 05:00 UTC is 06:00 in Berlin, past the default 04:00 boundary, the same offset
    // weight.test.ts relies on.
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-01T05:00:00.000Z'),
      items: [{ foodId: green.id }, { foodId: unjudged.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${STATS}?from=2026-03-01&to=2026-03-01`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(200);
    const { days } = response.json<StatsDaysResponse>();
    expect(days).toEqual([
      {
        date: '2026-03-01',
        counts: { green: 1, yellow: 0, orange: 0, unclassified: 1 },
        share: { green: 0.5, yellow: 0, orange: 0, unclassified: 0.5 },
      },
    ]);
  });

  it('fills a day nobody logged anything on with zero counts rather than omitting it', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-01T05:00:00.000Z'),
      items: [{ foodId: green.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${STATS}?from=2026-03-01&to=2026-03-03`,
      headers: browser(token),
    });

    const { days } = response.json<StatsDaysResponse>();
    expect(days.map((day) => day.date)).toEqual(['2026-03-01', '2026-03-02', '2026-03-03']);
    expect(days[1]?.counts).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 0 });
    expect(days[2]?.counts).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 0 });
  });

  it('never counts an item belonging to another account', async () => {
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    fixtures.create.classification(food, { category: 'green' });
    fixtures.create.meal(fixtures.userB, {
      loggedAt: new Date('2026-03-01T12:00:00.000Z'),
      items: [{ foodId: food.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${STATS}?from=2026-03-01&to=2026-03-01`,
      headers: browser(token),
    });

    expect(response.json<StatsDaysResponse>().days[0]?.counts).toEqual({
      green: 0,
      yellow: 0,
      orange: 0,
      unclassified: 0,
    });
  });

  it('changes immediately when a meal in the range is edited or deleted, nothing is cached', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    const { meal } = fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-01T05:00:00.000Z'),
      items: [{ foodId: green.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const before = await app.inject({
      url: `${STATS}?from=2026-03-01&to=2026-03-01`,
      headers: browser(token),
    });
    expect(before.json<StatsDaysResponse>().days[0]?.counts.green).toBe(1);

    await app.inject({
      method: 'DELETE',
      url: `${API_PREFIX}/meals/${meal.id}`,
      headers: browser(token),
    });

    const after = await app.inject({
      url: `${STATS}?from=2026-03-01&to=2026-03-01`,
      headers: browser(token),
    });
    expect(after.json<StatsDaysResponse>().days[0]?.counts).toEqual({
      green: 0,
      yellow: 0,
      orange: 0,
      unclassified: 0,
    });
  });

  it('stays a reasonably sized response for a full year', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-06-15T12:00:00.000Z'),
      items: [{ foodId: green.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${STATS}?from=2026-01-01&to=2026-12-31`,
      headers: browser(token),
    });

    const { days } = response.json<StatsDaysResponse>();
    expect(days).toHaveLength(365);
    expect(response.payload.length).toBeLessThan(100_000);
  });

  it('rejects a range where `to` is before `from`', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${STATS}?from=2026-03-05&to=2026-03-01`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(400);
  });

  it('requires both from and to', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${STATS}?from=2026-03-01`, headers: browser(token) });

    expect(response.statusCode).toBe(400);
  });
});
