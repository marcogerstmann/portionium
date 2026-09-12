import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

/**
 * The browser tests, against the application as it is actually deployed: one API process
 * serving the built client on its own origin, with a database that did not exist a moment ago.
 *
 * One origin rather than the Vite dev server with a proxy in front, because the two things
 * worth testing end to end here are exactly the two that a second origin changes. The session
 * cookie is `SameSite=Lax` and every write is checked against `WEB_ORIGIN`, so a harness that
 * quietly ran on two origins would either fail for reasons that have nothing to do with the app
 * or pass with those checks switched off.
 *
 * The harness is the deliverable as much as the test is. WEB 2 adds the offline test into it
 * without setting any of this up again.
 */

const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;

/** Thrown away and remade on every run, so a test never sees what the last one left behind. */
const DATABASE_PATH = join(tmpdir(), 'portionium-e2e.db');

/**
 * The account the run creates for itself. Not a credential: it exists for the lifetime of a
 * database in a temporary directory, on an instance listening on localhost, and the next run
 * deletes both. It is written down here rather than generated so that the spec and the command
 * that seeds it cannot disagree about what it is.
 */
export const ACCOUNT = {
  email: 'e2e@portionium.test',
  displayName: 'Ada',
  password: 'correct horse battery staple',
};

/**
 * Delete the database, create the account, start the server, in that order and in one shell, so
 * there is no question of which ran first. `user create` opens the database the same way the
 * server does, which is what applies the migrations and loads the seed catalog before the first
 * request arrives. The password is piped rather than passed as an argument, because an argument
 * is in the process list of everybody on the machine, see api/src/cli/prompt.ts.
 */
const SERVE_FRESHLY_SEEDED = [
  `rm -f '${DATABASE_PATH}' '${DATABASE_PATH}-wal' '${DATABASE_PATH}-shm'`,
  `printf %s '${ACCOUNT.password}' | pnpm --filter @portionium/api user create` +
    ` --email '${ACCOUNT.email}' --name '${ACCOUNT.displayName}' --timezone Europe/Berlin`,
  'pnpm --filter @portionium/api exec tsx src/index.ts',
].join(' && ');

export default defineConfig({
  testDir: './e2e',
  // A `.only` somebody left in is a suite that silently stopped covering anything.
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: ORIGIN, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],

  webServer: {
    command: SERVE_FRESHLY_SEEDED,
    // The liveness probe, which answers as soon as the migrations and the seed have run and the
    // listener is open. Nothing to poll for after that.
    url: `${ORIGIN}/health`,
    // Never a server somebody left running: this one is pointed at a database the tests own.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_PATH,
      PORT: String(PORT),
      // The built client. Absolute, because the API takes it as given and the command above
      // runs in a different directory than this file lives in. `e2e` builds it first.
      WEB_ROOT: join(import.meta.dirname, 'dist'),
      // What the CSRF check compares the Origin header against, and what decides the session
      // cookie is not marked Secure. Both have to be this, or signing in cannot work on http.
      WEB_ORIGIN: ORIGIN,
      // Off, so the run writes nothing outside the temporary database.
      BACKUP_DIR: '',
      LOG_LEVEL: 'warn',
    },
  },
});
