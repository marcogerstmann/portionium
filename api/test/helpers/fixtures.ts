import type { Db } from '../../src/db/client.js';
import {
  foodTable,
  mealItemTable,
  mealTable,
  sessionTable,
  userTable,
  weightEntryTable,
} from '../../src/db/schema/index.js';
import { createSessionToken } from '../../src/domain/auth.js';
import { resolveLocalDate } from '../../src/domain/local-date.js';
import { createMeal, type NewMealItem } from '../../src/domain/meal.js';
import { createTestDatabase, type TestDatabase } from './database.js';

/**
 * Rows to write tests against, built the way the application builds them.
 *
 * Everything with a derived field goes through the domain function that derives it, so a meal
 * made here carries the local date resolveLocalDate would have given it and item positions
 * createMeal would have assigned. A factory that invented those itself would let a test pass
 * against a meal the application could never have produced.
 *
 * The factories are synchronous. better-sqlite3 is a synchronous driver and Drizzle's builders
 * over it run on `.all()` and `.run()`, so awaiting them buys nothing and costs a test a line
 * of ceremony per row.
 */

export type UserRow = typeof userTable.$inferSelect;
export type FoodRow = typeof foodTable.$inferSelect;
export type MealRow = typeof mealTable.$inferSelect;
export type MealItemRow = typeof mealItemTable.$inferSelect;
export type WeightEntryRow = typeof weightEntryTable.$inferSelect;

/**
 * The password every fixture account is created with, and its hash, precomputed.
 *
 * Hashing here rather than storing the result would make every test that needs a user pay for
 * a deliberately expensive function, several times over, for a value that is the same in every
 * run. The constant is a real Argon2id hash of the string above it, made with the parameters in
 * domain/auth.ts, and the test beside that file is what keeps the two in step.
 */
export const TEST_PASSWORD = 'correct horse battery staple';

export const TEST_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$BqG+n7Zh5aZxPFY9azspqg$oci1GxAoLH1EH/1nHU30HXC4VdsF4qScvsft09ChiXc';

/** Keeps generated emails and names unique across a file without a test having to think. */
let sequence = 0;

export interface MealOverrides {
  type?: MealRow['type'];
  loggedAt?: Date;
  notes?: string;
  /** Left out means one food is created for the meal, which is what most tests want. */
  items?: readonly NewMealItem[];
}

export interface Factories {
  user(overrides?: Partial<typeof userTable.$inferInsert>): UserRow;
  /**
   * A signed in session for this user, returning the token a client would hold. Minted the way
   * a login mints one, so what a test sends is a credential the application could have issued
   * and the row behind it stores a hash rather than the token.
   *
   * `expiresAt` is an override so a test can look at an expired session without waiting a month.
   */
  session(owner: UserRow, overrides?: { expiresAt?: Date }): string;
  food(overrides?: Partial<typeof foodTable.$inferInsert>): FoodRow;
  /**
   * The user is a parameter rather than an override because a meal needs one for two separate
   * reasons: it is the owner, and its timezone and boundary hour are what date the meal.
   */
  meal(user: UserRow, overrides?: MealOverrides): { meal: MealRow; items: MealItemRow[] };
  weightEntry(
    user: UserRow,
    overrides?: Partial<Pick<WeightEntryRow, 'weightGrams' | 'recordedAt'>>,
  ): WeightEntryRow;
}

export function createFactories(db: Db): Factories {
  function user(overrides: Partial<typeof userTable.$inferInsert> = {}): UserRow {
    const n = ++sequence;
    return db
      .insert(userTable)
      .values({
        email: `user-${n}@example.test`,
        passwordHash: TEST_PASSWORD_HASH,
        displayName: `User ${n}`,
        timezone: 'Europe/Berlin',
        ...overrides,
      })
      .returning()
      .get();
  }

  function session(owner: UserRow, overrides: { expiresAt?: Date } = {}): string {
    const { token, tokenHash, expiresAt } = createSessionToken();
    db.insert(sessionTable)
      .values({ userId: owner.id, tokenHash, expiresAt: overrides.expiresAt ?? expiresAt })
      .run();

    return token;
  }

  function food(overrides: Partial<typeof foodTable.$inferInsert> = {}): FoodRow {
    const n = ++sequence;
    // createdBy is left null by default, so the default food is a catalog entry rather than
    // somebody's. A test that cares about ownership passes a user id.
    return db
      .insert(foodTable)
      .values({ name: `Food ${n}`, kind: 'ingredient', ...overrides })
      .returning()
      .get();
  }

  function meal(owner: UserRow, overrides: MealOverrides = {}) {
    const items = overrides.items ?? [{ foodId: food().id }];

    const validated = createMeal(
      {
        userId: owner.id,
        type: overrides.type ?? 'lunch',
        loggedAt: overrides.loggedAt ?? new Date(),
        ...(overrides.notes === undefined ? {} : { notes: overrides.notes }),
        items,
      },
      owner,
    );

    const stored = db.insert(mealTable).values(validated.meal).returning().get();
    const storedItems = db
      .insert(mealItemTable)
      .values(validated.items.map((item) => ({ ...item, mealId: stored.id })))
      .returning()
      .all();

    return { meal: stored, items: storedItems };
  }

  function weightEntry(
    owner: UserRow,
    overrides: Partial<Pick<WeightEntryRow, 'weightGrams' | 'recordedAt'>> = {},
  ): WeightEntryRow {
    const recordedAt = overrides.recordedAt ?? new Date();
    return db
      .insert(weightEntryTable)
      .values({
        userId: owner.id,
        weightGrams: overrides.weightGrams ?? 82_000,
        recordedAt,
        localDate: resolveLocalDate(recordedAt, owner.timezone, owner.dayBoundaryHour),
      })
      .returning()
      .get();
  }

  return { user, session, food, meal, weightEntry };
}

export interface TestFixtures extends TestDatabase {
  create: Factories;
  userA: UserRow;
  userB: UserRow;
}

/**
 * A migrated database with two accounts already in it.
 *
 * Two rather than one because almost every read in this application takes a userId, and a
 * test with a single user cannot tell a query that filters by owner from one that forgot to.
 * Having the second account there by default makes the isolation assertion a line, not a
 * setup block, which is the only way it actually gets written.
 *
 * They sit in different timezones on purpose. That way a service which reaches for the calling
 * user's day context while reading somebody else's rows produces a visibly wrong local date
 * rather than the same answer by luck.
 */
export function createTestFixtures(): TestFixtures {
  const database = createTestDatabase();
  const create = createFactories(database.db);

  return {
    ...database,
    create,
    userA: create.user({ displayName: 'User A', timezone: 'Europe/Berlin' }),
    userB: create.user({ displayName: 'User B', timezone: 'America/New_York' }),
  };
}
