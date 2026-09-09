import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  countUsers,
  findUserByEmail,
  insertApiToken,
  insertSession,
  insertUser,
  setPasswordHash,
} from '../src/db/auth.js';
import { apiTokenTable, sessionTable, userTable } from '../src/db/schema/index.js';
import { createApiToken, createSessionToken } from '../src/domain/auth.js';
import { createTestFixtures, TEST_PASSWORD_HASH, type TestFixtures } from './helpers/fixtures.js';

/**
 * The account and session queries, against a real migrated file.
 *
 * Two properties are worth the setup here and cannot be checked anywhere else: that an address
 * has exactly one spelling in the column whatever a caller types, and that changing a password
 * takes the sessions with it in the same transaction.
 */

let fixtures: TestFixtures;

function open(): TestFixtures {
  fixtures = createTestFixtures();
  return fixtures;
}

afterEach(() => {
  fixtures?.close();
});

const NEW_USER = {
  passwordHash: TEST_PASSWORD_HASH,
  displayName: 'Ada',
  timezone: 'Europe/Berlin',
};

describe('email normalisation', () => {
  it('stores an address lowercased and trimmed, whatever was typed', () => {
    const { db } = open();

    const user = insertUser(db, { ...NEW_USER, email: '  Ada.Lovelace@Example.TEST ' });

    expect(user.email).toBe('ada.lovelace@example.test');
  });

  it('finds an account however the address is capitalised', () => {
    const { db } = open();
    insertUser(db, { ...NEW_USER, email: 'ada@example.test' });

    for (const spelling of ['ada@example.test', 'Ada@Example.test', 'ADA@EXAMPLE.TEST']) {
      expect(findUserByEmail(db, spelling)?.email).toBe('ada@example.test');
    }
  });

  /**
   * The point of normalising at the funnel rather than at each caller. Without it the unique
   * index is a check on capitalisation and two people can hold the same address.
   */
  it('refuses a second account for the same address in different case', () => {
    const { db } = open();
    insertUser(db, { ...NEW_USER, email: 'ada@example.test' });

    expect(() => insertUser(db, { ...NEW_USER, email: 'ADA@example.test' })).toThrow(/UNIQUE/i);
  });

  it('throws on something that is not an address, rather than querying for it', () => {
    const { db } = open();

    expect(() => findUserByEmail(db, 'not-an-address')).toThrow();
  });
});

describe('finding an account', () => {
  it('does not find a soft deleted one, so a closed account cannot sign in', () => {
    const { db, userA } = open();
    db.update(userTable).set({ deletedAt: new Date() }).where(eq(userTable.id, userA.id)).run();

    expect(findUserByEmail(db, userA.email)).toBeUndefined();
  });

  it('counts live accounts only, which is what makes the first one an admin', () => {
    const { db, userA } = open();

    expect(countUsers(db)).toBe(2);

    db.update(userTable).set({ deletedAt: new Date() }).where(eq(userTable.id, userA.id)).run();
    expect(countUsers(db)).toBe(1);
  });
});

describe('changing a password', () => {
  it('replaces the hash and ends every session opened with the old one', () => {
    const { db, userA } = open();
    for (let i = 0; i < 3; i += 1) {
      const { tokenHash, expiresAt } = createSessionToken();
      insertSession(db, { userId: userA.id, tokenHash, expiresAt });
    }

    const invalidated = setPasswordHash(db, userA.id, 'a-new-hash');

    expect(invalidated).toBe(3);
    expect(db.select().from(sessionTable).all()).toHaveLength(0);
    expect(findUserByEmail(db, userA.email)?.passwordHash).toBe('a-new-hash');
  });

  it('leaves everybody else signed in', () => {
    const { db, userA, userB } = open();
    const other = createSessionToken();
    insertSession(db, {
      userId: userB.id,
      tokenHash: other.tokenHash,
      expiresAt: other.expiresAt,
    });
    const mine = createSessionToken();
    insertSession(db, { userId: userA.id, tokenHash: mine.tokenHash, expiresAt: mine.expiresAt });

    expect(setPasswordHash(db, userA.id, 'a-new-hash')).toBe(1);

    const survivors = db.select().from(sessionTable).all();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.userId).toBe(userB.id);
  });

  /**
   * The other half of the promise on setPasswordHash, and the decision the story that added
   * API tokens had to make on purpose.
   *
   * A token is a credential its owner issued deliberately, to a script that is not sitting at
   * the keyboard. Revoking it because somebody rotated a password would break automation as a
   * side effect of good hygiene, so a password change reaches into exactly one table.
   */
  it('leaves API tokens working, which is the point of them being a separate credential', () => {
    const { db, userA } = open();
    const { tokenHash, expiresAt } = createSessionToken();
    insertSession(db, { userId: userA.id, tokenHash, expiresAt });
    insertApiToken(db, {
      userId: userA.id,
      name: 'Deploy script',
      tokenHash: createApiToken().tokenHash,
      scopes: ['read', 'write'],
      expiresAt: null,
    });
    const users = db.select().from(userTable).all().length;

    setPasswordHash(db, userA.id, 'a-new-hash');

    expect(db.select().from(sessionTable).all()).toHaveLength(0);
    expect(db.select().from(apiTokenTable).get()?.revokedAt).toBeNull();
    expect(db.select().from(userTable).all()).toHaveLength(users);
  });
});
