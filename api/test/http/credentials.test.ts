import {
  API_TOKEN_PREFIX,
  PROBLEM,
  type ApiTokenResponse,
  type CreateApiTokenResponse,
  type ProblemDetails,
  type SessionResponse,
} from '@portionium/schemas';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConfig } from '../../src/config.js';
import { apiTokenTable, sessionTable, userTable } from '../../src/db/schema/index.js';
import { ACTIVITY_INTERVAL_MS, hashToken } from '../../src/domain/auth.js';
import { API_PREFIX, buildApp } from '../../src/http/app.js';
import { SESSION_COOKIE_NAME } from '../../src/http/plugins/auth.js';
import { createTestFixtures, type TestFixtures, type UserRow } from '../helpers/fixtures.js';

/**
 * The two credentials, over the real app and a real database.
 *
 * Everything here is about what happens on the second request rather than the first: whether a
 * session slid, whether a revocation bit, whether a cookie alone was enough to change something.
 * None of that can be checked against a stub, so none of it is.
 */

const WEB_ORIGIN = 'http://localhost:5173';

let open: { app: FastifyInstance; fixtures: TestFixtures } | undefined;

afterEach(async () => {
  await open?.app.close();
  open = undefined;
});

/**
 * The shipped app, plus one route that requires `admin`. Nothing in the API needs that scope
 * yet, so without it the rule that a token never carries more than its owner's role does would
 * have nothing to be asserted against until the first admin endpoint arrives, which is the
 * wrong moment to find out it does not hold.
 */
async function buildTestApp(env: NodeJS.ProcessEnv = {}) {
  const fixtures = createTestFixtures();
  const app = await buildApp({
    config: parseConfig({ LOG_LEVEL: 'fatal', WEB_ORIGIN, ...env }),
    database: fixtures,
  });

  app.get('/admin-only', { config: { auth: 'admin' } }, () => ({ ok: true }));

  await app.ready();

  open = { app, fixtures };
  return { app, fixtures };
}

function url(path: string): string {
  return `${API_PREFIX}${path}`;
}

/** A browser: the cookie, and the Origin header a browser always attaches to a mutation. */
function browser(token: string) {
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: WEB_ORIGIN };
}

/** A script: a bearer header and no origin at all, which is what a script actually sends. */
function script(token: string) {
  return { authorization: `Bearer ${token}` };
}

function problem(payload: string): ProblemDetails {
  return JSON.parse(payload) as ProblemDetails;
}

/** Mints a token through the endpoint rather than the factory, when the endpoint is the point. */
async function mintToken(
  app: FastifyInstance,
  sessionToken: string,
  body: Record<string, unknown> = { name: 'Deploy script', scopes: ['read', 'write'] },
) {
  return app.inject({
    method: 'POST',
    url: url('/auth/tokens'),
    headers: browser(sessionToken),
    payload: body,
  });
}

describe('the sliding expiry', () => {
  it('pushes the expiry out when the session has not been touched for a while', async () => {
    const { app, fixtures } = await buildTestApp();
    const stale = new Date(Date.now() - 2 * ACTIVITY_INTERVAL_MS);
    const token = fixtures.create.session(fixtures.userA, {
      lastActivityAt: stale,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const before = fixtures.db.select().from(sessionTable).get()!;
    await app.inject({ url: url('/auth/sessions'), headers: browser(token) });
    const after = fixtures.db.select().from(sessionTable).get()!;

    expect(after.expiresAt.getTime()).toBeGreaterThan(before.expiresAt.getTime());
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(stale.getTime());
  });

  /**
   * The reason the refresh is throttled at all. Without this, every read this API serves is
   * also a write to the session row that authorised it.
   */
  it('writes nothing when the session was touched a moment ago', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA, { lastActivityAt: new Date() });

    const before = fixtures.db.select().from(sessionTable).get()!;
    await app.inject({ url: url('/auth/sessions'), headers: browser(token) });
    const after = fixtures.db.select().from(sessionTable).get()!;

    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(after.lastActivityAt).toEqual(before.lastActivityAt);
  });

  it('honours the configured window rather than the default one', async () => {
    const { app, fixtures } = await buildTestApp({ SESSION_TTL_DAYS: '1' });
    const token = fixtures.create.session(fixtures.userA, {
      lastActivityAt: new Date(Date.now() - 2 * ACTIVITY_INTERVAL_MS),
    });

    await app.inject({ url: url('/auth/sessions'), headers: browser(token) });

    const { expiresAt } = fixtures.db.select().from(sessionTable).get()!;
    // A day from now, not thirty. Two minutes of slack for a slow machine.
    expect(expiresAt.getTime() - Date.now()).toBeLessThan(24 * 60 * 60 * 1000 + 120_000);
  });
});

