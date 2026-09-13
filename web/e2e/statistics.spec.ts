import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.statistics;

/**
 * The statistics screen, in a browser, against the real API.
 *
 * Here rather than in a unit test for the reasons today.spec.ts gives: IndexedDB for the cache,
 * a layout for the chart, a viewport for the range it picks, and an accessibility tree for the
 * bars. The arithmetic underneath is src/stats.test.ts.
 *
 * This file has an account to itself, so what is on this screen is exactly what these tests put
 * there and nothing another spec logged, see ACCOUNTS. That is what makes the first claim below
 * assertable at all: a fresh account has weighed nothing, one reading is not a trend either, and
 * in both cases the screen must say so rather than draw a confident line. See trendCaveat.
 */

const API = '/api/v1';

/**
 * Put a meal on today through the API rather than through the screen, the same way today.spec.ts
 * does and for the same reason: composing one is the composer's surface, and this screen renders
 * what is already there. `page.request` carries the browser context's session cookie, and the
 * Origin header is what the API's CSRF check wants.
 */
async function logMeal(page: Page, foodName: string): Promise<void> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(foodName)}`);
  const [food] = (await found.json()) as { id: string; name: string }[];

  expect(food?.name, `the seed catalog has exactly one ${foodName}`).toBe(foodName);

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type: 'lunch', items: [{ foodId: food?.id }] },
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
  await page.getByRole('button', { name: 'Statistics' }).click();
  await expect(page.getByRole('heading', { name: 'Statistics' })).toBeVisible();
}

test('is one tap from the day and one tap back', async ({ page }) => {
  await openStatistics(page);

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
});

test('says there is not enough behind the trend rather than drawing a line', async ({ page }) => {
  await openStatistics(page);

  // Nothing in this file records a weight, on purpose: the account has none, which is the state
  // every account starts in and the one the screen has to be honest about. A single reading
  // would be the same answer for a different reason, so the sentence is matched either way.
  // See WEIGHT_TREND.minEvidence.
  await expect(page.getByText(/No weight recorded|Not enough readings/)).toBeVisible();

  // The dots are still drawn, the line is not: an SVG with a polyline in it would be the
  // misleading picture the criterion is about.
  const chart = page.getByRole('img', { name: /Weight over/ });
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline')).toHaveCount(0);
});

test('shows the colour distribution over three windows, in a second channel as well', async ({
  page,
}) => {
  await signIn(page);
  // Something to distribute. A bar with nothing in it says so instead of drawing a colour, which
  // is the right answer for an empty account and not the one this test is about.
  await logMeal(page, 'Skyr');
  await page.getByRole('button', { name: 'Statistics' }).click();

  const colours = page.getByRole('region', { name: 'Colours' });

  for (const window of [7, 30, 90]) {
    await expect(colours.getByText(`Last ${window} days`)).toBeVisible();
  }

  // Every bar names its counts, so the distribution survives a reader who cannot tell this
  // palette's green from its orange, and one who is not looking at it at all.
  await expect
    .poll(async () => colours.getByRole('img', { name: /\d+ green/ }).count())
    .toBeGreaterThan(0);
});

test('lists the weeks and opens from the device on a second visit', async ({ page }) => {
  await openStatistics(page);
  await expect(page.getByRole('region', { name: 'Weeks' }).getByText(/\d/).first()).toBeVisible();

  // The second visit is the claim: the last answer is on the device, so the screen opens on
  // numbers with no network rather than on nothing while it asks again. See cachedStats.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Statistics' }).click();

  await expect(page.getByRole('region', { name: 'Weeks' }).getByText(/\d/).first()).toBeVisible();
  await page.context().setOffline(false);
});

test('asks for a longer range at desktop width than at phone width', async ({ page }) => {
  // The extra room buys days rather than a second arrangement, which is a decision made in
  // TypeScript because it decides what is requested, not only what is drawn. See CHART_DAYS.
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
