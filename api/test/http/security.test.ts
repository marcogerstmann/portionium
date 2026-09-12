import { PROBLEM, PROBLEM_CONTENT_TYPE, type ProblemDetails } from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { HEALTH_PATH, READY_PATH } from '../../src/http/routes/health.js';
import { createTestFixtures, TEST_PASSWORD, type TestFixtures } from '../helpers/fixtures.js';

/**
 * Rate limiting, the security headers and CORS, over the real application.
 *
 * All three are hooks on the root instance, which is the only way any of them is worth
 * anything: a limit a route can forget to apply is a limit that is missing from whichever
 * route somebody adds next. So the assertions below are mostly about routes that never opted
 * in to being protected, including ones that do not exist.
 */

const LOGIN = `${API_PREFIX}/auth/login`;
const SESSIONS = `${API_PREFIX}/auth/sessions`;
/** A read that is not under the auth prefix, so it is charged to the read bucket. */
const SPEC = `${API_PREFIX}/openapi.json`;
const WEB_ORIGIN = 'http://localhost:5173';
const OTHER_ORIGIN = 'https://app.example';

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN, ...env }),
    database: fixtures,
  });
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

/** A request from a chosen address. trustProxy is on, so the header is what request.ip reads. */
function get(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': '203.0.113.7', ...headers },
  });
}

describe('rate limiting', () => {
  it('refuses the request after the limit with a problem document and Retry-After', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '2' });

    expect((await get(app, SPEC)).statusCode).toBe(200);
    expect((await get(app, SPEC)).statusCode).toBe(200);

    const refused = await get(app, SPEC);

    expect(refused.statusCode).toBe(429);
    expect(refused.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    const body = refused.json<ProblemDetails>();
    expect(body.type).toBe(PROBLEM.rateLimited);
    expect(body.status).toBe(429);
    expect(body.requestId).not.toBe('');
  });

  /** A request that matched no route never reaches a handler, and is counted all the same. */
  it('counts a request that matched no route', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '1' });

    expect((await get(app, '/no-such-route')).statusCode).toBe(404);
    expect((await get(app, SPEC)).statusCode).toBe(429);
  });

  /**
   * The reason the hook runs before authentication rather than after it. Fastify stops the
   * chain at the first failure, so a limiter behind the auth plugin would never count a request
   * carrying a dead credential, which is what a flood is made of.
   */
  it('counts a request refused for a credential that resolves to nobody', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_AUTH_PER_MINUTE: '1' });

    const rejected = await get(app, SESSIONS, { authorization: 'Bearer prt_nonsense' });
    expect(rejected.statusCode).toBe(401);

    const refused = await get(app, SESSIONS, { authorization: 'Bearer prt_nonsense' });
    expect(refused.statusCode).toBe(429);
  });

  it('does not let a rotating forged credential buy a fresh allowance', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '2' });

    for (const attempt of [1, 2]) {
      await get(app, SPEC, { authorization: `Bearer prt_forged${attempt}` });
    }

    const refused = await get(app, SPEC, { authorization: 'Bearer prt_forged3' });
    expect(refused.statusCode).toBe(429);
  });

  it('follows one credential across addresses', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '2' });

    for (const address of ['198.51.100.1', '198.51.100.2']) {
      await get(app, SPEC, {
        'x-forwarded-for': address,
        authorization: 'Bearer prt_travelling',
      });
    }

    const refused = await get(app, SPEC, {
      'x-forwarded-for': '198.51.100.3',
      authorization: 'Bearer prt_travelling',
    });

    expect(refused.statusCode).toBe(429);
  });

  it('spends reads and writes from separate allowances', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '1' });

    expect((await get(app, SPEC)).statusCode).toBe(200);
    expect((await get(app, SPEC)).statusCode).toBe(429);

    // The write bucket is untouched, and its own limit is the default rather than one, so this
    // gets as far as the router and is refused for the reason it should be.
    const write = await app.inject({
      method: 'POST',
      url: '/no-such-route',
      headers: { 'x-forwarded-for': '203.0.113.7', origin: WEB_ORIGIN },
      payload: {},
    });
    expect(write.statusCode).toBe(404);
  });

  it('holds sign in to its own stricter allowance', async () => {
    const { app, fixtures } = await buildTestApp({ RATE_LIMIT_AUTH_PER_MINUTE: '1' });

    const first = await app.inject({
      method: 'POST',
      url: LOGIN,
      payload: { email: fixtures.userA.email, password: TEST_PASSWORD },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: LOGIN,
      payload: { email: fixtures.userA.email, password: TEST_PASSWORD },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json<ProblemDetails>().type).toBe(PROBLEM.rateLimited);
  });

  /**
   * An orchestrator reads a 429 as a dead process. Behind a proxy that does not forward the
   * client address every caller shares one IP, so limiting the probe would turn a busy minute
   * into a restart loop.
   */
  it('never rate limits either probe', async () => {
    const { app } = await buildTestApp({ RATE_LIMIT_READ_PER_MINUTE: '1' });

    // The readiness probe for the same reason one step further on: a 429 reads as an instance to
    // stop sending traffic to, so limiting it takes the instance out of rotation during exactly
    // the busy minute it was coping with.
    for (const path of [HEALTH_PATH, READY_PATH]) {
      for (let probe = 0; probe < 5; probe += 1) {
        expect((await get(app, path)).statusCode).toBe(200);
      }
    }
  });
});

