import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createBackup,
  createBackupIfDue,
  listBackups,
  restoreBackup,
  selectExpiredBackups,
  type Backup,
} from '../src/db/backup.js';
import { openDatabase, type Db } from '../src/db/client.js';
import { seedFoodCatalog } from '../src/db/seed.js';
import { createTestFixtures, type TestFixtures } from './helpers/fixtures.js';
import { freezeTime } from './helpers/time.js';

/**
 * The restore path, exercised on every push. This file is what the `restore` job in
 * .github/workflows/ci.yml runs, and it is the whole claim the README makes: a backup nobody has
 * restored is not a backup, and the only way to know is to destroy a database and bring it back.
 *
 * The round trip below does it the hard way on purpose, through the commands in the runbook, as
 * separate processes, against a database that is then deleted along with its sidecars. A test
 * that called these functions in process would pass while the documented command was broken,
 * and the documented command is what somebody runs on the worst afternoon of the quarter.
 */

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../src/cli/backup.ts', import.meta.url));
const USER_CLI = fileURLToPath(new URL('../src/cli/user.ts', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

const KEEP_EVERYTHING = { daily: 365, weekly: 0, monthly: 0 };

let fixtures: TestFixtures;
let workspace: string | undefined;

afterEach(() => {
  fixtures?.close();
  if (workspace !== undefined) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = undefined;
  }
});

function scratch(): string {
  workspace = mkdtempSync(join(tmpdir(), 'portionium-backup-'));
  return workspace;
}

function archiveName(at: Date): string {
  return `portionium-${at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}.db.gz`;
}

/** A directory listing of daily archives, newest first, without writing any files. */
function dailyBackups(newest: string, days: number): Backup[] {
  const start = new Date(newest).getTime();

  return Array.from({ length: days }, (_, index) => {
    const at = new Date(start - index * 24 * 60 * 60 * 1000);
    return { name: archiveName(at), path: join('/backups', archiveName(at)), at };
  });
}

/** One count, spelled the way the assertions below need it: a number, now, not a promise. */
function count(db: Db, sql: string, ...parameters: unknown[]): number {
  return db.$client
    .prepare(sql)
    .pluck()
    .get(...parameters) as number;
}

function keptBy(backups: Backup[], policy: Parameters<typeof selectExpiredBackups>[1]): string[] {
  const expired = new Set(selectExpiredBackups(backups, policy).map((backup) => backup.name));
  return backups.filter((backup) => !expired.has(backup.name)).map((backup) => backup.name);
}

describe('the backup and restore round trip', () => {
  it('survives the database being destroyed, through the documented commands', async () => {
    // A database with the catalog that ships with the app and an account somebody would notice
    // the loss of. Seeded rather than empty, because an empty file restores whether or not the
    // restore works.
    fixtures = createTestFixtures();
    seedFoodCatalog(fixtures.db);

    const user = fixtures.userA;
    const { meal, items } = fixtures.create.meal(user);
    const foodsBefore = count(fixtures.db, 'select count(*) as count from food');
    const migrationsBefore = count(
      fixtures.db,
      'select count(*) as count from __drizzle_migrations',
    );

    expect(foodsBefore).toBeGreaterThan(100);
    expect(migrationsBefore).toBeGreaterThan(0);

    const directory = join(scratch(), 'backups');

    // Taken while the connection above is still open and its writes are still in the WAL, which
    // is the only state a live instance is ever backed up in.
    const created = await execFileAsync(TSX, [CLI, 'create', '--dir', directory], {
      env: { ...process.env, DATABASE_PATH: fixtures.path },
    });
    expect(created.stdout).toContain('Wrote ');

    const [archive] = listBackups(directory);
    expect(archive).toBeDefined();

    // Destroy the original the way a lost volume or a bad migration does: the file and both
    // sidecars, connection closed first so nothing is holding pages that could mask the loss.
    fixtures.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${fixtures.path}${suffix}`, { force: true });
    }
    expect(existsSync(fixtures.path)).toBe(false);

    const restored = await execFileAsync(TSX, [CLI, 'restore', '--from', archive!.path], {
      env: { ...process.env, DATABASE_PATH: fixtures.path },
    });
    expect(restored.stdout).toContain('integrity check passed');
    // The version assertion, from the command itself as well as from the file below, because
    // this is the line an operator reads and believes.
    expect(restored.stdout).toContain(`${migrationsBefore} migration(s) applied`);

    // The known records, read through a fresh connection to the file that was brought back.
    const reopened = openDatabase(fixtures.path);
    try {
      const restoredUser = reopened.db.$client
        .prepare('select email, display_name as displayName, timezone from user where id = ?')
        .get(user.id) as { email: string; displayName: string; timezone: string } | undefined;

      expect(restoredUser).toEqual({
        email: user.email,
        displayName: user.displayName,
        timezone: user.timezone,
      });

      // A row the test wrote, a row behind a foreign key, and the product data that ships with
      // the app: three different ways a restore can come back half empty.
      expect(
        count(reopened.db, 'select count(*) as count from meal where user_id = ?', user.id),
      ).toBe(1);
      expect(
        count(reopened.db, 'select count(*) as count from meal_item where meal_id = ?', meal.id),
      ).toBe(items.length);
      expect(count(reopened.db, 'select count(*) as count from food')).toBe(foodsBefore);

      // The schema is at the version this build ships, which is the half of a restore that is
      // silently untrue when an archive predates a migration.
      expect(count(reopened.db, 'select count(*) as count from __drizzle_migrations')).toBe(
        migrationsBefore,
      );
    } finally {
      reopened.close();
    }

    // And it is a working database rather than merely a readable one: a command writes to it.
    const passwd = execFileAsync(TSX, [USER_CLI, 'passwd', '--email', user.email], {
      env: { ...process.env, DATABASE_PATH: fixtures.path },
    });
    passwd.child.stdin?.end('a-sufficiently-long-password');
    expect((await passwd).stdout).toContain('Password changed');
  });

  it('refuses to overwrite a database that is already there, unless told to', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');

    const { backup } = await createBackup(fixtures.db, { directory, policy: KEEP_EVERYTHING });

    const target = join(workspace!, 'existing.db');
    writeFileSync(target, 'not a database');

    await expect(restoreBackup(backup.path, target)).rejects.toThrow('already exists');
    // Refused rather than half done: the file somebody would have lost is untouched.
    expect(existsSync(target)).toBe(true);

    await expect(restoreBackup(backup.path, target, { force: true })).resolves.toMatchObject({
      path: target,
    });
  });

  it('leaves no stale write-ahead log beside a restored database', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');

    const { backup } = await createBackup(fixtures.db, { directory, policy: KEEP_EVERYTHING });

    // A WAL belonging to the database that used to be at this path. SQLite would apply those
    // pages on top of the restored file, which is the one way this operation loses data quietly.
    const target = join(workspace!, 'target.db');
    writeFileSync(target, 'whatever was here before');
    writeFileSync(`${target}-wal`, 'pages from a database that is gone');
    writeFileSync(`${target}-shm`, 'and its shared memory index');

    await restoreBackup(backup.path, target, { force: true });

    expect(existsSync(`${target}-wal`)).toBe(false);
    expect(existsSync(`${target}-shm`)).toBe(false);
  });

  it('leaves the target alone when the restore fails, so a failure is not a blank instance', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');
    await createBackup(fixtures.db, { directory, policy: KEEP_EVERYTHING });

    const target = join(workspace!, 'target.db');

    // An archive that is not there, which is what a mistyped name or an expired one looks like.
    await expect(
      restoreBackup(join(directory, 'portionium-20000101T000000Z.db.gz'), target),
    ).rejects.toThrow();

    // Nothing at the target, not even an empty file. Unpacking straight onto the path would
    // create it before the first byte is read, and the application would then migrate that
    // empty file into a working, blank instance on the next start.
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.restoring`)).toBe(false);

    // And the same with a target that already held the database somebody is trying to recover.
    const existing = join(workspace!, 'existing.db');
    writeFileSync(existing, 'the database somebody still has');
    await expect(
      restoreBackup(join(directory, 'portionium-20000101T000000Z.db.gz'), existing, {
        force: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(existing)).toBe(true);
  });

  it('rejects an archive whose contents are not a database, rather than reporting a restore', async () => {
    // Valid gzip, and nothing SQLite will open. The verification has to be of what unpacked and
    // not of whether the unpacking worked, which is the difference between this passing and a
    // restore that reports success onto an unusable file.
    const archive = join(scratch(), 'portionium-20260101T000000Z.db.gz');
    writeFileSync(archive, gzipSync(Buffer.from('this is not a database')));

    const target = join(workspace!, 'target.db');
    await expect(restoreBackup(archive, target)).rejects.toThrow();
    // And it leaves nothing behind that a later start could migrate into a blank instance.
    expect(existsSync(target)).toBe(false);
  });
});

describe('taking a backup', () => {
  it('writes a compressed archive named for the moment it was taken, and leaves no staging file', async () => {
    freezeTime('2026-09-12T14:30:00.000Z');
    fixtures = createTestFixtures();
    seedFoodCatalog(fixtures.db);
    const directory = join(scratch(), 'nested', 'backups');

    const result = await createBackup(fixtures.db, { directory, policy: KEEP_EVERYTHING });

    expect(result.backup.name).toBe('portionium-20260912T143000Z.db.gz');
    expect(result.sizeBytes).toBeGreaterThan(0);
    // Gzip earns its place: the catalog and the schema together are several hundred kilobytes
    // of database and compress to a fraction of it.
    expect(result.sizeBytes).toBeLessThan(256 * 1024);
    expect(existsSync(join(directory, '.portionium-backup.db'))).toBe(false);
    expect(listBackups(directory).map((backup) => backup.name)).toEqual([result.backup.name]);
  });

  it('takes one only when the newest is older than the interval', async () => {
    freezeTime('2026-09-12T14:30:00.000Z');
    fixtures = createTestFixtures();

    const options = {
      directory: join(scratch(), 'backups'),
      policy: KEEP_EVERYTHING,
      intervalMs: 24 * 60 * 60 * 1000,
    };

    // A fresh instance has nothing, so the first tick is due. That is the case a plain daily
    // timer gets wrong: an instance redeployed every morning never reaches its first tick.
    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeDefined();
    // The restart right after it is not due, which is the case a backup at startup gets wrong.
    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeUndefined();

    freezeTime('2026-09-13T14:31:00.000Z');
    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeDefined();
    expect(listBackups(options.directory)).toHaveLength(2);
  });

  it('ignores a file it did not write, and never deletes one', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');
    const policy = { daily: 1, weekly: 0, monthly: 0 };

    // Somebody's off-machine copy, or a note to themselves. A retention policy that removed
    // what it does not recognise is one incident away from taking the spare with it.
    await createBackup(fixtures.db, { directory, policy });
    const stranger = join(directory, 'portionium-yesterday.db.gz.keep');
    writeFileSync(stranger, 'mine');

    await createBackup(fixtures.db, { directory, policy });

    expect(existsSync(stranger)).toBe(true);
  });
});

