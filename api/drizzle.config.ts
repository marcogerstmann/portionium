import { defineConfig } from 'drizzle-kit';

/** drizzle-kit only generates SQL here. Migrations are applied by openDatabase() at startup. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_PATH ?? './data/portionium.db' },
  strict: true,
  verbose: true,
});
