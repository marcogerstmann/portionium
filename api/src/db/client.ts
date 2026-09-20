import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import SQLite from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema/index.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: SQLite.Database };

export interface DatabaseHandle {
  db: Db;
  close: () => void;
}

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

const shippedMigrationCount: number = (
  JSON.parse(
    readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: unknown[] }
).entries.length;

const PRAGMAS = [
  'journal_mode = WAL',
  // SQLite ignores foreign keys unless asked.
  'foreign_keys = ON',
  'busy_timeout = 5000',
  // Skips the fsync per commit. In WAL mode this can lose the last transactions on power loss,
  // never corrupt the file.
  'synchronous = NORMAL',
];

export function openDatabase(path: string): DatabaseHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const client = new SQLite(path);
  for (const pragma of PRAGMAS) {
    client.pragma(pragma);
  }

  const db = drizzle(client, { schema });
  migrate(db, { migrationsFolder });

  return {
    db,
    close: () => {
      if (client.open) {
        client.close();
      }
    },
  };
}

export function databaseNotReadyReason(db: Db): string | undefined {
  let applied: number;

  try {
    applied = db.$client
      .prepare('select count(*) as count from __drizzle_migrations')
      .pluck()
      .get() as number;
  } catch (error) {
    return `the database did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (applied < shippedMigrationCount) {
    return `the schema is behind this build, ${applied} of ${shippedMigrationCount} migrations applied`;
  }

  return undefined;
}
