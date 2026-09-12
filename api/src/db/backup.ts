import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import { databaseNotReadyReason, openDatabase, type Db } from './client.js';

/**
 * Backups, and the restore that is the only thing which makes one a backup rather than a hope.
 *
 * One rule decides the shape of everything here: a running SQLite database in WAL mode is not
 * its file. The committed data is split between `portionium.db` and `portionium.db-wal` until a
 * checkpoint moves it, so `cp portionium.db elsewhere` copies a prefix of the truth and does it
 * without a lock, which can also catch a page mid write. That copy usually opens, which is what
 * makes it dangerous: the corruption is found on the day it is needed.
 *
 * So a backup here is `VACUUM INTO`, which SQLite runs inside a read transaction and writes as a
 * complete, freshly packed database. It blocks no reader, it delays a writer by a moment, and
 * what lands is a file that stands on its own with no sidecars to remember.
 *
 * The restore path is exercised on every push, see test/backup.test.ts and the `restore` job in
 * .github/workflows/ci.yml. The commands and the recovery order are docs/runbooks/backup.md.
 */

/** How many backups survive in each tier. See selectExpiredBackups for what a tier means. */
export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupOptions {
  /** Directory the archives live in. Created if it is not there. */
  directory: string;
  policy: RetentionPolicy;
}

export interface Backup {
  name: string;
  path: string;
  /** When the backup was taken, read from its name rather than from the filesystem. */
  at: Date;
}

export interface BackupResult {
  backup: Backup;
  sizeBytes: number;
  /** Names dropped by the retention policy in the same run, oldest first. */
  pruned: string[];
}

/**
 * Archive names, and the only place the format is written down.
 *
 * The timestamp is in the name rather than left to the filesystem because an mtime does not
 * survive a copy to object storage, a restore onto another machine or an `rsync -a` somebody
 * forgot the `-a` on. The name is the one piece of metadata that travels with the bytes, and it
 * is what the retention policy reads, so a directory of archives needs no index and no database.
 *
 * UTC, seconds, no punctuation a shell would argue with, and sortable as a string.
 */
const NAME_PATTERN = /^portionium-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/;

function backupName(at: Date): string {
  return `portionium-${at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}.db.gz`;
}

