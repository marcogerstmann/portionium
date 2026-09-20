import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp, OPENAPI_PATH } from '../../src/http/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

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

  await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot(
    '../../openapi/openapi.json',
  );
});
