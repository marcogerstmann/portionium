import { maskedConfig, parseConfig } from './config.js';
import { createBackupIfDue } from './db/backup.js';
import { openDatabase } from './db/client.js';
import { seedFoodCatalog } from './db/seed.js';
import { buildApp } from './http/app.js';

/**
 * The process entry point, and the only place that owns a lifecycle: it opens the database,
 * builds the app, listens, and shuts both down again. Everything it calls is a function that
 * a test can call without a process.
 */

try {
  const config = parseConfig(process.env);
  // Applies any pending migrations before anything else can touch the database.
  const database = openDatabase(config.DATABASE_PATH);
  const app = await buildApp({ config, database });

  // The first line in the log, because the commonest deployment problem is a variable that is
  // not what somebody thought it was, and a default that quietly applied leaves no trace in the
  // environment it came from. Secrets are masked by the shape of their name, see maskedConfig.
  app.log.info({ config: maskedConfig(config) }, 'configuration resolved');

  // Said out loud rather than left to be inferred from the masked line above, which shows every
  // credential as [redacted] whether or not there is one behind it. An instance without a key
  // is a working instance: the seeded catalog answers almost everything, and a food nobody
  // recognises is one somebody classifies themselves. Saying so is what stops that reading as a
  // broken deployment to whoever finds an unclassified food a fortnight later.
  app.log.info(
    config.AI_API_KEY === ''
      ? 'no AI_API_KEY set, classification of unknown foods is off and the catalog answers alone'
      : 'AI_API_KEY set, unknown foods will be classified by the model',
  );

  // A thrown exception nobody caught, or a rejected promise nobody handled, leaves this process
  // in a state none of the code here can reason about: a request may be half served, a
  // transaction half open. So it is logged at fatal and the process ends, which lets the
  // orchestrator restart a healthy one. Draining first is deliberately not attempted, because a
  // graceful shutdown in an unknown state is how a container hangs instead of restarting.
  //
  // Registering these replaces Node's own behaviour rather than adding to it: without them an
  // unhandled rejection terminates the process with a stack trace on stderr and nothing in the
  // log, which is the line somebody needs at 09:00 the next morning. Pino's default destination
  // writes synchronously, so the line is on its way out before exit.
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(event, (cause: unknown) => {
      app.log.fatal({ err: cause, event }, 'terminating on an unhandled failure');
      process.exit(1);
    });
  }

  // Same reasoning as running migrations here: one process, one file, and the loader only
  // writes what is missing, so a restart after adding entries to the catalog is the whole
  // deployment step. Before listen, so nothing is served against a half seeded catalog.
  const seeded = seedFoodCatalog(database.db);
  app.log.info(
    `seeded ${seeded.foodsInserted} foods, ${seeded.classificationsInserted} classifications`,
  );

  // The scheduled backup, when this deployment was given somewhere to put one. Here rather than
  // in a plugin because it is a lifecycle concern and not a request concern: nothing about it
  // belongs to the HTTP surface, and a test that builds an app should not start writing files.
  //
  // Off when BACKUP_DIR is empty, said out loud for the same reason the AI key is: an instance
  // with no backups is a decision somebody should be able to see in the log rather than discover
  // after a bad migration. See db/backup.ts for what a backup is and why it is not a file copy.
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
        // Loud, and at error rather than warn, because the failure mode this module exists to
        // prevent is a directory of archives nobody checked. The process keeps serving: refusing
        // to run a food diary because a backup failed would be the worse of the two outcomes.
        app.log.error({ err: error, directory: config.BACKUP_DIR }, 'backup failed');
      }
    };

    // Once now, then on a timer, and the due check in createBackupIfDue is what makes those two
    // compose: a restart does not take a second backup and a crash loop does not take a hundred.
    await backup();

    // The interval is the retry as well as the schedule, so it ticks more often than a backup is
    // due. An hour means a failure gets another go this afternoon instead of tomorrow.
    const schedule = setInterval(() => void backup(), 60 * 60 * 1000);
    // unref'd and cleared on close, the same two reasons as the idempotency purge: a process
    // that is otherwise done should exit, and a shutdown should not wait for a timer.
    schedule.unref();
    app.addHook('onClose', () => {
      clearInterval(schedule);
    });
  }

  // 0.0.0.0 rather than localhost, because the usual deployment is a container and a server
  // bound to the loopback interface inside one is unreachable from outside it.
  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  // SIGTERM is what an orchestrator sends before it gives up and sends SIGKILL, SIGINT is
  // Ctrl-C. `once`, so a second signal during a slow drain falls through to Node's default
  // and kills the process rather than starting a second shutdown.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      // Stops the listener, drains the requests in flight, then runs the onClose hook that
      // releases the database file along with its -wal and -shm sidecars.
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
