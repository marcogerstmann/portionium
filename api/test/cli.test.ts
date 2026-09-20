import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { findUserByEmail, insertApiToken, insertSession } from '../src/db/auth.js';
import { apiTokenTable, sessionTable } from '../src/db/schema/index.js';
import { createApiToken, createSessionToken } from '../src/domain/auth.js';
import { createTestDatabase, type TestDatabase } from './helpers/database.js';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli/user.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

const PASSWORD = 'a-sufficiently-long-password';

let database: TestDatabase;

afterEach(() => {
  database?.close();
});

async function runUser(args: string[], password = PASSWORD) {
  const child = execFileAsync(TSX, [CLI, ...args], {
    env: { ...process.env, DATABASE_PATH: database.path },
  });

  child.child.stdin?.end(password);

  return child;
}

describe('the user command', () => {
  it('makes the first account an admin and every one after it a plain user', async () => {
    database = createTestDatabase();

    const first = await runUser([
      'create',
      '--email',
      'Ada@Example.TEST',
      '--name',
      'Ada Lovelace',
      '--timezone',
      'Europe/Berlin',
    ]);
    const second = await runUser([
      'create',
      '--email',
      'bob@example.test',
      '--name',
      'Bob',
      '--timezone',
      'America/New_York',
    ]);

    expect(first.stdout).toContain('Created admin ada@example.test');
    expect(second.stdout).toContain('Created user bob@example.test');

    const ada = findUserByEmail(database.db, 'ada@example.test');
    expect(ada?.email).toBe('ada@example.test');
    expect(ada?.role).toBe('admin');
    expect(ada?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(ada?.passwordHash).not.toContain(PASSWORD);
  });

  it('refuses a password the policy would not accept, and writes nothing', async () => {
    database = createTestDatabase();

    await expect(
      runUser(
        ['create', '--email', 'ada@example.test', '--name', 'Ada', '--timezone', 'Europe/Berlin'],
        'short',
      ),
    ).rejects.toThrow(/12 characters/);

    expect(findUserByEmail(database.db, 'ada@example.test')).toBeUndefined();
  });

  it('changes a password and ends the sessions the old one authorised', async () => {
    database = createTestDatabase();
    await runUser([
      'create',
      '--email',
      'ada@example.test',
      '--name',
      'Ada',
      '--timezone',
      'Europe/Berlin',
    ]);

    const ada = findUserByEmail(database.db, 'ada@example.test');
    const { tokenHash, expiresAt } = createSessionToken();
    insertSession(database.db, { userId: ada!.id, tokenHash, expiresAt });

    const changed = await runUser(
      ['passwd', '--email', 'ADA@example.test'],
      'a-brand-new-password',
    );

    expect(changed.stdout).toContain('1 session(s) invalidated');
    expect(database.db.select().from(sessionTable).all()).toHaveLength(0);
    expect(findUserByEmail(database.db, 'ada@example.test')?.passwordHash).not.toBe(
      ada?.passwordHash,
    );
  });

  it('revokes every live API token at once and leaves the sessions alone', async () => {
    database = createTestDatabase();
    await runUser([
      'create',
      '--email',
      'ada@example.test',
      '--name',
      'Ada',
      '--timezone',
      'Europe/Berlin',
    ]);

    const ada = findUserByEmail(database.db, 'ada@example.test');
    for (const name of ['Deploy script', 'Phone shortcut']) {
      insertApiToken(database.db, {
        userId: ada!.id,
        name,
        tokenHash: createApiToken().tokenHash,
        scopes: ['read'],
        expiresAt: null,
      });
    }
    const { tokenHash, expiresAt } = createSessionToken();
    insertSession(database.db, { userId: ada!.id, tokenHash, expiresAt });

    const revoked = await runUser(['revoke-tokens', '--email', 'ADA@example.test']);

    expect(revoked.stdout).toContain('Revoked 2 API token(s)');
    expect(
      database.db
        .select()
        .from(apiTokenTable)
        .all()
        .every((token) => token.revokedAt !== null),
    ).toBe(true);
    expect(database.db.select().from(sessionTable).all()).toHaveLength(1);

    const again = await runUser(['revoke-tokens', '--email', 'ada@example.test']);
    expect(again.stdout).toContain('Revoked 0 API token(s)');
  });
});
