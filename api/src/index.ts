import { maskedConfig, parseConfig } from './config.js';
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
