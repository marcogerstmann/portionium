import { expect, test } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.smoke;

test('loads, signs in, and renders a day with nothing on it', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Portionium' })).toBeVisible();

  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
  await expect(page.getByText('Nothing logged yet.')).toBeVisible();
});

test('registers a service worker that precaches the shell', async ({ page }) => {
  await page.goto('/');

  const precached = await page.evaluate(async () => {
    await navigator.serviceWorker.ready;

    const name = (await caches.keys()).find((key) => key.includes('precache'));
    const cache = await caches.open(name ?? '');

    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });

  expect(precached).toContain('/index.html');
  expect(precached).toContain('/manifest.webmanifest');
});
