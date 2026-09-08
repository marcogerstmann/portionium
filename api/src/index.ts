import { openDatabase } from './db/client.js';
import { seedFoodCatalog } from './db/seed.js';
import { parseConfig } from './config.js';

try {
  const config = parseConfig(process.env);
  // Applies any pending migrations before anything else can touch the database.
  const { db } = openDatabase(config.DATABASE_PATH);
  // Same reasoning as running migrations here: one process, one file, and the loader only
  // writes what is missing, so a restart after adding entries to the catalog is the whole
  // deployment step.
  const seeded = seedFoodCatalog(db);
  // Replaced by the real server bootstrap once http/ exists.
  console.log(
    `@portionium/api: config ok, ${config.NODE_ENV}, port ${config.PORT}, db ${config.DATABASE_PATH}`,
  );
  console.log(
    `@portionium/api: seeded ${seeded.foodsInserted} foods, ${seeded.classificationsInserted} classifications`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
