import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase, type DatabaseHandle } from '../../src/db/client.js';

export interface TestDatabase extends DatabaseHandle {
  path: string;
}

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

export function reopenTestDatabase(database: TestDatabase): DatabaseHandle {
  return openDatabase(database.path);
}
