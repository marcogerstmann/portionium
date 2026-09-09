import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp, OPENAPI_PATH } from '../../src/http/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

/**
 * The committed contract, checked against the generated one.
 *
 * There is no hand written spec in this repository, so this file is not a second definition of
 * the API. It is a snapshot of the generated one, committed so that a change to the public
 * contract shows up as a diff in the pull request that causes it. A reviewer can see that a
 * field was renamed or a status added without reading the route, and a change nobody meant to
 * make has to be staged deliberately before it can be merged.
 *
 * Regenerate with `pnpm --filter @portionium/api openapi`, which is `vitest -u` over this file.
 * There is no separate generator script and no extra CI step: the check and the update are the
 * same mechanism, so the snapshot cannot be written by something other than what verifies it.
 */

let open: { app: FastifyInstance; database: TestDatabase } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

it('matches the spec committed under api/openapi', async () => {
  const database = createTestDatabase();
  const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal' }), database });
  await app.ready();
  open = { app, database };

  const document: unknown = (await app.inject({ url: `${API_PREFIX}${OPENAPI_PATH}` })).json();

  // Formatted the way Prettier formats JSON, because `prettier --check .` reads this file too
  // and a snapshot that fails the formatter is a snapshot nobody can commit.
  await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot(
    '../../openapi/openapi.json',
  );
});
