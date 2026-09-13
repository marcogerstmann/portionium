import { expect, test, type Page } from '@playwright/test';

import { ACCOUNT } from '../playwright.config';

/**
 * The statistics screen, in a browser, against the real API.
 *
 * Here rather than in a unit test for the reasons today.spec.ts gives: IndexedDB for the cache,
 * a layout for the chart, a viewport for the range it picks, and an accessibility tree for the
 * bars. The arithmetic underneath is src/stats.test.ts.
 *
 * This account has weighed exactly once by the time the suite runs, which is the case worth
 * having a spec for: one reading is not a trend, and what the screen must not do is draw a
 * confident line through it. See trendCaveat.
 */

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

  // Nothing here records a weight, on purpose. One reading is all this account ever has, from
  // the offline spec, and one reading is a dot rather than a trend whichever order the specs
  // run in, so both sentences below are the correct answer and a second reading would make the
  // assertion depend on the clock. See WEIGHT_TREND.minEvidence.
  await expect(page.getByText(/Not enough readings|No weight recorded/)).toBeVisible();

  // The dots are still drawn, the line is not: an SVG with a polyline in it would be the
  // misleading picture the criterion is about.
  const chart = page.getByRole('img', { name: /Weight over/ });
  await expect(chart).toBeVisible();
  await expect(chart.locator('polyline')).toHaveCount(0);
});

test('shows the colour distribution over three windows, in a second channel as well', async ({
  page,
}) => {
  await openStatistics(page);

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
