import { expect, test } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.smoke;

/**
 * The whole of the client: it loads, it signs in, and what is behind the gate renders.
 *
 * Thin on purpose. This is the harness proving itself, and a smoke test that asserts a lot is a
 * test that fails for a dozen reasons that are not the one it is named after.
 *
 * The empty day it checks is yesterday rather than today. This file has an account to itself so
 * today would be empty too, but yesterday is the honest target: it is empty because nothing has
 * been logged into it rather than because nothing has run yet, and the claim is the same either
 * way. A day with nothing on it renders as an empty day rather than as a spinner, which is what
 * the cache in src/db.ts exists for.
 */
test('loads, signs in, and renders a day with nothing on it', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'portionium' })).toBeVisible();

  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
  await expect(page.getByText('Nothing logged yet.')).toBeVisible();
});

/**
 * The half of "installable" that is not a file on disk. The manifest can be checked by reading
 * it; whether the service worker actually registers and precaches the shell cannot, and a
 * browser that refuses it says so only in its own console. Chromium is the engine whose install
 * criteria this has to satisfy, so this asserts it in the engine rather than trusting the build
 * log that says a worker was generated.
 */
test('registers a service worker that precaches the shell', async ({ page }) => {
  await page.goto('/');

  const precached = await page.evaluate(async () => {
    // Resolves once a worker is active for this page, so there is nothing to poll for.
    await navigator.serviceWorker.ready;

    const name = (await caches.keys()).find((key) => key.includes('precache'));
    const cache = await caches.open(name ?? '');

    // Workbox files an entry under the URL plus a revision parameter. The path is the part that
    // says which file it is.
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });

  expect(precached).toContain('/index.html');
  expect(precached).toContain('/manifest.webmanifest');
});
