import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { foodClassificationTable, foodTable } from '../src/db/schema/index.js';
import { readSeedCatalog, seedFoodCatalog } from '../src/db/seed.js';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';
import { createFactories } from './helpers/fixtures.js';

/**
 * The catalog is product data, so it is checked as product data: the file has to be well
 * formed and sane before anything asks whether the loader put it in the right place.
 */
describe('the seed catalog file', () => {
  const catalog = readSeedCatalog();

  it('holds enough entries to cover ordinary eating without becoming a database', () => {
    expect(catalog.foods.length).toBeGreaterThanOrEqual(150);
    expect(catalog.foods.length).toBeLessThanOrEqual(250);
  });

  it('names every food exactly once, since the loader matches on the name', () => {
    const names = catalog.foods.map((food) => food.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('carries no leading or trailing whitespace on a name', () => {
    expect(catalog.foods.filter((food) => food.name !== food.name.trim())).toEqual([]);
  });

  it('uses all three colours, so the traffic light is not decorative', () => {
    const counts = new Map<string, number>();
    for (const food of catalog.foods) {
      counts.set(food.category, (counts.get(food.category) ?? 0) + 1);
    }

    expect([...counts.keys()].sort()).toEqual(['green', 'orange', 'yellow']);
    // Nothing here is a target. A colour that collapsed to a handful of entries would mean
    // the banding rule had drifted, and that is worth noticing in a diff.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(20);
    }
  });
});

describe('seedFoodCatalog', () => {
  let database: TestDatabase;

  beforeEach(() => {
    database = createTestDatabase();
  });

  afterEach(() => {
    database.close();
  });

  function seedRows() {
    return database.db.select().from(foodTable).where(isNull(foodTable.createdBy)).all();
  }

  function seedVerdicts() {
    return database.db
      .select()
      .from(foodClassificationTable)
      .where(
        and(isNull(foodClassificationTable.userId), eq(foodClassificationTable.source, 'seed')),
      )
      .all();
  }

  it('inserts every food in the file, with one seed verdict each', () => {
    const catalog = readSeedCatalog();

    const result = seedFoodCatalog(database.db);

    expect(result.foodsInserted).toBe(catalog.foods.length);
    expect(result.classificationsInserted).toBe(catalog.foods.length);
    expect(seedRows()).toHaveLength(catalog.foods.length);
    expect(seedVerdicts()).toHaveLength(catalog.foods.length);
  });

  it('attaches the seed rows to nobody, so one catalog serves every account', () => {
    seedFoodCatalog(database.db);

    expect(seedRows().every((food) => food.createdBy === null)).toBe(true);
    expect(seedVerdicts().every((verdict) => verdict.userId === null)).toBe(true);
    expect(seedVerdicts().every((verdict) => verdict.source === 'seed')).toBe(true);
  });

  it('carries the colour the file gave each food', () => {
    seedFoodCatalog(database.db);

    const colours = new Map(
      database.db
        .select({ name: foodTable.name, category: foodClassificationTable.category })
        .from(foodClassificationTable)
        .innerJoin(foodTable, eq(foodTable.id, foodClassificationTable.foodId))
        .all()
        .map((row) => [row.name, row.category] as const),
    );

    for (const food of readSeedCatalog().foods) {
      expect(colours.get(food.name)).toBe(food.category);
    }
  });

  it('writes nothing on a second run', () => {
    seedFoodCatalog(database.db);

    expect(seedFoodCatalog(database.db)).toEqual({
      foodsInserted: 0,
      classificationsInserted: 0,
    });
    expect(seedRows()).toHaveLength(readSeedCatalog().foods.length);
    expect(seedVerdicts()).toHaveLength(readSeedCatalog().foods.length);
  });

  it('adds only what is new when the file has grown', () => {
    seedFoodCatalog(database.db);
    // Standing in for an entry added to the file: delete one row and re-run, which is the
    // same gap the loader has to close either way.
    const [victim] = seedRows();
    database.db
      .delete(foodClassificationTable)
      .where(eq(foodClassificationTable.foodId, victim!.id))
      .run();
    database.db.delete(foodTable).where(eq(foodTable.id, victim!.id)).run();

    expect(seedFoodCatalog(database.db)).toEqual({
      foodsInserted: 1,
      classificationsInserted: 1,
    });
  });

  it('finishes a run that was interrupted between the food and its verdict', () => {
    seedFoodCatalog(database.db);
    const [orphan] = seedRows();
    database.db
      .delete(foodClassificationTable)
      .where(eq(foodClassificationTable.foodId, orphan!.id))
      .run();

    expect(seedFoodCatalog(database.db)).toEqual({
      foodsInserted: 0,
      classificationsInserted: 1,
    });
  });

  it('leaves a soft deleted seed food deleted rather than resurrecting it on every boot', () => {
    seedFoodCatalog(database.db);
    const [removed] = seedRows();
    database.db
      .update(foodTable)
      .set({ deletedAt: new Date() })
      .where(eq(foodTable.id, removed!.id))
      .run();

    expect(seedFoodCatalog(database.db).foodsInserted).toBe(0);
  });

  it('ignores a user created food that happens to share a name', () => {
    const create = createFactories(database.db);
    const user = create.user();
    const catalogEntry = readSeedCatalog().foods[0]!;
    create.food({ name: catalogEntry.name, kind: catalogEntry.kind, createdBy: user.id });

    seedFoodCatalog(database.db);

    // The user's row is untouched and unclassified, and the seeded one exists beside it.
    // Collapsing the two is the catalog CRUD story's duplicate detection, not this loader's.
    const owned = database.db.select().from(foodTable).where(isNotNull(foodTable.createdBy)).all();
    expect(owned).toHaveLength(1);
    expect(seedRows().filter((food) => food.name === catalogEntry.name)).toHaveLength(1);
  });
});