describe('listing and revoking sessions', () => {
  it('lists this user sessions, marking the one the request came in on', async () => {
    const { app, fixtures } = await buildTestApp();
    const current = fixtures.create.session(fixtures.userA);
    fixtures.create.session(fixtures.userA);
    fixtures.create.session(fixtures.userB);

    const response = await app.inject({
      url: url('/auth/sessions'),
      headers: browser(current),
    });

    const sessions = response.json<SessionResponse[]>();
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.current)).toHaveLength(1);
    // Nothing resembling a credential is in the list. The id is what a session is revoked by.
    expect(response.payload).not.toContain(current);
  });

  it('leaves an expired session out of the list', async () => {
    const { app, fixtures } = await buildTestApp();
    const current = fixtures.create.session(fixtures.userA);
    fixtures.create.session(fixtures.userA, { expiresAt: new Date(Date.now() - 1000) });

    const sessions = (
      await app.inject({ url: url('/auth/sessions'), headers: browser(current) })
    ).json<SessionResponse[]>();

    expect(sessions).toHaveLength(1);
  });

  it('signs one browser out and leaves the others alone', async () => {
    const { app, fixtures } = await buildTestApp();
    const current = fixtures.create.session(fixtures.userA);
    const other = fixtures.create.session(fixtures.userA);
    const [target] = (await app.inject({ url: url('/auth/sessions'), headers: browser(current) }))
      .json<SessionResponse[]>()
      .filter((session) => !session.current);

    const revoked = await app.inject({
      method: 'DELETE',
      url: url(`/auth/sessions/${target!.id}`),
      headers: browser(current),
    });

    expect(revoked.statusCode).toBe(204);
    expect(
      (await app.inject({ url: url('/auth/sessions'), headers: browser(other) })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ url: url('/auth/sessions'), headers: browser(current) })).statusCode,
    ).toBe(200);
  });

  /** ADR 003: somebody else's row is answered exactly as a row that was never there. */
  it("answers 404 for another user's session", async () => {
    const { app, fixtures } = await buildTestApp();
    const mine = fixtures.create.session(fixtures.userA);
    fixtures.create.session(fixtures.userB);
    const theirs = fixtures.db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.userId, fixtures.userB.id))
      .get()!;

    const response = await app.inject({
      method: 'DELETE',
      url: url(`/auth/sessions/${theirs.id}`),
      headers: browser(mine),
    });

    expect(response.statusCode).toBe(404);
    expect(problem(response.payload).type).toBe(PROBLEM.notFound);
    // Still there, which is the half a status code cannot show.
    expect(fixtures.db.select().from(sessionTable).all()).toHaveLength(2);
  });
});

describe('logging out', () => {
  it('deletes the session server side, not only the cookie', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: url('/auth/logout'),
      headers: browser(token),
    });

    expect(response.statusCode).toBe(204);
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect(fixtures.db.select().from(sessionTable).all()).toHaveLength(0);
    // The credential is dead whatever a client does with that header.
    expect(
      (await app.inject({ url: url('/auth/sessions'), headers: browser(token) })).statusCode,
    ).toBe(401);
  });

  it('refuses an API token, which has no session to end', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: url('/auth/logout'),
      headers: script(token),
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.sessionRequired);
  });
});

describe('the origin check', () => {
  it('refuses a cookie authenticated mutation that names a foreign origin', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: url('/auth/logout'),
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.csrfOriginRejected);
    expect(fixtures.db.select().from(sessionTable).all()).toHaveLength(1);
  });

  /**
   * Refused rather than trusted. Every browser sets Origin on a cross origin request, so its
   * absence on a mutation is either a client nobody supports or somebody hoping this check
   * only looks at the origins it is given.
   */
  it('refuses a cookie authenticated mutation that names no origin at all', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: url('/auth/logout'),
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.csrfOriginRejected);
  });

  it('lets a read through on any origin, because forging one achieves nothing', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.session(fixtures.userA);

    const response = await app.inject({
      url: url('/auth/sessions'),
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: 'https://evil.example' },
    });

    expect(response.statusCode).toBe(200);
  });

  /** Nothing attaches a bearer header on a page's behalf, so there is no CSRF to prevent. */
  it('exempts a bearer token, which no browser sends for anybody', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA);
    const row = fixtures.db.select().from(apiTokenTable).get()!;

    // A mutation, over a bearer header, with no Origin. Refused for a cookie, fine for this.
    const response = await app.inject({
      method: 'DELETE',
      url: url(`/auth/tokens/${row.id}`),
      headers: script(token),
    });

    expect(response.statusCode).toBe(204);
  });
});

