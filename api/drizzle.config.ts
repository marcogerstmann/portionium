import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit only ever generates SQL here, it never applies it. Migrations are applied by
 * openDatabase() at startup, see src/db/client.ts.
 *
 * Generate with `pnpm db:generate <snake_case_name>`, which passes --name through so the file
 * is called 0001_add_meal_table.sql rather than one of drizzle-kit's random codenames.
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_PATH ?? './data/portionium.db' },
  // Ask before generating something destructive, and print the SQL that will be written.
  strict: true,
  verbose: true,
});
