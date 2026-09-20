import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { categorySchema, foodKindSchema } from '@portionium/schemas';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { insertClassifications, type NewClassification } from './classification.js';
import type { Db } from './client.js';
import { foodClassificationTable, foodTable } from './schema/index.js';

const seedCatalogSchema = z.object({
  version: z.int().positive(),
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

const catalogPath = fileURLToPath(new URL('../../seed/foods.json', import.meta.url));

export function readSeedCatalog(): SeedCatalog {
  return seedCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
}

export interface SeedResult {
  foodsInserted: number;
  classificationsInserted: number;
}

export function seedFoodCatalog(db: Db): SeedResult {
  const catalog = readSeedCatalog();

  // Soft deleted rows are included: a seed food somebody removed stays removed rather than being
  // resurrected on every restart.
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

  const verdicts: NewClassification[] = [];
  for (const food of catalog.foods) {
    const foodId = seededIdsByName.get(food.name);
    if (foodId === undefined || alreadyClassified.has(foodId)) {
      continue;
    }
    verdicts.push({ foodId, category: food.category, source: 'seed' });
  }

  insertClassifications(db, verdicts);

  return { foodsInserted: missingFoods.length, classificationsInserted: verdicts.length };
}
