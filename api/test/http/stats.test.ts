import type {
  StatsBudgetResponse,
  StatsDaysResponse,
  StatsWeeklyResponse,
  StatsWeightResponse,
} from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures } from '../helpers/fixtures.js';
import { freezeTime } from '../helpers/time.js';

const WEB_ORIGIN = 'http://localhost:5173';
const STATS = `${API_PREFIX}/stats/days`;
const WEIGHT_STATS = `${API_PREFIX}/stats/weight`;
const WEEKLY_STATS = `${API_PREFIX}/stats/weekly`;
const BUDGET_STATS = `${API_PREFIX}/stats/budget`;
const BUDGETS = `${API_PREFIX}/me/budgets`;

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

describe('GET /stats/days', () => {
  it('groups by local date and separates unclassified from any colour', async () => {
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    const unjudged = fixtures.create.food();

    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-01T05:00:00.000Z'),
      entries: [{ foodId: green.id }, { foodId: unjudged.id }],
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
      entries: [{ foodId: green.id }],
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
      entries: [{ foodId: food.id }],
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
      entries: [{ foodId: green.id }],
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
      entries: [{ foodId: green.id }],
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

describe('GET /stats/weight', () => {
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

    expect(days[3]?.rawKg).toBeNull();
    expect(days[3]?.trendKg).toBe(days[2]?.trendKg);

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
    expect(days[1]?.rawKg).toBe(82);
    expect(days[1]?.trendKg ?? 0).toBeGreaterThan(80);
    expect(days[1]?.trendKg ?? 0).toBeLessThan(80.2);
  });

  it('compares the range with the equally long stretch of days before it', async () => {
    const { app, fixtures } = await buildTestApp();
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

    expect(change.changeKg ?? 0).toBeLessThan(0);
    expect(change.changeKg ?? 0).toBeGreaterThan(previous.changeKg ?? 0);
    expect(change.changePerWeekKg).not.toBeNull();

    expect(versusPrevious.differenceKg).toBeGreaterThan(0);
    expect(versusPrevious.differencePerWeekKg).toBeGreaterThan(0);
  });

  it('warms the trend on readings from before the range rather than restarting it at `from`', async () => {
    const { app, fixtures } = await buildTestApp();
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

describe('GET /stats/weekly', () => {
  const TODAY = '2026-03-11T10:00:00.000Z';

  it('returns one entry per ISO week, oldest first, ending with the week today falls in', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${WEEKLY_STATS}?weeks=2`,
      headers: browser(token),
    });

    expect(response.statusCode).toBe(200);
    const { weeks } = response.json<StatsWeeklyResponse>();
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({
      isoYear: 2026,
      isoWeek: 10,
      startDate: '2026-03-02',
      endDate: '2026-03-08',
    });
    expect(weeks[1]).toMatchObject({
      isoYear: 2026,
      isoWeek: 11,
      startDate: '2026-03-09',
      endDate: '2026-03-15',
    });
  });

  it("sums a week's colour counts and counts the days with any logging", async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });
    const orange = fixtures.create.food();
    fixtures.create.classification(orange, { category: 'orange' });

    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-09T05:00:00.000Z'),
      entries: [{ foodId: green.id }, { foodId: green.id }],
    });
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-10T05:00:00.000Z'),
      entries: [{ foodId: orange.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${WEEKLY_STATS}?weeks=1`, headers: browser(token) });

    const [week] = response.json<StatsWeeklyResponse>().weeks;
    expect(week?.counts).toEqual({ green: 2, yellow: 0, orange: 1, unclassified: 0 });
    expect(week?.daysLogged).toBe(2);
  });

  it('flags a week sparse below the threshold, and the previous week is what it is compared against', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const green = fixtures.create.food();
    fixtures.create.classification(green, { category: 'green' });

    for (const day of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05']) {
      fixtures.create.meal(fixtures.userA, {
        loggedAt: new Date(`${day}T05:00:00.000Z`),
        entries: [{ foodId: green.id }],
      });
    }
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-09T05:00:00.000Z'),
      entries: [{ foodId: green.id }],
    });
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${WEEKLY_STATS}?weeks=2`, headers: browser(token) });

    const { weeks } = response.json<StatsWeeklyResponse>();
    expect(weeks[0]).toMatchObject({ daysLogged: 4, sparse: false });
    expect(weeks[1]).toMatchObject({ daysLogged: 1, sparse: true });
    expect(weeks[1]?.versusPreviousWeek).toEqual({
      green: -3,
      yellow: 0,
      orange: 0,
      unclassified: 0,
    });
  });

  it("carries the weight trend's value at the week's first and last day, and its weekly rate", async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    weighDaily(
      fixtures,
      fixtures.userA,
      '2026-03-09',
      Array.from({ length: 7 }, (_, index) => 80_000 - index * 100),
    );
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${WEEKLY_STATS}?weeks=1`, headers: browser(token) });

    const [week] = response.json<StatsWeeklyResponse>().weeks;
    expect(week?.weight.startKg).toBe(80);
    expect(week?.weight.endKg).toBeLessThan(80);
    expect(week?.weight.changeKg).toBeLessThan(0);
    expect(week?.weight.changePerWeekKg).not.toBeNull();
  });

  it("never shows one account another's logging or weight", async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const food = fixtures.create.food();
    fixtures.create.classification(food, { category: 'green' });
    fixtures.create.meal(fixtures.userB, {
      loggedAt: new Date('2026-03-09T12:00:00.000Z'),
      entries: [{ foodId: food.id }],
    });
    weighDaily(fixtures, fixtures.userB, '2026-03-09', [80_000]);
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: `${WEEKLY_STATS}?weeks=1`, headers: browser(token) });

    const [week] = response.json<StatsWeeklyResponse>().weeks;
    expect(week?.counts).toEqual({ green: 0, yellow: 0, orange: 0, unclassified: 0 });
    expect(week?.weight).toEqual({
      startKg: null,
      endKg: null,
      changeKg: null,
      changePerWeekKg: null,
    });
  });

  it('defaults to 8 weeks and rejects a count outside 1 to 52', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const defaulted = await app.inject({ url: WEEKLY_STATS, headers: browser(token) });
    expect(defaulted.json<StatsWeeklyResponse>().weeks).toHaveLength(8);

    const tooFew = await app.inject({ url: `${WEEKLY_STATS}?weeks=0`, headers: browser(token) });
    expect(tooFew.statusCode).toBe(400);

    const tooMany = await app.inject({ url: `${WEEKLY_STATS}?weeks=53`, headers: browser(token) });
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('GET /stats/budget', () => {
  const TODAY = '2026-03-11T10:00:00.000Z';

  function logOn(fixtures: TestFixtures, date: string, category: 'green' | 'yellow' | 'orange') {
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date(`${date}T05:00:00.000Z`),
      entries: [{ category }],
    });
  }

  async function setBudgets(
    app: FastifyInstance,
    token: string,
    budgets: Record<string, number | null>,
  ) {
    const response = await app.inject({
      method: 'PUT',
      url: BUDGETS,
      headers: browser(token),
      payload: budgets,
    });
    expect(response.statusCode).toBe(200);
  }

  it("defaults to the ISO week the caller's own local date falls in", async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: BUDGET_STATS, headers: browser(token) });

    expect(response.statusCode).toBe(200);
    expect(response.json<StatsBudgetResponse>()).toMatchObject({
      isoYear: 2026,
      isoWeek: 11,
      startDate: '2026-03-09',
      endDate: '2026-03-15',
    });
  });

  it('numbers its week exactly as GET /stats/weekly numbers the current one', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const budget = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();
    const { weeks } = (
      await app.inject({ url: `${WEEKLY_STATS}?weeks=1`, headers: browser(token) })
    ).json<StatsWeeklyResponse>();

    expect(weeks.at(-1)).toMatchObject({
      isoYear: budget.isoYear,
      isoWeek: budget.isoWeek,
      startDate: budget.startDate,
      endDate: budget.endDate,
    });
  });

  it('answers the week a given date falls in, not the current one', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: `${BUDGET_STATS}?date=2026-03-03`,
      headers: browser(token),
    });

    expect(response.json<StatsBudgetResponse>()).toMatchObject({
      isoWeek: 10,
      startDate: '2026-03-02',
      endDate: '2026-03-08',
    });
  });

  it('counts the whole week against the limits and reports what is left', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { yellow: 12, orange: 4 });

    logOn(fixtures, '2026-03-09', 'yellow');
    logOn(fixtures, '2026-03-10', 'yellow');
    logOn(fixtures, '2026-03-11', 'orange');
    logOn(fixtures, '2026-03-08', 'orange');

    const { budget } = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();

    expect(budget.yellow).toEqual({ limit: 12, count: 2, remaining: 10 });
    expect(budget.orange).toEqual({ limit: 4, count: 1, remaining: 3 });
    expect(budget.green).toEqual({ limit: null, count: 0, remaining: null });
  });

  it('keeps accepting meals past the limit and reports a negative remaining', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { orange: 1 });

    for (const date of ['2026-03-09', '2026-03-10', '2026-03-11']) {
      logOn(fixtures, date, 'orange');
    }
    const late = await app.inject({
      method: 'POST',
      url: `${API_PREFIX}/meals`,
      headers: browser(token),
      payload: { type: 'dinner', entries: [{ category: 'orange' }] },
    });

    expect(late.statusCode).toBe(201);
    const { budget } = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();
    expect(budget.orange).toEqual({ limit: 1, count: 4, remaining: -3 });
  });

  it('counts unclassified entries separately and charges them to no category', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { green: 5, yellow: 5, orange: 5 });
    const unjudged = fixtures.create.food();
    fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-11T05:00:00.000Z'),
      entries: [{ foodId: unjudged.id }],
    });

    const { budget } = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();

    expect(budget.unclassified).toBe(1);
    expect([budget.green.count, budget.yellow.count, budget.orange.count]).toEqual([0, 0, 0]);
  });

  it('changes immediately when a meal in the week is backdated into or out of it', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { orange: 4 });
    const { meal } = fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-03-11T05:00:00.000Z'),
      entries: [{ category: 'orange' }],
    });

    const before = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();
    expect(before.budget.orange).toEqual({ limit: 4, count: 1, remaining: 3 });

    const moved = await app.inject({
      method: 'PATCH',
      url: `${API_PREFIX}/meals/${meal.id}`,
      headers: browser(token),
      payload: { loggedAt: '2026-03-04T05:00:00.000Z' },
    });
    expect(moved.statusCode).toBe(200);

    const after = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();
    expect(after.budget.orange).toEqual({ limit: 4, count: 0, remaining: 4 });
  });

  it('applies a limit changed mid week to the week already in progress', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { orange: 10 });
    logOn(fixtures, '2026-03-09', 'orange');
    logOn(fixtures, '2026-03-10', 'orange');

    await setBudgets(app, token, { orange: 1 });

    const { budget } = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();
    expect(budget.orange).toEqual({ limit: 1, count: 2, remaining: -1 });
  });

  it("never counts another account's meals, even in the same week", async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    await setBudgets(app, token, { orange: 4 });
    fixtures.create.meal(fixtures.userB, {
      loggedAt: new Date('2026-03-10T20:00:00.000Z'),
      entries: [{ category: 'orange' }],
    });

    const { budget } = (
      await app.inject({ url: BUDGET_STATS, headers: browser(token) })
    ).json<StatsBudgetResponse>();

    expect(budget.orange).toEqual({ limit: 4, count: 0, remaining: 4 });
  });

  it('rejects a query parameter it does not declare, and a date that is not one', async () => {
    freezeTime(TODAY);
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const extra = await app.inject({
      url: `${BUDGET_STATS}?week=2026-W11`,
      headers: browser(token),
    });
    const bad = await app.inject({
      url: `${BUDGET_STATS}?date=last-monday`,
      headers: browser(token),
    });

    expect(extra.statusCode).toBe(400);
    expect(bad.statusCode).toBe(400);
  });
});
