import type { StatsDaysResponse, StatsWeightResponse } from '@portionium/schemas';
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
const WEIGHT_STATS = `${API_PREFIX}/stats/weight`;

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

/**
 * GET /stats/weight, POR-37. The arithmetic is covered against synthetic series in
 * src/domain/weight-trend.test.ts, which is where a flat month of noise and a fortnight's gap
 * belong. What is left for here is the wiring: kilograms rather than grams, the trend ahead of
 * the raw reading, readings from before the range warming the line, and one account's scale
 * never appearing in another's.
 */
describe('GET /stats/weight', () => {
  /** A reading a day from `start`, at 05:00 UTC, which is past userA's 04:00 Berlin boundary. */
  function weighDaily(
    fixtures: TestFixtures,
    user: Parameters<TestFixtures['create']['weightEntry']>[0],
    start: string,
    grams: readonly number[],
  ): void {
    for (const [index, weightGrams] of grams.entries()) {
      const date = new Date(Date.parse(`${start}T05:00:00.000Z`) + index * 86_400_000);
      fixtures.create.weightEntry(user, { weightGrams, recordedAt: date });
    }
  }

  it('answers in kilograms, one entry per day, with the raw reading beside the trend', async () => {
    const { app, fixtures } = await buildTestApp();
    weighDaily(fixtures, fixtures.userA, '2026-03-01', [80_000, 80_400, 79_800]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-01&to=2026-03-04`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(200);
    const { days } = response.json<StatsWeightResponse>();

    expect(days.map((day) => day.date)).toEqual([
      '2026-03-01',
      '2026-03-02',
      '2026-03-03',
      '2026-03-04',
    ]);
    expect(days[0]?.rawKg).toBe(80);
    expect(days[0]?.trendKg).toBe(80);
    expect(days[0]?.lowConfidence).toBe(true);

    // The fourth day has no reading and still has a trend, carried forward from the third.
    expect(days[3]?.rawKg).toBeNull();
    expect(days[3]?.trendKg).toBe(days[2]?.trendKg);

    // Kilograms to the gram, never a float with a tail on it.
    for (const day of days) {
      expect(String(day.trendKg ?? 0)).toMatch(/^\d+(\.\d{1,3})?$/);
    }
  });

  it('smooths, so the trend moves by a fraction of what the raw reading does', async () => {
    const { app, fixtures } = await buildTestApp();
    weighDaily(fixtures, fixtures.userA, '2026-03-01', [80_000, 82_000]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-01&to=2026-03-02`,
      headers: browser(token),
    });

    const { days } = response.json<StatsWeightResponse>();
    // Two kilos overnight is a scale, a holiday or a different pair of shoes, never two kilos
    // of anybody. At a ten day half life the line moves about 130 grams of it.
    expect(days[1]?.rawKg).toBe(82);
    expect(days[1]?.trendKg ?? 0).toBeGreaterThan(80);
    expect(days[1]?.trendKg ?? 0).toBeLessThan(80.2);
  });

  it('compares the range with the equally long stretch of days before it', async () => {
    const { app, fixtures } = await buildTestApp();
    // A fortnight losing a hundred grams a day, then a fortnight holding steady.
    weighDaily(fixtures, fixtures.userA, '2026-03-01', [
      ...Array.from({ length: 14 }, (_, index) => 82_000 - index * 100),
      ...Array.from({ length: 14 }, () => 80_600),
    ]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-22&to=2026-03-28`,
      headers: browser(token),
    });

    const { change, previous, versusPrevious } = response.json<StatsWeightResponse>();

    expect(change.from).toBe('2026-03-22');
    expect(change.to).toBe('2026-03-28');
    expect(previous.from).toBe('2026-03-15');
    expect(previous.to).toBe('2026-03-21');

    // Both weeks are still falling as the trend pays off the lag it took on during the decline,
    // and this one fell less than the one before it, which is the decline levelling out.
    expect(change.changeKg ?? 0).toBeLessThan(0);
    expect(change.changeKg ?? 0).toBeGreaterThan(previous.changeKg ?? 0);
    // The rate a person reasons about, per week rather than per day.
    expect(change.changePerWeekKg).not.toBeNull();

    // Subtracted on the way out, so a client draws the comparison rather than computing it.
    expect(versusPrevious.differenceKg).toBeGreaterThan(0);
    expect(versusPrevious.differencePerWeekKg).toBeGreaterThan(0);
  });

  it('warms the trend on readings from before the range rather than restarting it at `from`', async () => {
    const { app, fixtures } = await buildTestApp();
    // A month at 80 kg, then one heavy morning on the first day of the range.
    weighDaily(fixtures, fixtures.userA, '2026-03-01', [
      ...Array.from({ length: 30 }, () => 80_000),
      81_500,
    ]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-31&to=2026-03-31`,
      headers: browser(token),
    });

    const { days } = response.json<StatsWeightResponse>();
    // A line that started at `from` would read 81.5 and call it a kilo and a half gained.
    expect(days[0]?.rawKg).toBe(81.5);
    expect(days[0]?.trendKg ?? 0).toBeLessThan(80.2);
    expect(days[0]?.lowConfidence).toBe(false);
  });

  it('never shows another account a reading', async () => {
    const { app, fixtures } = await buildTestApp();
    weighDaily(fixtures, fixtures.userB, '2026-03-01', [80_000, 80_000, 80_000]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-01&to=2026-03-03`,
      headers: browser(token),
    });

    const { days, change } = response.json<StatsWeightResponse>();
    expect(days.map((day) => day.trendKg)).toEqual([null, null, null]);
    expect(days.every((day) => day.lowConfidence)).toBe(true);
    expect(change).toEqual({ from: null, to: null, changeKg: null, changePerWeekKg: null });
    expect(response.json<StatsWeightResponse>().versusPrevious).toEqual({
      differenceKg: null,
      differencePerWeekKg: null,
    });
  });

  it('rejects a range where `to` is before `from`', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEIGHT_STATS}?from=2026-03-05&to=2026-03-01`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(400);
  });
});
