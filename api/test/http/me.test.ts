import { PROBLEM, type ProblemDetails, type UserResponse } from '@portionium/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { sessionTable, userTable } from '../../src/db/schema/index.js';
import { verifyPassword } from '../../src/domain/auth.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import {
  createTestFixtures,
  TEST_PASSWORD,
  type TestFixtures,
  type UserRow,
} from '../helpers/fixtures.js';

/**
 * The profile endpoints, over the real app and a real database.
 *
 * Two accounts exist in every one of these tests, because the interesting property of `/me` is
 * not that it answers, it is that it answers about exactly one of them and cannot be pointed at
 * the other. Most of what follows is that, or is about what a change to one account does to the
 * credentials belonging to it.
 */

const WEB_ORIGIN = 'http://localhost:5173';
const ME = `${API_PREFIX}/me`;
const PASSWORD = `${API_PREFIX}/me/password`;

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

async function buildTestApp() {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN }),
    database: fixtures,
  });
  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

/** A browser: the cookie, and the Origin header a browser always attaches to a mutation. */
function browser(token: string) {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: WEB_ORIGIN };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

function storedUser(fixtures: TestFixtures, user: UserRow) {
  return fixtures.db.select().from(userTable).where(eq(userTable.id, user.id)).get();
}

describe('reading the profile', () => {
  it('answers with the account the credential belongs to', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: ME, headers: browser(token) });

    expect(response.statusCode).toBe(200);
    expect(response.json<UserResponse>()).toEqual({
      id: fixtures.userA.id,
      email: fixtures.userA.email,
      displayName: 'User A',
      role: 'user',
      timezone: 'Europe/Berlin',
      dayBoundaryHour: 4,
    });
  });

  it('answers the other account for the other credential, with no id in the path either way', async () => {
    const { app, fixtures } = await buildTestApp();

    const b = await app.inject({
      url: ME,
      headers: browser(fixtures.create.session(fixtures.userB)),
    });

    expect(b.json<UserResponse>().id).toBe(fixtures.userB.id);
    expect(b.json<UserResponse>().timezone).toBe('America/New_York');
  });

  it('never carries the password hash', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({ url: ME, headers: browser(token) });

    expect(response.body).not.toContain('argon2');
    expect(response.json()).not.toHaveProperty('passwordHash');
  });

  it('needs a credential', async () => {
    const { app } = await buildTestApp();

    expect((await app.inject({ url: ME })).statusCode).toBe(401);
  });
});

describe('changing the profile', () => {
  it('updates the three fields a user owns', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload: { displayName: 'Ada', timezone: 'Europe/Lisbon', dayBoundaryHour: 3 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UserResponse>()).toMatchObject({
      displayName: 'Ada',
      timezone: 'Europe/Lisbon',
      dayBoundaryHour: 3,
    });
    expect(storedUser(fixtures, fixtures.userA)?.timezone).toBe('Europe/Lisbon');
  });

  it('leaves the fields a request did not name alone', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload: { displayName: 'Ada' },
    });

    const stored = storedUser(fixtures, fixtures.userA);
    expect(stored?.displayName).toBe('Ada');
    expect(stored?.timezone).toBe('Europe/Berlin');
    expect(stored?.dayBoundaryHour).toBe(4);
  });

  it('accepts an empty patch as the no-op it is, rather than failing on the query', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<UserResponse>().displayName).toBe('User A');
  });

  it('rejects a timezone the runtime has never heard of, before anything derives a date from it', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload: { timezone: 'CEST' },
    });

    expect(response.statusCode).toBe(400);
    expect(problem(response.payload).type).toBe(PROBLEM.validationFailed);
    expect(storedUser(fixtures, fixtures.userA)?.timezone).toBe('Europe/Berlin');
  });

  it('rejects a day boundary hour that is not an hour', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    for (const dayBoundaryHour of [-1, 24, 3.5]) {
      const response = await app.inject({
        method: 'PATCH',
        url: ME,
        headers: browser(token),
        payload: { dayBoundaryHour },
      });

      expect(response.statusCode).toBe(400);
    }
  });

  it.each([
    ['role', { role: 'admin' }],
    ['email', { email: 'someone.else@example.test' }],
    ['user id', { userId: '0199e0e9-1c4b-7000-8f2c-6e4c1c2a9b31' }],
  ])('refuses to be sent a %s rather than quietly ignoring it', async (_name, payload) => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(storedUser(fixtures, fixtures.userA)?.role).toBe('user');
  });

  it('changes nothing on the other account', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    await app.inject({
      method: 'PATCH',
      url: ME,
      headers: browser(token),
      payload: { displayName: 'Ada' },
    });

    expect(storedUser(fixtures, fixtures.userB)?.displayName).toBe('User B');
  });

  it('needs the write scope, not just a credential', async () => {
    const { app, fixtures } = await buildTestApp();
    const readOnly = fixtures.create.apiToken(fixtures.userA, { scopes: ['read'] });

    const response = await app.inject({
      method: 'PATCH',
      url: ME,
      headers: { authorization: `Bearer ${readOnly}` },
      payload: { displayName: 'Ada' },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.insufficientScope);
  });
});

