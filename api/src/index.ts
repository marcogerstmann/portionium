import { openDatabase } from './db/client.js';
import { parseConfig } from './config.js';

try {
  const config = parseConfig(process.env);
  // Applies any pending migrations before anything else can touch the database.
  openDatabase(config.DATABASE_PATH);
  // Replaced by the real server bootstrap once http/ exists.
  console.log(
    `@portionium/api: config ok, ${config.NODE_ENV}, port ${config.PORT}, db ${config.DATABASE_PATH}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
