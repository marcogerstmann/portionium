import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { categorySchema, foodKindSchema, type Category } from '@portionium/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from './client.js';
import { foodClassificationTable, foodTable } from './schema/index.js';

/**
 * The catalog that ships with the app. Without it a new install is an empty search box and
 * every first meal needs the classifier, which is the opposite of what the product claims.
 *
 * The entries are product data, not test data. Their colours follow the rule stated at the top
 * of seed/foods.json, and that rule is the thing to read before adding to the file.
 *
 * Seed rows belong to nobody: `food.created_by` is null and so is
 * `food_classification.user_id`, so one catalog is shared by every account and a user's own
 * opinion about a food is a separate row rather than an edit to this one.
 */

const seedCatalogSchema = z.object({
  /** Bumped when the shape changes, not when foods are added. Nothing branches on it yet. */
  version: z.int().positive(),
  /** How a colour is decided. Lives in the file because that is where it gets ignored. */
  rule: z.string().min(1),
  foods: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        kind: foodKindSchema,
        category: categorySchema,
      }),
    )
    .min(1),
});

export type SeedCatalog = z.infer<typeof seedCatalogSchema>;

/**
 * Resolved against this module rather than the working directory, the same way the migrations
 * folder is in client.ts: src/db/ and dist/db/ both sit two levels under api/.
 */
const catalogPath = fileURLToPath(new URL('../../seed/foods.json', import.meta.url));

/**
 * Parses and validates the catalog. Separate from loading it so a test can check the file
 * without a database, and so a malformed entry fails with a Zod path rather than a constraint
 * violation halfway through an insert. SQLite does not check text against an enum, the file is
 * hand maintained, and that combination is exactly what a schema is for.
 */
export function readSeedCatalog(): SeedCatalog {
  return seedCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
}

export interface SeedResult {
  foodsInserted: number;
  classificationsInserted: number;
}

/**
 * Inserts whatever is missing and nothing else.
 *
 * Idempotent by comparing the file against the database on every run rather than by recording
 * that it has run, so adding entries to the file and restarting is all it takes. That also
 * means a run interrupted halfway heals itself on the next boot: foods and classifications are
 * reconciled independently, so a food inserted without its verdict is picked up below.
 *
 * A food matches by exact name among the seeded rows only. A user created entry with the same
 * name is left alone and will end up beside it, which is a duplicate the catalog CRUD story
 * resolves with its case insensitive match, not something to half solve here.
 *
 * Changing a colour in the file does not move an existing row. This table is append only, so
 * correcting a verdict means adding a second one, and picking between two seed rows needs the
 * classification resolution rule that does not exist yet.
 */
export function seedFoodCatalog(db: Db): SeedResult {
  const catalog = readSeedCatalog();

  // Soft deleted rows are deliberately included. If somebody removed a seed food, leave it
  // removed rather than resurrecting it on every restart.
  const seededIdsByName = new Map(
    db
      .select({ id: foodTable.id, name: foodTable.name })
      .from(foodTable)
      .where(isNull(foodTable.createdBy))
      .all()
      .map((row) => [row.name, row.id] as const),
  );

  const missingFoods = catalog.foods.filter((food) => !seededIdsByName.has(food.name));
  if (missingFoods.length > 0) {
    const inserted = db
      .insert(foodTable)
      .values(missingFoods.map(({ name, kind }) => ({ name, kind })))
      .returning({ id: foodTable.id, name: foodTable.name })
      .all();

    for (const row of inserted) {
      seededIdsByName.set(row.name, row.id);
    }
  }

  const alreadyClassified = new Set(
    db
      .select({ foodId: foodClassificationTable.foodId })
      .from(foodClassificationTable)
      .where(
        and(isNull(foodClassificationTable.userId), eq(foodClassificationTable.source, 'seed')),
      )
      .all()
      .map((row) => row.foodId),
  );

  const verdicts: { foodId: string; category: Category; source: 'seed' }[] = [];
  for (const food of catalog.foods) {
    const foodId = seededIdsByName.get(food.name);
    if (foodId === undefined || alreadyClassified.has(foodId)) {
      continue;
    }
    verdicts.push({ foodId, category: food.category, source: 'seed' });
  }

  if (verdicts.length > 0) {
    db.insert(foodClassificationTable).values(verdicts).run();
  }

  return { foodsInserted: missingFoods.length, classificationsInserted: verdicts.length };
}
