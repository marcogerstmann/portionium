import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.settings;

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
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await expect(page.getByText('Zora', { exact: true })).toBeVisible();

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
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});

test('a correct password change ends every session and returns to sign in', async ({ page }) => {
  await openSettings(page);

  const newPassword = 'a brand new long enough password';
  await page.getByLabel('Current password').fill(ACCOUNT.password);
  await page.getByLabel('New password').fill(newPassword);
  await page.getByRole('button', { name: 'Change password' }).click();

  await expect(page.getByLabel('Email')).toBeVisible();

  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});