describe('the retention policy', () => {
  it('keeps a fortnight of days, then weeks, then months, out of two months of dailies', () => {
    const backups = dailyBackups('2026-09-12T02:00:00Z', 60);

    const kept = keptBy(backups, { daily: 7, weekly: 4, monthly: 3 });

    // Eleven files rather than sixty, and eleven rather than the fourteen a reading of "seven
    // plus four plus three" suggests: an archive counts in every tier it is newest for, so the
    // newest one is the current day, the current week and the current month at once. What is
    // left is a week of daily detail, two older weeks, and the last day of the two months
    // before this one.
    expect(kept).toEqual([
      'portionium-20260912T020000Z.db.gz',
      'portionium-20260911T020000Z.db.gz',
      'portionium-20260910T020000Z.db.gz',
      'portionium-20260909T020000Z.db.gz',
      'portionium-20260908T020000Z.db.gz',
      'portionium-20260907T020000Z.db.gz',
      'portionium-20260906T020000Z.db.gz',
      'portionium-20260902T020000Z.db.gz',
      'portionium-20260831T020000Z.db.gz',
      'portionium-20260826T020000Z.db.gz',
      'portionium-20260731T020000Z.db.gz',
    ]);
  });

  it('never expires the only archive there is, whatever the policy says', () => {
    const backups = dailyBackups('2026-09-12T02:00:00Z', 1);

    // daily has a floor of one in the config for exactly this: the archive that was just taken
    // must not be reachable by the policy that runs immediately after it.
    expect(selectExpiredBackups(backups, { daily: 1, weekly: 0, monthly: 0 })).toEqual([]);
  });

  it('expires nothing while the tiers still have room', () => {
    const backups = dailyBackups('2026-09-12T02:00:00Z', 5);

    expect(selectExpiredBackups(backups, { daily: 7, weekly: 4, monthly: 3 })).toEqual([]);
  });

  it('returns what it drops oldest first, so a log line reads in the order things happened', () => {
    const backups = dailyBackups('2026-09-12T02:00:00Z', 4);

    const expired = selectExpiredBackups(backups, { daily: 2, weekly: 0, monthly: 0 });

    expect(expired.map((backup) => backup.name)).toEqual([
      'portionium-20260909T020000Z.db.gz',
      'portionium-20260910T020000Z.db.gz',
    ]);
  });
});
