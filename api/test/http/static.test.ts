import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { createTestDatabase, type TestDatabase } from '../helpers/database.js';

/**
 * The built web client served by the API process, over the real app and a real directory on
 * disk. The directory is stood up here rather than pointed at web/dist, so this suite passes
 * on a checkout nobody has run a build in and says something about the rule rather than about
 * whatever Vite last emitted.
 */

let root: string;
let open: { app: FastifyInstance; database: TestDatabase } | undefined;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'portionium-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(root, 'sw.js'), 'self.addEventListener("install", () => {});');
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'export default 1;');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const database = createTestDatabase();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ROOT: root, ...env }),
    database,
  });
  await app.ready();

  open = { app, database };
  return app;
}

describe('serving the client', () => {
  it('answers the root with the app shell', async () => {
    const response = await (await buildTestApp()).inject({ url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.payload).toContain('shell');
  });

  it('answers a route only the client knows about with the same shell', async () => {
    const response = await (await buildTestApp()).inject({ url: '/settings/tokens?tab=new' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toContain('shell');
  });

  it('serves a real file rather than the shell', async () => {
    const response = await (await buildTestApp()).inject({ url: '/assets/index-abc123.js' });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toBe('export default 1;');
  });

  it('serves nothing at all when no client was configured', async () => {
    const response = await (await buildTestApp({ WEB_ROOT: '' })).inject({ url: '/' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });
});

describe('what it refuses to answer with the shell', () => {
  /**
   * The reason this is served from the not found handler rather than from a wildcard route. A
   * mistyped API path has to stay a problem document: a client that got HTML and a 200 back
   * from an endpoint it misspelled learns nothing until it tries to parse it.
   */
  it('leaves an unknown path under the API prefix as a problem document', async () => {
    const response = await (await buildTestApp()).inject({ url: `${API_PREFIX}/mistyped` });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('answers 404 for an asset that is not there, rather than HTML a browser cannot run', async () => {
    const response = await (await buildTestApp()).inject({ url: '/assets/index-gone.js' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('does not answer a POST to an unknown path with a page', async () => {
    const response = await (await buildTestApp()).inject({ method: 'POST', url: '/whatever' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it.each(['/../package.json', '/assets/../../package.json', '/%2e%2e/package.json'])(
    'refuses to climb out of the directory with %s',
    async (url) => {
      const response = await (await buildTestApp()).inject({ url });

      expect(response.payload).not.toContain('@portionium');
      expect(response.statusCode).not.toBe(200);
    },
  );
});

describe('cache headers', () => {
  it('lets a hashed asset be kept forever, because its name changes when it does', async () => {
    const response = await (await buildTestApp()).inject({ url: '/assets/index-abc123.js' });

    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it.each(['/', '/sw.js'])('makes the browser revalidate %s every time', async (url) => {
    const response = await (await buildTestApp()).inject({ url });

    expect(response.headers['cache-control']).toBe('no-cache');
  });
});

describe('the content security policy', () => {
  it('lets the client run its own bundle', async () => {
    const response = await (await buildTestApp()).inject({ url: '/' });

    expect(response.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('still tells the API itself to load nothing at all', async () => {
    const response = await (await buildTestApp()).inject({ url: '/health' });

    expect(response.headers['content-security-policy']).toContain("default-src 'none';");
    expect(response.headers['content-security-policy']).not.toContain("script-src 'self'");
  });
});
