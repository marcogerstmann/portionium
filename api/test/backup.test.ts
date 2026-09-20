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

function dailyBackups(newest: string, days: number): Backup[] {
  const start = new Date(newest).getTime();

  return Array.from({ length: days }, (_, index) => {
    const at = new Date(start - index * 24 * 60 * 60 * 1000);
    return { name: archiveName(at), path: join('/backups', archiveName(at)), at };
  });
}

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
    fixtures = createTestFixtures();
    seedFoodCatalog(fixtures.db);

    const user = fixtures.userA;
    const { meal, entries } = fixtures.create.meal(user);
    const foodsBefore = count(fixtures.db, 'select count(*) as count from food');
    const migrationsBefore = count(
      fixtures.db,
      'select count(*) as count from __drizzle_migrations',
    );

    expect(foodsBefore).toBeGreaterThan(100);
    expect(migrationsBefore).toBeGreaterThan(0);

    const directory = join(scratch(), 'backups');

    const created = await execFileAsync(TSX, [CLI, 'create', '--dir', directory], {
      env: { ...process.env, DATABASE_PATH: fixtures.path },
    });
    expect(created.stdout).toContain('Wrote ');

    const [archive] = listBackups(directory);
    expect(archive).toBeDefined();

    fixtures.close();
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${fixtures.path}${suffix}`, { force: true });
    }
    expect(existsSync(fixtures.path)).toBe(false);

    const restored = await execFileAsync(TSX, [CLI, 'restore', '--from', archive!.path], {
      env: { ...process.env, DATABASE_PATH: fixtures.path },
    });
    expect(restored.stdout).toContain('integrity check passed');
    expect(restored.stdout).toContain(`${migrationsBefore} migration(s) applied`);

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

      expect(
        count(reopened.db, 'select count(*) as count from meal where user_id = ?', user.id),
      ).toBe(1);
      expect(
        count(reopened.db, 'select count(*) as count from entry where meal_id = ?', meal.id),
      ).toBe(entries.length);
      expect(count(reopened.db, 'select count(*) as count from food')).toBe(foodsBefore);

      expect(count(reopened.db, 'select count(*) as count from __drizzle_migrations')).toBe(
        migrationsBefore,
      );
    } finally {
      reopened.close();
    }

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
    expect(existsSync(target)).toBe(true);

    await expect(restoreBackup(backup.path, target, { force: true })).resolves.toMatchObject({
      path: target,
    });
  });

  it('leaves no stale write-ahead log beside a restored database', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');

    const { backup } = await createBackup(fixtures.db, { directory, policy: KEEP_EVERYTHING });

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

    await expect(
      restoreBackup(join(directory, 'portionium-20000101T000000Z.db.gz'), target),
    ).rejects.toThrow();

    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.restoring`)).toBe(false);

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
    const archive = join(scratch(), 'portionium-20260101T000000Z.db.gz');
    writeFileSync(archive, gzipSync(Buffer.from('this is not a database')));

    const target = join(workspace!, 'target.db');
    await expect(restoreBackup(archive, target)).rejects.toThrow();
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

    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeDefined();
    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeUndefined();

    freezeTime('2026-09-13T14:31:00.000Z');
    await expect(createBackupIfDue(fixtures.db, options)).resolves.toBeDefined();
    expect(listBackups(options.directory)).toHaveLength(2);
  });

  it('ignores a file it did not write, and never deletes one', async () => {
    fixtures = createTestFixtures();
    const directory = join(scratch(), 'backups');
    const policy = { daily: 1, weekly: 0, monthly: 0 };

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