describe('minting an API token', () => {
  it('returns the token once, and stores only a digest of it', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);

    const response = await mintToken(app, session);

    expect(response.statusCode).toBe(201);
    const body = response.json<CreateApiTokenResponse>();
    expect(body.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
    expect(body.scopes).toEqual(['read', 'write']);
    expect(body.lastUsedAt).toBeNull();
    expect(body.expiresAt).toBeNull();

    const row = fixtures.db.select().from(apiTokenTable).get()!;
    expect(row.tokenHash).toBe(hashToken(body.token));
    expect(JSON.stringify(row)).not.toContain(body.token);

    // The one response that carries it. Every later read of the same token has no token in it.
    const listed = (await app.inject({ url: url('/auth/tokens'), headers: browser(session) })).json<
      ApiTokenResponse[]
    >();
    expect(listed[0]).not.toHaveProperty('token');
    expect(
      (await app.inject({ url: url('/auth/tokens'), headers: browser(session) })).payload,
    ).not.toContain(body.token);
  });

  it('refuses scopes the user does not hold themselves', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);

    const response = await mintToken(app, session, { name: 'Sneaky', scopes: ['admin'] });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.insufficientScope);
    expect(fixtures.db.select().from(apiTokenTable).all()).toHaveLength(0);
  });

  it('lets an administrator mint an admin token', async () => {
    const { app, fixtures } = await buildTestApp();
    const admin = fixtures.create.user({ role: 'admin' });
    const session = fixtures.create.session(admin);

    const response = await mintToken(app, session, { name: 'Ops', scopes: ['admin'] });

    expect(response.statusCode).toBe(201);
  });

  /**
   * A token that could mint its own successor is a token whose revocation means nothing,
   * because whoever stole it made a fresh one before anybody noticed.
   */
  it('refuses an API token asking for another API token', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA);

    const response = await app.inject({
      method: 'POST',
      url: url('/auth/tokens'),
      headers: script(token),
      payload: { name: 'Successor', scopes: ['read'] },
    });

    expect(response.statusCode).toBe(403);
    expect(problem(response.payload).type).toBe(PROBLEM.sessionRequired);
  });

  it('turns a duration into an expiry rather than taking a date from the client', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);

    const body = (
      await mintToken(app, session, { name: 'Ninety days', scopes: ['read'], expiresInDays: 90 })
    ).json<CreateApiTokenResponse>();

    const days = (new Date(body.expiresAt!).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('rejects a field nobody declared', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);

    const response = await mintToken(app, session, {
      name: 'Odd',
      scopes: ['read'],
      userId: fixtures.userB.id,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('authenticating with an API token', () => {
  it('resolves the owner and carries only the scopes it was granted', async () => {
    const { app, fixtures } = await buildTestApp();
    const readOnly = fixtures.create.apiToken(fixtures.userA, { scopes: ['read'] });

    const listed = await app.inject({ url: url('/auth/tokens'), headers: script(readOnly) });
    const revoked = await app.inject({
      method: 'DELETE',
      url: url(`/auth/tokens/${fixtures.db.select().from(apiTokenTable).get()!.id}`),
      headers: script(readOnly),
    });

    expect(listed.statusCode).toBe(200);
    // A write with a read token, which is the entire reason scopes exist.
    expect(revoked.statusCode).toBe(403);
    expect(problem(revoked.payload).type).toBe(PROBLEM.insufficientScope);
  });

  /** A user demoted out of admin must not keep an admin token that was legitimate when minted. */
  it('never grants more than the owner role does today', async () => {
    const { app, fixtures } = await buildTestApp();
    const admin: UserRow = fixtures.create.user({ role: 'admin' });
    const token = fixtures.create.apiToken(admin, { scopes: ['read', 'write', 'admin'] });

    expect((await app.inject({ url: '/admin-only', headers: script(token) })).statusCode).toBe(200);

    fixtures.db.update(userTable).set({ role: 'user' }).where(eq(userTable.id, admin.id)).run();

    const after = await app.inject({ url: '/admin-only', headers: script(token) });
    expect(after.statusCode).toBe(403);
    expect(problem(after.payload).type).toBe(PROBLEM.insufficientScope);
    // Still a working credential for everything the demoted account can still do.
    expect(
      (await app.inject({ url: url('/auth/tokens'), headers: script(token) })).statusCode,
    ).toBe(200);
  });

  it('refuses a token that has expired', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA, {
      expiresAt: new Date(Date.now() - 1000),
    });

    const response = await app.inject({ url: url('/auth/tokens'), headers: script(token) });

    expect(response.statusCode).toBe(401);
    expect(problem(response.payload).type).toBe(PROBLEM.unauthenticated);
  });

  it('refuses a token whose account has since been deleted', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA);

    fixtures.db
      .update(userTable)
      .set({ deletedAt: new Date() })
      .where(eq(userTable.id, fixtures.userA.id))
      .run();

    expect(
      (await app.inject({ url: url('/auth/tokens'), headers: script(token) })).statusCode,
    ).toBe(401);
  });

  it('records last use, at most once a minute', async () => {
    const { app, fixtures } = await buildTestApp();
    const token = fixtures.create.apiToken(fixtures.userA);

    await app.inject({ url: url('/auth/tokens'), headers: script(token) });
    const firstUse = fixtures.db.select().from(apiTokenTable).get()!.lastUsedAt;
    expect(firstUse).not.toBeNull();

    await app.inject({ url: url('/auth/tokens'), headers: script(token) });
    expect(fixtures.db.select().from(apiTokenTable).get()!.lastUsedAt).toEqual(firstUse);

    // Backdated past the interval, which is the only thing that makes the next request write.
    fixtures.db
      .update(apiTokenTable)
      .set({ lastUsedAt: new Date(Date.now() - 2 * ACTIVITY_INTERVAL_MS) })
      .run();
    await app.inject({ url: url('/auth/tokens'), headers: script(token) });

    expect(fixtures.db.select().from(apiTokenTable).get()!.lastUsedAt!.getTime()).toBeGreaterThan(
      Date.now() - ACTIVITY_INTERVAL_MS,
    );
  });
});