describe('changing the password', () => {
  const NEW_PASSWORD = 'a whole new set of words';

  function change(app: FastifyInstance, token: string, payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: PASSWORD, headers: browser(token), payload });
  }

  it('stores a new hash once the current password checks out', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await change(app, token, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(204);
    const hash = storedUser(fixtures, fixtures.userA)?.passwordHash ?? '';
    expect(await verifyPassword(hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, TEST_PASSWORD)).toBe(false);
  });

  it('ends every session, including the one that asked', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const otherBrowser = fixtures.create.session(fixtures.userA);

    await change(app, token, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect(
      fixtures.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, fixtures.userA.id))
        .all(),
    ).toHaveLength(0);
    expect((await app.inject({ url: ME, headers: browser(token) })).statusCode).toBe(401);
    expect((await app.inject({ url: ME, headers: browser(otherBrowser) })).statusCode).toBe(401);
  });

  it('clears the cookie, so the browser stops sending a credential that is already dead', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await change(app, token, {
      currentPassword: TEST_PASSWORD,
      newPassword: NEW_PASSWORD,
    });

    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it("leaves API tokens working, because a script did not rotate anybody's password", async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    const script = fixtures.create.apiToken(fixtures.userA);

    await change(app, token, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    const response = await app.inject({
      url: ME,
      headers: { authorization: `Bearer ${script}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a wrong current password with something a client will not read as a dead session', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await change(app, token, {
      currentPassword: 'not the password',
      newPassword: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.invalidCurrentPassword);
    expect(
      await verifyPassword(storedUser(fixtures, fixtures.userA)?.passwordHash ?? '', TEST_PASSWORD),
    ).toBe(true);
  });

  it('refuses an API token, so a stolen one cannot lock its owner out', async () => {
    const { app, fixtures } = await buildTestApp();
    const script = fixtures.create.apiToken(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: PASSWORD,
      headers: { authorization: `Bearer ${script}` },
      payload: { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.sessionRequired);
    expect(
      await verifyPassword(storedUser(fixtures, fixtures.userA)?.passwordHash ?? '', TEST_PASSWORD),
    ).toBe(true);
  });

  it('holds the new password to the policy and the current one to nothing but a length', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const tooShort = await change(app, token, {
      currentPassword: TEST_PASSWORD,
      newPassword: 'short',
    });
    expect(tooShort.statusCode).toBe(400);

    // A wrong current password of any length is the same refusal, never a 400 that would say
    // "we would not have stored that anyway".
    const wrongAndShort = await change(app, token, {
      currentPassword: 'x',
      newPassword: NEW_PASSWORD,
    });
    expect(wrongAndShort.statusCode).toBe(403);
  });

  it('does not touch the other account', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);
    fixtures.create.session(fixtures.userB);

    await change(app, token, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });

    expect(
      await verifyPassword(storedUser(fixtures, fixtures.userB)?.passwordHash ?? '', TEST_PASSWORD),
    ).toBe(true);
    expect(
      fixtures.db
        .select()
        .from(sessionTable)
        .where(eq(sessionTable.userId, fixtures.userB.id))
        .all(),
    ).toHaveLength(1);
  });
});
