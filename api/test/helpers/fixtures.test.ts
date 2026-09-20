import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mealTable } from '../../src/db/schema/index.js';
import { createTestFixtures, type TestFixtures } from './fixtures.js';
import { freezeTime } from './time.js';

describe('the test fixtures', () => {
  let fixtures: TestFixtures;

  beforeEach(() => {
    fixtures = createTestFixtures();
  });

  afterEach(() => {
    fixtures.close();
  });

  it('opens with two accounts that differ in the things isolation bugs hide behind', () => {
    expect(fixtures.userA.id).not.toBe(fixtures.userB.id);
    expect(fixtures.userA.email).not.toBe(fixtures.userB.email);
    expect(fixtures.userA.timezone).not.toBe(fixtures.userB.timezone);
  });

  it('gives every generated user its own email, so the unique index never decides a test', () => {
    const emails = [fixtures.create.user(), fixtures.create.user(), fixtures.create.user()].map(
      (user) => user.email,
    );

    expect(new Set(emails).size).toBe(3);
  });

  it('takes overrides on top of the defaults', () => {
    const user = fixtures.create.user({ displayName: 'Someone', dayBoundaryHour: 0 });

    expect(user.displayName).toBe('Someone');
    expect(user.dayBoundaryHour).toBe(0);
    expect(user.timezone).toBe('Europe/Berlin');
  });

  it('creates a catalog food by default and an owned one on request', () => {
    expect(fixtures.create.food().createdBy).toBeNull();
    expect(fixtures.create.food({ createdBy: fixtures.userA.id }).createdBy).toBe(
      fixtures.userA.id,
    );
  });

  it('dates a meal through the owner’s day boundary, not the clock’s', () => {
    const { meal } = fixtures.create.meal(fixtures.userA, {
      loggedAt: new Date('2026-09-06T23:00:00.000Z'),
    });

    expect(meal.localDate).toBe('2026-09-06');
  });

  it('dates the same instant differently for the two users, which is the point of them', () => {
    const loggedAt = new Date('2026-09-06T23:00:00.000Z');

    expect(fixtures.create.meal(fixtures.userA, { loggedAt }).meal.localDate).toBe('2026-09-06');
    expect(fixtures.create.meal(fixtures.userB, { loggedAt }).meal.localDate).toBe('2026-09-06');
    const morning = new Date('2026-09-07T05:00:00.000Z');
    expect(fixtures.create.meal(fixtures.userA, { loggedAt: morning }).meal.localDate).toBe(
      '2026-09-07',
    );
    expect(fixtures.create.meal(fixtures.userB, { loggedAt: morning }).meal.localDate).toBe(
      '2026-09-06',
    );
  });

  it('assigns dense zero based positions in the order the entries were given', () => {
    const first = fixtures.create.food();
    const second = fixtures.create.food();

    const { entries } = fixtures.create.meal(fixtures.userA, {
      entries: [{ foodId: second.id }, { foodId: first.id }],
    });

    expect(entries.map((entry) => entry.position)).toEqual([0, 1]);
    expect(entries.map((entry) => entry.foodId)).toEqual([second.id, first.id]);
  });

  it('stamps the colour the route would have stamped, and leaves an unjudged food waiting', () => {
    const judged = fixtures.create.food();
    fixtures.create.classification(judged, { category: 'orange' });
    const unjudged = fixtures.create.food();

    const { entries } = fixtures.create.meal(fixtures.userA, {
      entries: [{ foodId: judged.id }, { foodId: unjudged.id }, { category: 'green' }],
    });

    expect(entries.map((entry) => entry.category)).toEqual(['orange', null, 'green']);
    expect(entries[2]?.foodId).toBeNull();
  });

  it('scopes a meal to its owner, so a query that forgets the user is visible', () => {
    fixtures.create.meal(fixtures.userA);
    fixtures.create.meal(fixtures.userB);

    const owned = fixtures.db
      .select()
      .from(mealTable)
      .where(eq(mealTable.userId, fixtures.userA.id))
      .all();

    expect(owned).toHaveLength(1);
    expect(fixtures.db.select().from(mealTable).all()).toHaveLength(2);
  });

  it('derives a weight entry’s local date from the owner too', () => {
    const entry = fixtures.create.weightEntry(fixtures.userB, {
      weightGrams: 71_200,
      recordedAt: new Date('2026-09-07T05:00:00.000Z'),
    });

    expect(entry.weightGrams).toBe(71_200);
    expect(entry.localDate).toBe('2026-09-06');
  });
});

describe('freezeTime', () => {
  it('pins now, so a meal logged without an explicit instant lands on a known day', () => {
    const fixtures = createTestFixtures();
    try {
      freezeTime('2026-09-06T23:00:00.000Z');

      expect(new Date().toISOString()).toBe('2026-09-06T23:00:00.000Z');
      expect(fixtures.create.meal(fixtures.userA).meal.localDate).toBe('2026-09-06');
    } finally {
      fixtures.close();
    }
  });

  it('leaves ids unique and ordered under a stopped clock', () => {
    const fixtures = createTestFixtures();
    try {
      freezeTime('2026-09-06T12:00:00.000Z');

      const ids = [fixtures.create.food(), fixtures.create.food(), fixtures.create.food()].map(
        (food) => food.id,
      );

      expect(new Set(ids).size).toBe(3);
      expect([...ids].sort()).toEqual(ids);
    } finally {
      fixtures.close();
    }
  });

  it('hands the real clock back afterwards', () => {
    expect(Math.abs(Date.now() - new Date('2026-09-06T12:00:00.000Z').getTime())).toBeGreaterThan(
      1000,
    );
  });
});
