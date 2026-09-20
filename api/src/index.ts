import { maskedConfig, parseConfig } from './config.js';
import { createBackupIfDue } from './db/backup.js';
import { openDatabase } from './db/client.js';
import { seedFoodCatalog } from './db/seed.js';
import { buildApp } from './http/app.js';

try {
  const config = parseConfig(process.env);
  const database = openDatabase(config.DATABASE_PATH);
  const app = await buildApp({ config, database });

  app.log.info({ config: maskedConfig(config) }, 'configuration resolved');

  app.log.info(
    config.OPENAI_API_KEY === ''
      ? 'no OPENAI_API_KEY set, the classifier answers unavailable and the catalog answers alone'
      : `OPENAI_API_KEY set, unknown foods will be classified by ${config.OPENAI_MODEL}`,
  );

  // Replaces Node's own handling rather than adding to it: without these, an unhandled rejection
  // ends the process with a stack on stderr and nothing in the log. No drain, because a graceful
  // shutdown in an unknown state is how a container hangs instead of restarting.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (cause: unknown) => {
      app.log.fatal({ err: cause, event }, 'terminating on an unhandled failure');
      process.exit(1);
    });
  }

  const seeded = seedFoodCatalog(database.db);
  app.log.info(
    `seeded ${seeded.foodsInserted} foods, ${seeded.classificationsInserted} classifications`,
  );

  if (config.BACKUP_DIR === '') {
    app.log.warn('no BACKUP_DIR set, no backups will be taken');
  } else {
    const backupOptions = {
      directory: config.BACKUP_DIR,
      intervalMs: config.BACKUP_INTERVAL_HOURS * 60 * 60 * 1000,
      policy: {
        daily: config.BACKUP_KEEP_DAILY,
        weekly: config.BACKUP_KEEP_WEEKLY,
        monthly: config.BACKUP_KEEP_MONTHLY,
      },
    };

    const backup = async () => {
      try {
        const result = await createBackupIfDue(database.db, backupOptions);
        if (result !== undefined) {
          app.log.info(
            { path: result.backup.path, sizeBytes: result.sizeBytes, pruned: result.pruned },
            'backup written',
          );
        }
      } catch (error) {
        app.log.error({ err: error, directory: config.BACKUP_DIR }, 'backup failed');
      }
    };

    await backup();

    const schedule = setInterval(() => void backup(), 60 * 60 * 1000);
    schedule.unref();
    app.addHook('onClose', () => {
      clearInterval(schedule);
    });
  }

  // 0.0.0.0 rather than loopback: a container bound to loopback is unreachable from outside it.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // `once`, so a second signal during a slow drain kills the process rather than restarting it.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(
        () => process.exit(0),
        (error: unknown) => {
          app.log.error(error);
          process.exit(1);
        },
      );
    });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
