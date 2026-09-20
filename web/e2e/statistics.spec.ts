import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.statistics;

const API = '/api/v1';

async function logMeal(page: Page, foodName: string): Promise<void> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(foodName)}`);
  const [food] = (await found.json()) as { id: string; name: string }[];

  expect(food?.name, `the seed catalog has exactly one ${foodName}`).toBe(foodName);

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type: 'lunch', entries: [{ foodId: food?.id }] },
  });

  expect(response.status()).toBe(201);
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function openStatistics(page: Page) {
  await signIn(page);
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Statistics' })
    .click();
  await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
}

test('is one tap from the day and one tap back, and marks the active tab', async ({ page }) => {
  const tabBar = page.getByRole('navigation', { name: 'Destinations' });

  await openStatistics(page);
  await expect(tabBar.getByRole('button', { name: 'Statistics' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await tabBar.getByRole('button', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(tabBar.getByRole('button', { name: 'Today' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('says there is not enough behind the trend rather than drawing a line', async ({ page }) => {
  await openStatistics(page);

  await expect(page.getByText(/No weight recorded|Not enough readings/)).toBeVisible();

  const chart = page.getByRole('img', { name: /Weight over/ });
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline')).toHaveCount(0);
});

test('shows the colour distribution over three windows, in a second channel as well', async ({
  page,
}) => {
  await signIn(page);
  await logMeal(page, 'Skyr');
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Statistics' })
    .click();

  const colours = page.getByRole('region', { name: 'Colours' });

  for (const window of [7, 30, 90]) {
    await expect(colours.getByText(`Last ${window} days`)).toBeVisible();
  }

  await expect
    .poll(async () => colours.getByRole('img', { name: /\d+ green/ }).count())
    .toBeGreaterThan(0);
});

test('lists the weeks and opens from the device on a second visit', async ({ page }) => {
  await openStatistics(page);
  await expect(page.getByRole('region', { name: 'Weeks' }).getByText(/\d/).first()).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Today' })
    .click();
  await page.context().setOffline(true);
  await page
    .getByRole('navigation', { name: 'Destinations' })
    .getByRole('button', { name: 'Statistics' })
    .click();

  await expect(page.getByRole('region', { name: 'Weeks' }).getByText(/\d/).first()).toBeVisible();
  await page.context().setOffline(false);
});

test('asks for a longer range at desktop width than at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openStatistics(page);

  const narrow = await page
    .getByRole('img', { name: /Weight over (\d+) days/ })
    .getAttribute('aria-label');

  await page.setViewportSize({ width: 1280, height: 900 });

  await expect
    .poll(async () =>
      Number(
        /Weight over (\d+) days/.exec(
          (await page.getByRole('img', { name: /Weight over/ }).getAttribute('aria-label')) ?? '',
        )?.[1],
      ),
    )
    .toBeGreaterThan(Number(/Weight over (\d+) days/.exec(narrow ?? '')?.[1]));
});
