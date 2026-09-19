import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.budget;

/**
 * The weekly allowance on the Today screen and the editor behind it.
 *
 * In a browser rather than in a unit test because every claim here needs something Vitest does
 * not have: the accessibility tree for the row's sentence, a real day response for the counts,
 * and an actual logging journey to prove that passing a limit changes nothing about it. The
 * arithmetic underneath is src/budget.test.ts.
 */

const API = '/api/v1';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Through the API rather than the composer, whose search surface is not what this file tests. */
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

/** The row, by the one thing that identifies it whatever the numbers say. */
const allowance = (page: Page) => page.getByRole('button', { name: /^This week:/ });

/**
 * Every field below is reached by role rather than by label, because all three tabs stay mounted
 * and only the visible one is in the accessibility tree, see App. The editor has the same fields
 * as the settings section, so a label query would match both and a role query matches the one on
 * screen.
 *
 * Tests in one file share an account and a day, so each one below claims a category nobody else
 * asserts about and only ever changes that one: yellow here, orange for the soft lock, green for
 * the editor. The limits themselves are account wide and accumulate across the file, which is
 * why every assertion names its own colour rather than reading the row as a whole. See ACCOUNTS
 * for why the sharing stops at the file.
 */

/**
 * The default experience, unchanged. First in the file on purpose, while no limit has been set
 * on this account at all: everybody who never opens the editor has to see exactly the screen
 * they saw before any of this existed.
 */
test('shows nothing at all until a limit is set', async ({ page }) => {
  await signIn(page);

  await expect(allowance(page)).toHaveCount(0);
});

test('sets a limit from settings and shows that week position on Today', async ({ page }) => {
  await signIn(page);
  await openSettings(page);

  // The explicit unlimited option, unticked so the number beside it is the limit.
  await page
    .getByRole('group', { name: 'yellow' })
    .getByRole('checkbox', { name: 'No limit' })
    .uncheck();
  await page.getByRole('spinbutton', { name: 'Limit for yellow' }).fill('3');
  await page.getByRole('button', { name: 'Save limits' }).click();

  await openToday(page);
  await logMeal(page, 'yellow');
  await page.reload();

  // Named in words and phrased as a position, which is the channel that does not depend on
  // telling this palette's green from its orange.
  await expect(allowance(page)).toHaveAccessibleName(/1 of 3 yellow/);

  // Eight days back is the previous ISO week whatever weekday today is, and nothing was logged
  // there, so the count is that week's while the limit is the one configured now. This is what
  // makes the row a statement about the day being read rather than about now.
  for (let back = 0; back < 8; back += 1) {
    await page.keyboard.press('ArrowLeft');
  }

  await expect(allowance(page)).toHaveAccessibleName(/0 of 3 yellow/);
});

/**
 * The whole point of the soft lock, and this file's claim on orange. Logging past the allowance
 * has to be the same journey it is under it: no dialog, no second confirmation, no refusal.
 */
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

  // Through the composer rather than the API, because "never prompts a warning dialog" is a
  // claim about the actual logging journey and not about a POST.
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

  // Nothing asked anything on the way through, and the row simply says where the week is.
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(allowance(page)).toHaveAccessibleName(/2 of 1 orange/);
  // Never a verdict, however far past the limit the week is.
  await expect(allowance(page)).not.toHaveAccessibleName(/exceed/i);
});

/** The editor, opened from the row itself, and this file's claim on green. */
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

  // The line that says these are never enforced, which is the copy this screen exists to carry.
  // Filtered to the visible one: the settings section carries the same sentence and is mounted
  // behind this screen, and unlike a role query getByText does not skip what is hidden.
  await expect(page.getByText(/never enforced/i).filter({ visible: true })).toBeVisible();

  await page.getByRole('spinbutton', { name: 'Limit for green' }).fill('9');
  await page.getByRole('button', { name: 'Save limits' }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(allowance(page)).toHaveAccessibleName(/0 of 9 green/);
});

/** Back to unlimited is a choice with its own control, and the count carries on without it. */
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
