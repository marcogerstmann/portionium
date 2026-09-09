import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMeal } from '../src/domain/meal.js';
import {
  apiTokenTable,
  foodClassificationTable,
  foodTable,
  mealItemTable,
  mealTable,
  userTable,
  weightEntryTable,
} from '../src/db/schema/index.js';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';
import { TEST_PASSWORD_HASH } from './helpers/fixtures.js';

/**
 * The tables as the migration actually built them, rather than as the TypeScript describes
 * them. Everything here is something Drizzle's types cannot tell us: whether a foreign key
 * bites, whether a default landed in the file, whether JSON survives the round trip.
 */
describe('the entity tables', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  async function seedUser() {
    const [user] = await database.db
      .insert(userTable)
      .values({
        email: 'someone@example.com',
        passwordHash: TEST_PASSWORD_HASH,
        displayName: 'Someone',
        timezone: 'Europe/Berlin',
      })
      .returning();
    return user!;
  }

  async function seedFood(createdBy: string) {
    const [food] = await database.db
      .insert(foodTable)
      .values({ name: 'Porridge', kind: 'dish', createdBy })
      .returning();
    return food!;
  }

  it('creates every table the domain model needs', () => {
    const names = database.db.$client
      .prepare(`select name from sqlite_master where type = 'table' order by name`)
      .all()
      .map((row) => (row as { name: string }).name);

    expect(names).toEqual(
      expect.arrayContaining([
        'user',
        'session',
        'api_token',
        'food',
        'food_classification',
        'meal',
        'meal_item',
        'weight_entry',
      ]),
    );
  });

  /**
   * The one column in the schema whose value is not a scalar. SQLite has no array type, so the
   * scopes are JSON in a text column, and whether Drizzle hands back an array rather than the
   * string it stored is exactly the kind of thing the TypeScript cannot tell us.
   */
  it('round trips an API token scope list through a text column', async () => {
    const user = await seedUser();

    const [token] = await database.db
      .insert(apiTokenTable)
      .values({
        userId: user.id,
        name: 'Deploy script',
        tokenHash: 'a'.repeat(64),
        scopes: ['read', 'write'],
      })
      .returning();

    expect(token!.scopes).toEqual(['read', 'write']);
    expect(token!.lastUsedAt).toBeNull();
    expect(token!.expiresAt).toBeNull();
    expect(token!.revokedAt).toBeNull();
  });

  it('defaults a new user to the unprivileged role', async () => {
    expect((await seedUser()).role).toBe('user');
  });

  it('defaults a new user to a 04:00 day boundary', async () => {
    expect((await seedUser()).dayBoundaryHour).toBe(4);
  });

  it('derives a late night meal onto the previous day, through the stored default', async () => {
    const user = await seedUser();
    const food = await seedFood(user.id);

    const { meal } = createMeal(
      {
        userId: user.id,
        type: 'snack',
        loggedAt: new Date('2026-09-06T23:00:00.000Z'), // 01:00 on the 7th in Berlin.
        items: [{ foodId: food.id }],
      },
      user,
    );

    const [stored] = await database.db.insert(mealTable).values(meal).returning();

    expect(stored!.localDate).toBe('2026-09-06');
  });

  it('refuses a second account on one email address', async () => {
    await seedUser();

    await expect(seedUser()).rejects.toThrow(/UNIQUE/i);
  });

  it('refuses an account with no password at all', async () => {
    // The column is what makes a passwordless account impossible, rather than every code path
    // that creates one remembering to supply a hash.
    await expect(
      database.db.insert(userTable).values({
        email: 'nobody@example.com',
        displayName: 'Nobody',
        timezone: 'Europe/Berlin',
      } as unknown as typeof userTable.$inferInsert),
    ).rejects.toThrow(/NOT NULL/i);
  });

  it('refuses a meal belonging to a user that is not there', async () => {
    await expect(
      database.db.insert(mealTable).values({
        userId: '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31',
        type: 'lunch',
        loggedAt: new Date(),
        localDate: '2026-09-06',
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('stores what createMeal produced, positions and all', async () => {
    const user = await seedUser();
    const porridge = await seedFood(user.id);
    const berries = await database.db
      .insert(foodTable)
      .values({ name: 'Blueberries', kind: 'ingredient', createdBy: user.id })
      .returning();

    // The user row is the day context, so this also proves the column default reaches the
    // derivation: nothing set day_boundary_hour, and 23:00 UTC still lands on the 6th.
    const { meal, items } = createMeal(
      {
        userId: user.id,
        type: 'breakfast',
        loggedAt: new Date('2026-09-06T06:30:00.000Z'),
        items: [{ foodId: porridge.id }, { foodId: berries[0]!.id }],
      },
      user,
    );

    const [stored] = await database.db.insert(mealTable).values(meal).returning();
    await database.db
      .insert(mealItemTable)
      .values(items.map((item) => ({ ...item, mealId: stored!.id })));

    const rows = await database.db
      .select()
      .from(mealItemTable)
      .where(eq(mealItemTable.mealId, stored!.id));

    expect(rows.map((row) => row.position).sort()).toEqual([0, 1]);
    expect(rows.every((row) => row.quantity === null)).toBe(true);
    expect(stored!.localDate).toBe('2026-09-06');
    expect(stored!.loggedAt).toBeInstanceOf(Date);
  });

  it('takes a meal’s items with it when the meal is really deleted', async () => {
    const user = await seedUser();
    const food = await seedFood(user.id);
    const [meal] = await database.db
      .insert(mealTable)
      .values({ userId: user.id, type: 'lunch', loggedAt: new Date(), localDate: '2026-09-06' })
      .returning();

    await database.db
      .insert(mealItemTable)
      .values({ mealId: meal!.id, foodId: food.id, position: 0 });
    await database.db.delete(mealTable).where(eq(mealTable.id, meal!.id));

    expect(await database.db.select().from(mealItemTable)).toHaveLength(0);
  });

  it('keeps a shared classification unattached to any user, and a user’s own attached', async () => {
    const user = await seedUser();
    const food = await seedFood(user.id);

    const [seeded] = await database.db
      .insert(foodClassificationTable)
      .values({ foodId: food.id, category: 'green', source: 'seed' })
      .returning();
    const [override] = await database.db
      .insert(foodClassificationTable)
      .values({ foodId: food.id, userId: user.id, category: 'orange', source: 'user' })
      .returning();

    expect(seeded!.userId).toBeNull();
    expect(override!.userId).toBe(user.id);
  });

  it('round trips the assumptions list through the JSON column', async () => {
    const user = await seedUser();
    const food = await seedFood(user.id);
    const assumptions = ['No sugar was added', 'Cooked in water rather than milk'];

    const [row] = await database.db
      .insert(foodClassificationTable)
      .values({
        foodId: food.id,
        category: 'yellow',
        source: 'ai_text',
        model: 'claude-opus-5',
        promptVersion: 'v3',
        confidence: 0.82,
        assumptions,
      })
      .returning();

    const [read] = await database.db
      .select()
      .from(foodClassificationTable)
      .where(eq(foodClassificationTable.id, row!.id));

    expect(read!.assumptions).toEqual(assumptions);
    expect(read!.confidence).toBeCloseTo(0.82);
  });

  it('stores a weight as the integer it was given, with no float on the way in', async () => {
    const user = await seedUser();

    await database.db.insert(weightEntryTable).values({
      userId: user.id,
      weightGrams: 82_400,
      localDate: '2026-09-06',
      recordedAt: new Date('2026-09-06T06:00:00.000Z'),
    });

    const raw = database.db.$client.prepare('select weight_grams from weight_entry').get() as {
      weight_grams: number;
    };

    expect(raw.weight_grams).toBe(82_400);
    expect(Number.isInteger(raw.weight_grams)).toBe(true);
  });
});