/** The instant a name encodes, or undefined for a file this module did not write. */
function backupTime(name: string): Date | undefined {
  const match = NAME_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

/**
 * Every archive in the directory, newest first. A directory that does not exist yet is empty
 * rather than an error, because that is what a first run looks like.
 *
 * Anything whose name this module did not write is ignored and never deleted. The directory is
 * somebody's filesystem and a retention policy that removes files it does not recognise is one
 * incident away from taking the off-machine copy with it.
 */
export function listBackups(directory: string): Backup[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .flatMap((name) => {
      const at = backupTime(name);
      return at === undefined ? [] : [{ name, path: join(directory, name), at }];
    })
    .sort((a, b) => b.at.getTime() - a.at.getTime());
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Which archives the policy no longer keeps, oldest first.
 *
 * Grandfather-father-son, the same scheme every backup tool settles on: an archive survives if
 * it is the newest one in a period that still has room, and it is counted in every tier it is
 * newest for. So a week of daily backups keeps seven files, and the weekly and monthly tiers
 * then reach further back rather than being spent on days already covered. Seven, four and
 * three is a fortnight of detail, a month of weeks and a quarter of months, for around twelve
 * files and twelve times the size of the database.
 *
 * A tier of zero is allowed and switches that tier off. `daily` has a floor of one in the
 * config, which is what keeps the newest archive out of reach of any policy: pruning the backup
 * that was just taken is the one bug in here that would be invisible until the restore.
 *
 * ponytail: the week bucket is seven day blocks from the epoch rather than an ISO week, so it
 * turns over on a Thursday. Retention does not care which day a week starts on, and an ISO week
 * number is twenty lines that can be wrong at a year boundary.
 */
export function selectExpiredBackups(backups: Backup[], policy: RetentionPolicy): Backup[] {
  const newestFirst = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime());
  const claimed: Record<keyof RetentionPolicy, Set<number | string>> = {
    daily: new Set(),
    weekly: new Set(),
    monthly: new Set(),
  };
  const expired: Backup[] = [];

  for (const backup of newestFirst) {
    const day = Math.floor(backup.at.getTime() / DAY_MS);
    const period = {
      daily: day,
      weekly: Math.floor(day / 7),
      monthly: `${backup.at.getUTCFullYear()}-${backup.at.getUTCMonth()}`,
    };

    let keep = false;
    for (const tier of ['daily', 'weekly', 'monthly'] as const) {
      const seen = claimed[tier];
      if (!seen.has(period[tier]) && seen.size < policy[tier]) {
        seen.add(period[tier]);
        keep = true;
      }
    }

    if (!keep) {
      expired.push(backup);
    }
  }

  return expired.reverse();
}

/**
 * Takes a backup and applies the retention policy to what is now in the directory.
 *
 * Three steps, because `VACUUM INTO` writes a plain database, gzip is what makes it a fraction of
 * the size, and a rename is what stops a half written one from ever wearing a backup's name. An
 * interrupted run leaves a dot file the next run reclaims, never a truncated archive that looks
 * like a backup and restores to nothing.
 *
 * Pruning happens after the new archive is on disk and never before, so a failed backup costs
 * nothing that was already there.
 */
export async function createBackup(
  db: Db,
  { directory, policy }: BackupOptions,
): Promise<BackupResult> {
  mkdirSync(directory, { recursive: true });

  const at = new Date();
  const name = backupName(at);
  const path = join(directory, name);
  // Dot prefixed and fixed, so both are skipped by listBackups and reclaimed by the next run
  // rather than accumulated. In the same directory as the archive, which is what makes the
  // rename below atomic: a rename across filesystems is a copy, and a copy can be interrupted.
  const staging = join(directory, '.portionium-backup.db');
  const stagingArchive = `${staging}.gz`;

  try {
    // A read transaction against the live database. Readers are unaffected, a writer waits for
    // a moment, and what is written includes everything committed to the WAL.
    db.$client.prepare('vacuum into ?').run(staging);

    await pipeline(createReadStream(staging), createGzip(), createWriteStream(stagingArchive));

    // The archive takes its real name only once it is complete, in one atomic step. Written
    // straight to its final name it would be a truncated file wearing a backup's name after a
    // kill, a full disk or a lost container, which is worse than no backup: the retention policy
    // would count it, and somebody would restore it.
    renameSync(stagingArchive, path);
  } finally {
    rmSync(staging, { force: true });
    rmSync(stagingArchive, { force: true });
  }

  const pruned = selectExpiredBackups(listBackups(directory), policy);
  for (const backup of pruned) {
    rmSync(backup.path, { force: true });
  }

  return {
    backup: { name, path, at },
    sizeBytes: statSync(path).size,
    pruned: pruned.map((backup) => backup.name),
  };
}

/**
 * Takes a backup only if the newest one is older than `intervalMs`, and says so by returning
 * nothing when it is not due.
 *
 * The schedule is a timer in a process that gets restarted, which is the whole reason this check
 * exists. A plain daily timer means an instance redeployed every morning never reaches its first
 * tick and has no backups at all, and a check that only ran at startup means a crash loop writes
 * one archive a minute. Asking the directory how old the newest archive is answers both, and it
 * survives the process because the answer is on disk rather than in memory.
 */
export async function createBackupIfDue(
  db: Db,
  options: BackupOptions & { intervalMs: number },
): Promise<BackupResult | undefined> {
  const [newest] = listBackups(options.directory);
  if (newest !== undefined && Date.now() - newest.at.getTime() < options.intervalMs) {
    return undefined;
  }

  return createBackup(db, options);
}

export interface RestoreResult {
  path: string;
  /** Migrations the restored file carries, which is what readiness checks against this build. */
  migrationsApplied: number;
}

/**
 * Unpacks an archive into a working database at `targetPath`, and refuses to report success
 * until it has opened the result and found it sound.
 *
 * A restore that is not verified is the same hope as a backup that is not restored, so this does
 * four things a `gunzip` on its own does not.
 *
 * It unpacks to a staging file beside the target and moves it into place at the end, once the
 * checks below have passed. Nothing touches the target path until then, which is the property
 * that matters: unpacking straight onto it creates the file before the first byte is read, so a
 * missing archive, a truncated one or a full disk leaves an empty database where the real one
 * used to be. Start the application against that and it migrates the empty file into a working,
 * blank instance, and a restore has turned into a fresh install. Ask how the afternoon went.
 *
 * It removes the `-wal` and `-shm` sidecars of the target, at the moment it moves the new file
 * in. They belong to the file that used to be there, and SQLite opening a restored database next
 * to a stale WAL is the other way this operation loses data quietly: the pages in that WAL are
 * newer than the file and get applied on top of it.
 *
 * It runs `integrity_check`, which reads every page and every index rather than trusting that
 * the file opens.
 *
 * And it opens the file the way the application does, so the migrations this build ships are
 * applied to an older archive here rather than on the next boot, and a schema the build cannot
 * serve is a failure of the restore rather than of the deployment after it.
 *
 * An existing target is refused unless `force` says otherwise. Restoring onto a live database is
 * how a bad afternoon becomes a worse one, and the runbook's first step is to stop the process.
 */
export async function restoreBackup(
  archivePath: string,
  targetPath: string,
  { force = false }: { force?: boolean } = {},
): Promise<RestoreResult> {
  if (!force && existsSync(targetPath)) {
    throw new Error(
      `${targetPath} already exists. Stop the application, move it aside, and restore again, ` +
        'or pass --force to overwrite it. See docs/runbooks/backup.md.',
    );
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  // Beside the target rather than in a temp directory, so the move at the end is a rename within
  // one filesystem and therefore atomic. Across filesystems it would be a copy, which is the
  // thing being avoided here.
  const staging = `${targetPath}.restoring`;
  const staged = [staging, `${staging}-wal`, `${staging}-shm`];
  const discardStaging = () => {
    for (const path of staged) {
      rmSync(path, { force: true });
    }
  };

  discardStaging();

  try {
    await pipeline(createReadStream(archivePath), createGunzip(), createWriteStream(staging));

    const handle = openDatabase(staging);
    let migrationsApplied: number;
    try {
      const integrity = handle.db.$client.pragma('integrity_check') as {
        integrity_check: string;
      }[];
      if (integrity[0]?.integrity_check !== 'ok') {
        throw new Error(
          `${archivePath} unpacks to a database SQLite rejects: ` +
            `${integrity.map((row) => row.integrity_check).join('; ')}`,
        );
      }

      const reason = databaseNotReadyReason(handle.db);
      if (reason !== undefined) {
        throw new Error(`${archivePath} unpacks to a database this build cannot serve: ${reason}`);
      }

      migrationsApplied = handle.db.$client
        .prepare('select count(*) as count from __drizzle_migrations')
        .pluck()
        .get() as number;
    } finally {
      // Closed before the move, which is also what checkpoints the WAL back into the file, so
      // what gets renamed is the whole database and not a part of it.
      handle.close();
    }

    for (const suffix of ['-wal', '-shm']) {
      rmSync(`${targetPath}${suffix}`, { force: true });
    }
    renameSync(staging, targetPath);

    return { path: targetPath, migrationsApplied };
  } catch (error) {
    // The target is as it was, whatever went wrong. That is the whole point of the staging file.
    discardStaging();
    throw error;
  }
}
