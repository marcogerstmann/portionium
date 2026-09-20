import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const ORIGIN = `http://localhost:${PORT}`;

const DATABASE_PATH = join(tmpdir(), 'portionium-e2e.db');

const PASSWORD = 'correct horse battery staple';

function fixture(name: string) {
  return { email: `${name}@portionium.test`, displayName: 'Ada', password: PASSWORD };
}

/**
 * One account per spec file. Spec files run in parallel and every meal lands on the same day, so a
 * shared account makes one spec's rows visible to another's locators.
 */
export const ACCOUNTS = {
  smoke: fixture('smoke'),
  today: fixture('today'),
  compose: fixture('compose'),
  statistics: fixture('statistics'),
  settings: fixture('settings'),
  review: fixture('review'),
  correct: fixture('correct'),
  favourites: fixture('favourites'),
  weight: fixture('weight'),
  budget: fixture('budget'),
};

const SERVE_FRESHLY_SEEDED = [
  `rm -f '${DATABASE_PATH}' '${DATABASE_PATH}-wal' '${DATABASE_PATH}-shm'`,
  ...Object.values(ACCOUNTS).map(
    (account) =>
      `printf %s '${account.password}' | pnpm --filter @portionium/api user create` +
      ` --email '${account.email}' --name '${account.displayName}' --timezone Europe/Berlin`,
  ),
  'pnpm --filter @portionium/api exec tsx src/index.ts',
].join(' && ');

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'github' : 'list',
  // Pinned, so an assertion expecting "Breakfast" is not a statement about the runner's locale.
  use: { baseURL: ORIGIN, trace: 'retain-on-failure', locale: 'en-US' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],

  webServer: {
    command: SERVE_FRESHLY_SEEDED,
    url: `${ORIGIN}/health`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      DATABASE_PATH,
      PORT: String(PORT),
      WEB_ROOT: join(import.meta.dirname, 'dist'),
      WEB_ORIGIN: ORIGIN,
      BACKUP_DIR: '',
      LOG_LEVEL: 'warn',
      // Every browser in the run shares one address, which looks exactly like one client flooding
      // the instance. Raised rather than switched off, so the hooks still run on every request.
      RATE_LIMIT_READ_PER_MINUTE: '2000',
      RATE_LIMIT_WRITE_PER_MINUTE: '500',
      RATE_LIMIT_AUTH_PER_MINUTE: '200',
    },
  },
});