describe('security headers', () => {
  it('sets them on every response, including one nothing routed', async () => {
    const { app } = await buildTestApp();

    for (const url of [HEALTH_PATH, '/no-such-route']) {
      const response = await get(app, url);

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    }
  });

  it('sends HSTS only when the instance is actually served over https', async () => {
    const { app } = await buildTestApp();
    expect((await get(app, HEALTH_PATH)).headers['strict-transport-security']).toBeUndefined();

    await open?.app.close();
    const secure = await buildTestApp({ WEB_ORIGIN: 'https://portionium.example' });
    expect((await get(secure.app, HEALTH_PATH)).headers['strict-transport-security']).toContain(
      'max-age=',
    );
  });

  it('loosens the policy for the Swagger UI and nowhere else', async () => {
    const { app } = await buildTestApp();

    const docs = await get(app, `${API_PREFIX}/docs/`);
    expect(docs.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");

    const spec = await get(app, `${API_PREFIX}/openapi.json`);
    expect(spec.headers['content-security-policy']).not.toContain('script-src');
  });
});

describe('CORS', () => {
  it('sends nothing at all when no origin is allowed', async () => {
    const { app } = await buildTestApp();

    const response = await get(app, HEALTH_PATH, { origin: OTHER_ORIGIN });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
  });

  it('echoes an allowed origin and varies on it, never a wildcard', async () => {
    const { app } = await buildTestApp({ CORS_ORIGINS: OTHER_ORIGIN });

    const allowed = await get(app, HEALTH_PATH, { origin: OTHER_ORIGIN });
    expect(allowed.headers['access-control-allow-origin']).toBe(OTHER_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers.vary).toBe('Origin');

    const refused = await get(app, HEALTH_PATH, { origin: 'https://elsewhere.example' });
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    // Still varies, so a cache cannot hand the allowed answer to this origin.
    expect(refused.headers.vary).toBe('Origin');
  });

  it('answers a preflight before anything asks it for a credential', async () => {
    const { app } = await buildTestApp({ CORS_ORIGINS: OTHER_ORIGIN });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: SESSIONS,
      headers: {
        origin: OTHER_ORIGIN,
        'access-control-request-method': 'DELETE',
        'access-control-request-headers': 'authorization',
      },
    });

    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toContain('DELETE');
    expect(preflight.headers['access-control-allow-headers']).toContain('Idempotency-Key');
    expect(preflight.headers['access-control-max-age']).toBeDefined();
  });

  it('does not answer a preflight from an origin nobody allowed', async () => {
    const { app } = await buildTestApp({ CORS_ORIGINS: OTHER_ORIGIN });

    const preflight = await app.inject({
      method: 'OPTIONS',
      url: SESSIONS,
      headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'DELETE' },
    });

    expect(preflight.statusCode).not.toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('request body size', () => {
  it('refuses a body over the cap with a problem document', async () => {
    const { app } = await buildTestApp({ MAX_BODY_BYTES: '1024' });

    const response = await app.inject({
      method: 'POST',
      url: LOGIN,
      headers: { 'x-forwarded-for': '203.0.113.7' },
      payload: { email: 'a@b.de', password: 'x'.repeat(2048) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    expect(response.json<ProblemDetails>().status).toBe(413);
  });
});
