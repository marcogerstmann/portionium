import { parseArgs } from 'node:util';

import { parseConfig } from '../config.js';
import { createBackup, listBackups, restoreBackup, type RetentionPolicy } from '../db/backup.js';
import { openDatabase } from '../db/client.js';

const USAGE = `Usage:
  backup create  [--dir <directory>]
  backup list    [--dir <directory>]
  backup restore --from <archive.db.gz> [--to <database file>] [--force]

--dir defaults to BACKUP_DIR, --to defaults to DATABASE_PATH.
restore refuses an existing target unless --force. Stop the application first, always.
The recovery order and the off-machine copy are in docs/runbooks/backup.md.`;

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
    const result = await restoreBackup(from, to, { force: values.force === true });

    console.log(
      `Restored ${from} to ${result.path}, ${result.migrationsApplied} migration(s) applied, ` +
        'integrity check passed. Start the application.',
    );
  } else {
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
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
