import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import SQLite from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import * as schema from './schema/index.js';

/**
 * The whole persistence layer is one SQLite file. Why SQLite and not PostgreSQL, what write
 * concurrency that buys us, and what would make us move: docs/adr/001-sqlite-over-postgresql.md.
 *
 * This module is the only place a connection is opened. Everything else takes a `Db`.
 */

/**
 * Drizzle handle bound to our schema. This is what repositories take, and the only database
 * type that leaves this module.
 *
 * `$client` is Drizzle's own escape hatch to the driver, part of what drizzle() returns. It is
 * here for pragmas and for the odd statement Drizzle cannot express, not as a way to hand write
 * queries: the dependency-cruiser rules keep all of that inside db/ either way.
 */
export type Db = BetterSQLite3Database<typeof schema> & { $client: SQLite.Database };

export interface DatabaseHandle {
  db: Db;
  /** Closes the connection. Safe to call twice. */
  close: () => void;
}

/**
 * Generated migrations. Committed, applied in order, never hand-edited once applied.
 *
 * Relative to this file rather than to the working directory, so it resolves the same when
 * run from source and from dist/: both sit two levels under api/.
 */
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Pragmas that matter for a single file database with more than one reader.
 *
 * Only journal_mode is stored in the file itself. The other three are per connection and fall
 * back to the SQLite defaults every time one is opened, so they are set here rather than once
 * at setup time.
 */
const PRAGMAS = [
  // Readers do not block the writer and the writer does not block readers.
  'journal_mode = WAL',
  // SQLite ignores foreign keys unless asked. Off by default, for backwards compatibility.
  'foreign_keys = ON',
  // Wait for a held write lock instead of failing instantly with SQLITE_BUSY.
  'busy_timeout = 5000',
  // Skip the fsync on every commit. In WAL mode this can lose the last transactions on power
  // loss, never corrupt the database. Worth the write throughput here.
  'synchronous = NORMAL',
];

/**
 * Opens the database, applies the pragmas, and brings the schema up to date.
 *
 * Migrations run here rather than in a separate deploy step because the app is a single
 * process against a single file, so there is no window where old code meets a new schema.
 * Drizzle records what it has applied in __drizzle_migrations and skips those, which makes
 * calling this on every boot idempotent.
 */
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
