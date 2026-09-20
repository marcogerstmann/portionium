import {
  PROBLEM,
  PROBLEM_CONTENT_TYPE,
  type LoginResponse,
  type ProblemDetails,
} from '@portionium/schemas';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { sessionTable } from '../../src/db/schema/index.js';
import { hashToken, MAX_ATTEMPTS_PER_EMAIL } from '../../src/domain/auth.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, TEST_PASSWORD, type TestFixtures } from '../helpers/fixtures.js';

const LOGIN = `${API_PREFIX}/auth/login`;

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

async function buildTestApp() {
  const fixtures = createTestFixtures();
  const app = await buildApp({ config: parseConfig({ LOG_LEVEL: 'fatal' }), database: fixtures });
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

function login(app: FastifyInstance, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: LOGIN, payload });
}

function cookieToken(response: { headers: Record<string, unknown> }): string {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header.join(';') : String(header);
  return value.split(';')[0]!.slice(`${SESSION_COOKIE_NAME}=`.length);
}

describe('signing in', () => {
  it('exchanges an email and password for a session', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD });

    expect(response.statusCode).toBe(200);
    const body = response.json<LoginResponse>();
    expect(body.user).toEqual({
      id: fixtures.userA.id,
      email: fixtures.userA.email,
      displayName: 'User A',
      role: 'user',
      timezone: 'Europe/Berlin',
      dayBoundaryHour: 4,
      locale: null,
    });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('never puts the password hash in the response', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD });

    expect(response.body).not.toContain('argon2');
    expect(response.json<LoginResponse>().user).not.toHaveProperty('passwordHash');
  });

  it('stores a digest of the session token and not the token', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD });
    const sessionToken = cookieToken(response);

    const sessions = fixtures.db.select().from(sessionTable).all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashToken(sessionToken));
    expect(sessions[0]?.userId).toBe(fixtures.userA.id);
    expect(JSON.stringify(sessions[0])).not.toContain(sessionToken);
  });

  it('puts the credential in an HttpOnly cookie and nowhere in the body', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD });
    const cookie = String(response.headers['set-cookie']);

    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(response.body).not.toContain(cookieToken(response));
    expect(response.json<LoginResponse>()).not.toHaveProperty('sessionToken');
  });

  it('marks the cookie Secure when the app is served over https, and not when it is not', async () => {
    const plain = await buildTestApp();
    const secureFixtures = createTestFixtures();
    const overHttps = await buildApp({
      config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN: 'https://portionium.example' }),
      database: secureFixtures,
    });

    try {
      const insecure = await login(plain.app, {
        email: plain.fixtures.userA.email,
        password: TEST_PASSWORD,
      });
      const secure = await overHttps.inject({
        method: 'POST',
        url: LOGIN,
        payload: { email: secureFixtures.userA.email, password: TEST_PASSWORD },
      });

      expect(String(insecure.headers['set-cookie'])).not.toContain('Secure');
      expect(String(secure.headers['set-cookie'])).toContain('Secure');
    } finally {
      await overHttps.close();
    }
  });

  it('accepts the address however it is capitalised', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, {
      email: fixtures.userA.email.toUpperCase(),
      password: TEST_PASSWORD,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<LoginResponse>().user.id).toBe(fixtures.userA.id);
  });

  it('issues a different session every time', async () => {
    const { app, fixtures } = await buildTestApp();
    const credentials = { email: fixtures.userA.email, password: TEST_PASSWORD };

    const first = cookieToken(await login(app, credentials));
    const second = cookieToken(await login(app, credentials));

    expect(first).not.toBe(second);
    expect(fixtures.db.select().from(sessionTable).all()).toHaveLength(2);
  });

  it('rejects a field nobody declared', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, {
      email: fixtures.userA.email,
      password: TEST_PASSWORD,
      rememberMe: true,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('refusing a sign in', () => {
  it('answers an unknown address and a wrong password identically', async () => {
    const { app, fixtures } = await buildTestApp();

    const unknown = await login(app, {
      email: 'nobody@example.test',
      password: 'not the password',
    });
    const wrong = await login(app, {
      email: fixtures.userA.email,
      password: 'not the password',
    });

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);

    const comparable = (problem: ProblemDetails) => ({ ...problem, requestId: 'ignored' });
    expect(comparable(unknown.json<ProblemDetails>())).toEqual(
      comparable(wrong.json<ProblemDetails>()),
    );
    expect(unknown.json<ProblemDetails>().type).toBe(PROBLEM.invalidCredentials);
  });

  it('spends the same work on an address that has no account', async () => {
    const { app } = await buildTestApp();

    const started = performance.now();
    const response = await login(app, {
      email: 'nobody@example.test',
      password: 'not the password',
    });
    const elapsed = performance.now() - started;

    expect(response.statusCode).toBe(401);
    expect(elapsed).toBeGreaterThan(5);
  });

  it('says nothing about accounts in the body', async () => {
    const { app } = await buildTestApp();

    const body = (
      await login(app, { email: 'nobody@example.test', password: 'not the password' })
    ).json<ProblemDetails>();

    expect(body.detail).toBe('Email or password is incorrect.');
    expect(JSON.stringify(body)).not.toMatch(/not found|unknown|no such|exist/i);
  });

  it('does not leak the submitted password back', async () => {
    const { app, fixtures } = await buildTestApp();

    const response = await login(app, {
      email: fixtures.userA.email,
      password: 'hunter2-is-the-password',
    });

    expect(response.body).not.toContain('hunter2');
  });
});

describe('locking out', () => {
  it('stops answering after the documented number of failures, and says when to come back', async () => {
    const { app, fixtures } = await buildTestApp();
    const wrong = { email: fixtures.userA.email, password: 'not the password' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      expect((await login(app, wrong)).statusCode).toBe(401);
    }

    const locked = await login(app, wrong);

    expect(locked.statusCode).toBe(429);
    expect(locked.json<ProblemDetails>().type).toBe(PROBLEM.tooManyLoginAttempts);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(locked.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });

  it('counts failures against an address that has no account, exactly the same', async () => {
    const { app } = await buildTestApp();
    const wrong = { email: 'nobody@example.test', password: 'not the password' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      await login(app, wrong);
    }

    expect((await login(app, wrong)).statusCode).toBe(429);
  });

  it('refuses the right password too, once the address is locked', async () => {
    const { app, fixtures } = await buildTestApp();
    const wrong = { email: fixtures.userA.email, password: 'not the password' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      await login(app, wrong);
    }

    const response = await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD });

    expect(response.statusCode).toBe(429);
    expect(fixtures.db.select().from(sessionTable).all()).toHaveLength(0);
  });

  it('leaves another account alone', async () => {
    const { app, fixtures } = await buildTestApp();

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL; attempt += 1) {
      await login(app, { email: fixtures.userA.email, password: 'not the password' });
    }

    const response = await login(app, { email: fixtures.userB.email, password: TEST_PASSWORD });

    expect(response.statusCode).toBe(200);
  });

  it('forgets the failures once the right password arrives in time', async () => {
    const { app, fixtures } = await buildTestApp();
    const wrong = { email: fixtures.userA.email, password: 'not the password' };

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_EMAIL - 1; attempt += 1) {
      await login(app, wrong);
    }
    expect(
      (await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD })).statusCode,
    ).toBe(200);

    expect((await login(app, wrong)).statusCode).toBe(401);
  });
});

describe('what is deliberately absent', () => {
  it('has no registration endpoint', async () => {
    const { app } = await buildTestApp();

    for (const url of [`${API_PREFIX}/auth/register`, `${API_PREFIX}/auth/signup`, '/register']) {
      expect((await app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(404);
    }
  });

  it('does not answer a GET on the login route', async () => {
    const { app } = await buildTestApp();

    expect((await app.inject({ url: LOGIN })).statusCode).toBe(404);
  });
});
