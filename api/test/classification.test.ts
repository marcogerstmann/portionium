import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as classifications from '../src/db/classification.js';
import {
  findClassificationHistory,
  findClassificationsForFoods,
  insertClassifications,
} from '../src/db/classification.js';
import type { Db } from '../src/db/client.js';
import { createTestFixtures, type TestFixtures } from './helpers/fixtures.js';

/**
 * The two properties that make the append only log affordable, checked against a real database
 * rather than asserted in a comment. Both are the kind of thing a well meaning refactor removes
 * without noticing: a colour resolved per food inside a loop still returns the right answer, and
 * an index dropped from the schema still passes every functional test in the suite.
 *
 * Why the log is append only at all, and what the two properties buy:
 * docs/adr/007-append-only-classification-log.md.
 */

let fixtures: TestFixtures;

beforeEach(() => {
  fixtures = createTestFixtures();
});

afterEach(() => {
  fixtures.close();
});

/**
 * The SQL the repository actually sent, captured off the driver.
 *
 * Prepared statements rather than a hand written copy of what the query is meant to look like,
 * because a copy is a second query that nobody runs and it drifts on the first refactor. This
 * shadows `prepare` on the connection and deletes the shadow afterwards, which puts the
 * prototype's own method back rather than a bound impostor.
 */
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

/**
 * A plan needs a statement, and a statement needs its parameters bound even though the planner
 * never looks at them. Every parameter in this table is text, so an empty string binds anywhere.
 */
function queryPlan(db: Db, sql: string): string[] {
  const parameters = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => '');

  return db.$client
    .prepare(`explain query plan ${sql}`)
    .all(...parameters)
    .map((step) => (step as { detail: string }).detail);
}

describe('the classification repository', () => {
  it('offers no way to change a verdict, which is what makes the log append only', () => {
    // The enforcement is the absence. A rule that lives in a comment is a rule somebody breaks
    // in good faith at half past five, so there is no function here that could break it.
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
