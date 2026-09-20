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

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

export interface BackupOptions {
  directory: string;
  policy: RetentionPolicy;
}

export interface Backup {
  name: string;
  path: string;
  at: Date;
}

export interface BackupResult {
  backup: Backup;
  sizeBytes: number;
  pruned: string[];
}

const NAME_PATTERN = /^portionium-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/;

function backupName(at: Date): string {
  return `portionium-${at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}.db.gz`;
}

function backupTime(name: string): Date | undefined {
  const match = NAME_PATTERN.exec(name);
  if (match === null) {
    return undefined;
  }

  const [, year, month, day, hour, minute, second] = match;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
}

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

export async function createBackup(
  db: Db,
  { directory, policy }: BackupOptions,
): Promise<BackupResult> {
  mkdirSync(directory, { recursive: true });

  const at = new Date();
  const name = backupName(at);
  const path = join(directory, name);
  // Dot prefixed so listBackups skips it, and beside the archive so the rename below stays on one
  // filesystem and therefore atomic: a half written file under a real name would be restored.
  const staging = join(directory, '.portionium-backup.db');
  const stagingArchive = `${staging}.gz`;

  try {
    db.$client.prepare('vacuum into ?').run(staging);

    await pipeline(createReadStream(staging), createGzip(), createWriteStream(stagingArchive));

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
  migrationsApplied: number;
}

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

  // Beside the target, so the move is on one filesystem and therefore atomic.
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
      // Closed before the move, which checkpoints the WAL back into the file being renamed.
      handle.close();
    }

    for (const suffix of ['-wal', '-shm']) {
      rmSync(`${targetPath}${suffix}`, { force: true });
    }
    renameSync(staging, targetPath);

    return { path: targetPath, migrationsApplied };
  } catch (error) {
    discardStaging();
    throw error;
  }
}
