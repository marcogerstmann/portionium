import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.settings;

/**
 * The settings screen, in a browser, against the real API. See POR-67.
 *
 * Two things here need a browser rather than a unit test: whether a rejected write reaches only
 * the field it belongs to, and what actually happens to the session after a password change,
 * both of which are exactly the two ways this screen is easy to get subtly wrong.
 */

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function openSettings(page: Page) {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

test('shows the account and saves a changed display name on its own', async ({ page }) => {
  await openSettings(page);

  await expect(page.getByText(ACCOUNT.email)).toBeVisible();

  await page.getByLabel('Display name').fill('Zora');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Zora', { exact: true })).toBeVisible();

  // Written through, not only held on screen: a reload has nothing else to fall back to. The
  // app always opens on Today, so getting back here is the same navigation as the first time.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByText('Zora', { exact: true })).toBeVisible();
});

test('a wrong current password is a field error, never a sign out', async ({ page }) => {
  await openSettings(page);

  await page.getByLabel('Current password').fill('definitely the wrong password');
  await page.getByLabel('New password').fill('a different long enough password');
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByText('The current password is incorrect.')).toBeVisible();
  // Still here, not thrown back to the login screen a 401 would have caused, see ./api.ts.
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('a correct password change ends every session and returns to sign in', async ({ page }) => {
  await openSettings(page);

  const newPassword = 'a brand new long enough password';
  await page.getByLabel('Current password').fill(ACCOUNT.password);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByLabel('Email')).toBeVisible();

  // The new credential is the one that works now, which is the claim being tested.
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});
