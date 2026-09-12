import { expect, test } from '@playwright/test';

import { ACCOUNT } from '../playwright.config';

/**
 * The whole of the client that exists today: it loads, it signs in, and what is behind the gate
 * renders for an account that has logged nothing.
 *
 * Thin on purpose. This is the harness proving itself, and a smoke test that asserts a lot is a
 * test that fails for a dozen reasons that are not the one it is named after.
 */
test('loads, signs in, and shows an empty Today', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'portionium' })).toBeVisible();

  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
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