describe('revoking an API token', () => {
  /** The acceptance criterion, stated as the only thing that matters: the very next request. */
  it('takes effect immediately', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);
    const token = (await mintToken(app, session)).json<CreateApiTokenResponse>();

    expect(
      (await app.inject({ url: url('/auth/tokens'), headers: script(token.token) })).statusCode,
    ).toBe(200);

    const revoked = await app.inject({
      method: 'DELETE',
      url: url(`/auth/tokens/${token.id}`),
      headers: browser(session),
    });

    expect(revoked.statusCode).toBe(204);
    const after = await app.inject({ url: url('/auth/tokens'), headers: script(token.token) });
    expect(after.statusCode).toBe(401);
    expect(problem(after.payload).type).toBe(PROBLEM.unauthenticated);
  });

  it('keeps the revoked row, so a list still says what it was', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);
    const token = (await mintToken(app, session)).json<CreateApiTokenResponse>();

    await app.inject({
      method: 'DELETE',
      url: url(`/auth/tokens/${token.id}`),
      headers: browser(session),
    });

    const listed = (await app.inject({ url: url('/auth/tokens'), headers: browser(session) })).json<
      ApiTokenResponse[]
    >();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.name).toBe('Deploy script');
  });

  it('answers 404 the second time, and for a token that is not this user', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);
    const token = (await mintToken(app, session)).json<CreateApiTokenResponse>();
    fixtures.create.apiToken(fixtures.userB);
    const theirRow = fixtures.db
      .select()
      .from(apiTokenTable)
      .where(eq(apiTokenTable.userId, fixtures.userB.id))
      .get()!;

    const del = (id: string) =>
      app.inject({ method: 'DELETE', url: url(`/auth/tokens/${id}`), headers: browser(session) });

    expect((await del(token.id)).statusCode).toBe(204);
    expect((await del(token.id)).statusCode).toBe(404);
    expect((await del(theirRow.id)).statusCode).toBe(404);
    // Untouched, which is the half a status code cannot show.
    expect(
      fixtures.db.select().from(apiTokenTable).where(eq(apiTokenTable.id, theirRow.id)).get()!
        .revokedAt,
    ).toBeNull();
  });

  it('does not list, or revoke, a token belonging to somebody else', async () => {
    const { app, fixtures } = await buildTestApp();
    const session = fixtures.create.session(fixtures.userA);
    fixtures.create.apiToken(fixtures.userB, { name: 'Theirs' });

    const listed = (await app.inject({ url: url('/auth/tokens'), headers: browser(session) })).json<
      ApiTokenResponse[]
    >();

    expect(listed).toHaveLength(0);
  });
});
