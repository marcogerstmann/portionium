import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.budget;

const API = '/api/v1';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function logMeal(page: Page, category: string): Promise<void> {
  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type: 'snack', entries: [{ category }] },
  });

  expect(response.status()).toBe(201);
}

async function openSettings(page: Page) {
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
}

async function openToday(page: Page) {
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Today' })
    .click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

const allowance = (page: Page) => page.getByRole('button', { name: /^This week:/ });

test('shows nothing at all until a limit is set', async ({ page }) => {
  await signIn(page);

  await expect(allowance(page)).toHaveCount(0);
});

test('sets a limit from settings and shows that week position on Today', async ({ page }) => {
  await signIn(page);
  await openSettings(page);

  await page
    .getByRole('group', { name: 'yellow' })
    .getByRole('checkbox', { name: 'No limit' })
    .uncheck();
  await page.getByRole('spinbutton', { name: 'Limit for yellow' }).fill('3');
  await page.getByRole('button', { name: 'Save limits' }).click();

  await openToday(page);
  await logMeal(page, 'yellow');
  await page.reload();

  await expect(allowance(page)).toHaveAccessibleName(/1 of 3 yellow/);
});

test('keeps logging past the limit, with no warning and no extra step', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page
    .getByRole('group', { name: 'orange' })
    .getByRole('checkbox', { name: 'No limit' })
    .uncheck();
  await page.getByRole('spinbutton', { name: 'Limit for orange' }).fill('1');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await openToday(page);

  for (let logged = 0; logged < 2; logged += 1) {
    await page.getByRole('button', { name: 'Add a meal' }).click();
    await expect(page.getByRole('heading', { name: 'Add a meal' })).toBeVisible();
    await page
      .getByRole('group', { name: 'Or just a colour' })
      .getByRole('button', { name: 'orange' })
      .click();
    await page.getByRole('button', { name: /^Log / }).click();
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  }

  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(allowance(page)).toHaveAccessibleName(/2 of 1 orange/);
  await expect(allowance(page)).not.toHaveAccessibleName(/exceed/i);
});

test('opens the editor from the row and saves a changed limit', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page
    .getByRole('group', { name: 'green' })
    .getByRole('checkbox', { name: 'No limit' })
    .uncheck();
  await page.getByRole('spinbutton', { name: 'Limit for green' }).fill('5');
  await page.getByRole('button', { name: 'Save limits' }).click();
  await openToday(page);

  await expect(allowance(page)).toHaveAccessibleName(/0 of 5 green/);
  await allowance(page).click();
  await expect(page.getByRole('heading', { name: 'Weekly limits' })).toBeVisible();

  await expect(page.getByText(/never enforced/i).filter({ visible: true })).toBeVisible();

  await page.getByRole('spinbutton', { name: 'Limit for green' }).fill('9');
  await page.getByRole('button', { name: 'Save limits' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(allowance(page)).toHaveAccessibleName(/0 of 9 green/);
});

test('takes a category back to no limit and shows its bare count', async ({ page }) => {
  await signIn(page);
  await openSettings(page);
  await page
    .getByRole('group', { name: 'green' })
    .getByRole('checkbox', { name: 'No limit' })
    .check();
  await page.getByRole('button', { name: 'Save limits' }).click();
  await openToday(page);

  await expect(allowance(page)).toHaveAccessibleName(/0 green,/);
  await expect(allowance(page)).not.toHaveAccessibleName(/of 9 green/);
});
