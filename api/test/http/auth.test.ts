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
import { hashSessionToken, MAX_ATTEMPTS_PER_EMAIL } from '../../src/domain/auth.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { createTestFixtures, TEST_PASSWORD, type TestFixtures } from '../helpers/fixtures.js';

/**
 * Signing in, over the real application and a real database.
 *
 * Most of what this endpoint has to get right is not the happy path, it is what two different
 * failures have in common, so most of what follows compares one refusal against another.
 */

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

    const { sessionToken } = (
      await login(app, { email: fixtures.userA.email, password: TEST_PASSWORD })
    ).json<LoginResponse>();

    const sessions = fixtures.db.select().from(sessionTable).all();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).toBe(hashSessionToken(sessionToken));
    expect(sessions[0]?.userId).toBe(fixtures.userA.id);
    // The credential itself is nowhere in the row.
    expect(JSON.stringify(sessions[0])).not.toContain(sessionToken);
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

    const first = (await login(app, credentials)).json<LoginResponse>().sessionToken;
    const second = (await login(app, credentials)).json<LoginResponse>().sessionToken;

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
  /**
   * The acceptance criterion this endpoint exists to satisfy. A client holding both responses
   * side by side must not be able to tell which address has an account behind it, so the two
   * are compared field by field rather than only by status code.
   */
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

    // instance is the same URL, and requestId is the one field that differs by construction.
    const comparable = (problem: ProblemDetails) => ({ ...problem, requestId: 'ignored' });
    expect(comparable(unknown.json<ProblemDetails>())).toEqual(
      comparable(wrong.json<ProblemDetails>()),
    );
    expect(unknown.json<ProblemDetails>().type).toBe(PROBLEM.invalidCredentials);
  });

  /**
   * The other half of the same criterion, and the one a body comparison cannot see. An endpoint
   * that returns early for an address it does not know answers in microseconds, while a wrong
   * password costs a full Argon2 verification, and that difference is measurable remotely.
   *
   * The assertion is a floor rather than a comparison between the two timings. A floor can only
   * fail if the hashing was skipped, which is the mistake worth catching, and it does not turn
   * red because a shared CI runner was busy for a moment.
   */
  it('spends the same work on an address that has no account', async () => {
    const { app } = await buildTestApp();

    const started = performance.now();
    const response = await login(app, {
      email: 'nobody@example.test',
      password: 'not the password',
    });
    const elapsed = performance.now() - started;

    expect(response.statusCode).toBe(401);
    // Argon2id over 19 MiB takes tens of milliseconds. An early return takes a fraction of one.
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

  /**
   * A lockout that only ever happened to real accounts would answer the existence question the
   * identical 401 refuses to, just more slowly.
   */
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

    // Four failures ago is forgotten, so this is the first of a new five and not the last.
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
