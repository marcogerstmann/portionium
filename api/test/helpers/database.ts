import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type DatabaseHandle } from '../../src/db/client.js';

export interface TestDatabase extends DatabaseHandle {
  /** The file backing this database, for assertions that care about the file itself. */
  path: string;
}

/**
 * A fresh, fully migrated database in its own temp directory.
 *
 * A file rather than :memory: because WAL, the busy timeout and cross connection behaviour
 * only exist for a real file, and those are the things worth testing. Each call gets its own
 * directory, so tests never see each other's rows and can run in parallel.
 *
 * close() drops the connection and the directory, including the -wal and -shm sidecars.
 * Call it from afterEach, or from onTestFinished for a database opened mid test.
 */
export function createTestDatabase(): TestDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'portionium-test-'));
  const path = join(directory, 'test.db');
  const handle = openDatabase(path);

  return {
    db: handle.db,
    path,
    close: () => {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Reopens an existing database file the way a restart would, sharing the temp directory of
 * the database it is given. Used to prove that startup migrations are idempotent.
 */
export function reopenTestDatabase(database: TestDatabase): DatabaseHandle {
  return openDatabase(database.path);
}
