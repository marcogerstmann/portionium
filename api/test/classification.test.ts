import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withdrawClassification } from '../src/db/classification-withdrawal.js';
import * as classifications from '../src/db/classification.js';
import {
  findClassificationHistory,
  findClassificationsForFoods,
  insertClassifications,
} from '../src/db/classification.js';
import type { Db } from '../src/db/client.js';
import { foodClassificationWithdrawalTable } from '../src/db/schema/index.js';
import { createTestFixtures, type TestFixtures } from './helpers/fixtures.js';

let fixtures: TestFixtures;

beforeEach(() => {
  fixtures = createTestFixtures();
});

afterEach(() => {
  fixtures.close();
});

function capture(db: Db, run: () => void): string[] {
  const client = db.$client;
  const original = client.prepare.bind(client);
  const statements: string[] = [];

  client.prepare = (sql: string) => {
    statements.push(sql);
    return original(sql);
  };

  try {
    run();
  } finally {
    delete (client as { prepare?: unknown }).prepare;
  }

  return statements;
}

function queryPlan(db: Db, sql: string): string[] {
  const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => '');

  return db.$client
    .prepare(`explain query plan ${sql}`)
    .all(...parameters)
    .map((step) => (step as { detail: string }).detail);
}

describe('the classification repository', () => {
  it('offers no way to change a verdict, which is what makes the log append only', () => {
    const writes = Object.keys(classifications).filter((name) =>
      /^(insert|update|delete)/.test(name),
    );

    expect(writes).toEqual(['insertClassifications']);
  });

  it('resolves one food through the index rather than scanning the table', () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food);

    const [statement] = capture(fixtures.db, () => {
      findClassificationHistory(fixtures.db, food.id, fixtures.userA.id);
    });

    const plan = queryPlan(fixtures.db, statement ?? '');

    expect(plan.join('\n')).toContain('food_classification_food_idx');
    expect(plan.some((step) => step.includes('SCAN food_classification'))).toBe(false);
  });

  it('reads a page of fifty foods in one statement, not fifty', () => {
    const foods = Array.from({ length: 50 }, () => fixtures.create.food());
    for (const food of foods) {
      fixtures.create.classification(food);
    }

    const statements = capture(fixtures.db, () => {
      findClassificationsForFoods(
        fixtures.db,
        foods.map((food) => food.id),
        fixtures.userA.id,
      );
    });

    expect(statements).toHaveLength(1);
  });

  it('asks nothing at all when there are no foods to ask about', () => {
    expect(
      capture(fixtures.db, () => findClassificationsForFoods(fixtures.db, [], fixtures.userA.id)),
    ).toEqual([]);
    expect(insertClassifications(fixtures.db, [])).toEqual([]);
  });

  it('never hands one household member the other one, whichever way it is asked', () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food, { category: 'green' });
    insertClassifications(fixtures.db, [
      { foodId: food.id, category: 'orange', source: 'user', userId: fixtures.userA.id },
      { foodId: food.id, category: 'yellow', source: 'user', userId: fixtures.userB.id },
    ]);

    const forA = findClassificationHistory(fixtures.db, food.id, fixtures.userA.id);
    const forB = findClassificationsForFoods(fixtures.db, [food.id], fixtures.userB.id);

    expect(forA.map((row) => row.category)).toEqual(expect.arrayContaining(['green', 'orange']));
    expect(forA.some((row) => row.userId === fixtures.userB.id)).toBe(false);
    expect(forB.some((row) => row.userId === fixtures.userA.id)).toBe(false);
  });
});

describe('withdrawing a classification', () => {
  it('is left out of resolution once withdrawn, in favour of the AI or seed verdict', () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food, { category: 'green' });
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
    });

    withdrawClassification(fixtures.db, food.id, fixtures.userA.id);

    const rows = findClassificationsForFoods(fixtures.db, [food.id], fixtures.userA.id);
    expect(rows.map((row) => row.source)).toEqual(['seed']);
  });

  it('leaves the history exactly as it was, the withdrawn verdict included', () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
    });

    withdrawClassification(fixtures.db, food.id, fixtures.userA.id);

    const history = findClassificationHistory(fixtures.db, food.id, fixtures.userA.id);
    expect(history.map((row) => row.category)).toEqual(['orange']);
  });

  it('stops mattering the moment the caller overrides the food again', () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0)),
    });
    fixtures.db
      .insert(foodClassificationWithdrawalTable)
      .values({
        foodId: food.id,
        userId: fixtures.userA.id,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 5)),
      })
      .run();

    insertClassifications(fixtures.db, [
      {
        foodId: food.id,
        category: 'yellow',
        source: 'user',
        userId: fixtures.userA.id,
      },
    ]);

    const rows = findClassificationsForFoods(fixtures.db, [food.id], fixtures.userA.id);
    expect(rows.map((row) => row.category)).toEqual(expect.arrayContaining(['yellow']));
  });

  it("never withdraws the other household member's own opinion", () => {
    const food = fixtures.create.food();
    fixtures.create.classification(food, {
      category: 'orange',
      source: 'user',
      userId: fixtures.userA.id,
    });
    fixtures.create.classification(food, {
      category: 'yellow',
      source: 'user',
      userId: fixtures.userB.id,
    });

    withdrawClassification(fixtures.db, food.id, fixtures.userA.id);

    const forB = findClassificationsForFoods(fixtures.db, [food.id], fixtures.userB.id);
    expect(forB.map((row) => row.category)).toEqual(expect.arrayContaining(['yellow']));
  });
});
