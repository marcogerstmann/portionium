import { parseArgs } from 'node:util';

import { parseConfig } from '../config.js';
import { createBackup, listBackups, restoreBackup, type RetentionPolicy } from '../db/backup.js';
import { openDatabase } from '../db/client.js';

/**
 * Backup and restore, from a terminal on the machine the database is on.
 *
 * The same authorisation the account commands have and for the same reason: being on the box
 * with the file. There is no HTTP endpoint for either half of this and there should not be, a
 * route that hands out a copy of the whole database is a route that hands out every account's
 * data to whoever finds a way to call it.
 *
 *   pnpm --filter @portionium/api backup create
 *   pnpm --filter @portionium/api backup list
 *   pnpm --filter @portionium/api backup restore --from data/backups/portionium-...db.gz
 *
 * `create` is also what the scheduled backup calls, and `restore` is what CI runs on every push
 * against a database it then destroys. So these are not a convenience wrapper over the real
 * thing, they are the real thing, which is what makes the runbook worth following.
 */

const USAGE = `Usage:
  backup create  [--dir <directory>]
  backup list    [--dir <directory>]
  backup restore --from <archive.db.gz> [--to <database file>] [--force]

--dir defaults to BACKUP_DIR, --to defaults to DATABASE_PATH.
restore refuses an existing target unless --force. Stop the application first, always.
The recovery order and the off-machine copy are in docs/runbooks/backup.md.`;

/** Bytes as something a person reads at 3am without counting digits. */
function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

try {
  const command = positionals[0];

  if (values.help === true || command === undefined) {
    console.log(USAGE);
    process.exit(values.help === true ? 0 : 1);
  }

  const config = parseConfig(process.env);
  const policy: RetentionPolicy = {
    daily: config.BACKUP_KEEP_DAILY,
    weekly: config.BACKUP_KEEP_WEEKLY,
    monthly: config.BACKUP_KEEP_MONTHLY,
  };

  if (command === 'restore') {
    const from = values.from;
    if (from === undefined || from.trim() === '') {
      throw new Error(`--from is required.\n\n${USAGE}`);
    }

    const to = values.to ?? config.DATABASE_PATH;
    // Deliberately not through openDatabase first. Opening the target would create and migrate
    // an empty database at that path, which is how a restore turns into a fresh install.
    const result = await restoreBackup(from, to, { force: values.force === true });

    console.log(
      `Restored ${from} to ${result.path}, ${result.migrationsApplied} migration(s) applied, ` +
        'integrity check passed. Start the application.',
    );
  } else {
    // Both remaining commands read the live database, and both need a directory to work in.
    // BACKUP_DIR is empty by default, which is off for the scheduler but cannot be a default
    // for somebody who typed the command on purpose.
    const directory = values.dir ?? config.BACKUP_DIR;
    if (directory === '') {
      throw new Error(`No backup directory. Set BACKUP_DIR or pass --dir.\n\n${USAGE}`);
    }

    if (command === 'list') {
      const backups = listBackups(directory);
      if (backups.length === 0) {
        console.log(`No backups in ${directory}.`);
      } else {
        for (const backup of backups) {
          console.log(`${backup.at.toISOString()}  ${backup.name}`);
        }
        console.log(`${backups.length} backup(s) in ${directory}.`);
      }
    } else if (command === 'create') {
      // Same call the server makes, so this migrates a database that is behind before copying
      // it. Safe while the application is running: VACUUM INTO takes a read transaction.
      const database = openDatabase(config.DATABASE_PATH);

      try {
        const result = await createBackup(database.db, { directory, policy });

        console.log(`Wrote ${result.backup.path}, ${mib(result.sizeBytes)}.`);
        if (result.pruned.length > 0) {
          console.log(`Retention dropped ${result.pruned.length}: ${result.pruned.join(', ')}.`);
        }
      } finally {
        database.close();
      }
    } else {
      throw new Error(`Unknown command "${command}".\n\n${USAGE}`);
    }
  }
} catch (error) {
  // A failed backup that says nothing is a directory of archives somebody trusts. Non zero exit
  // as well as the message, so cron and the CI job both notice rather than logging a success.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
