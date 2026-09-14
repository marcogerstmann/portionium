import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.favourites;

/**
 * POR-73: favourites and suggestions in the composer, in a browser, against the real API.
 *
 * The API half, GET /meals/favourites, GET /meals/suggestions and the create and delete routes
 * either side of them, is api/test/http/meals.test.ts. What is worth a browser here is what
 * cannot be asserted against the API alone: that picking either fills the composer rather than
 * logging anything, that a favourite survives a reload with no network, and that the search
 * field itself never moves for either list, see the acceptance criteria on the story.
 */

const API = '/api/v1';

/** A seed food, early enough in the alphabet to certainly be on the device once offline. */
const FAVOURITE_FOOD = 'Aubergine';
const SUGGESTION_FOOD = 'Blumenkohl';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Type a name, take the first result, and leave the field ready for the next one. */
async function addFood(page: Page, name: string) {
  await page.getByLabel('Add a food').fill(name);

  const first = page.getByRole('option').first();
  await expect(first).toHaveText(new RegExp(`^.?${name}$`));

  await first.click();
  await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
}

test('a pinned favourite is listed, fills the composer when picked, and can be removed', async ({
  page,
}) => {
  const name = `Standard ${Date.now()}`;

  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();
  await addFood(page, FAVOURITE_FOOD);

  await page.getByRole('button', { name: 'Save as a favourite' }).click();
  await page.getByLabel('Favourite name').fill(name);
  await page.getByRole('button', { name: 'Save as a favourite' }).click();

  // Pinning did not log anything: still on the composer, with nothing sent to the day.
  await expect(page.getByRole('heading', { name: 'Add a meal' })).toBeVisible();

  const pinned = await page.request.get(`${API}/meals/favourites`);
  const { items } = (await pinned.json()) as { items: { id: string; name: string }[] };

  expect(items.map((favourite) => favourite.name)).toContain(name);

  // Abandon this one without logging, and open a fresh composer to pick the favourite from
  // scratch rather than from a screen that already holds its entries.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add a meal' }).click();

  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText(FAVOURITE_FOOD)).toBeVisible();

  // Anchored so this cannot also match the "Remove {name} from favourites" button beside it,
  // whose accessible name contains the same favourite name further in.
  await row.getByRole('button', { name: new RegExp(`^${name}`) }).click();

  // Filled, not logged: the entry is in the meal being composed (scoped to that list, since the
  // favourites row picked from names the same food, and the first match rather than the second
  // because each row's own Remove button repeats the name in a screen reader only span) and the
  // field is ready again, not a screen that has already returned to Today.
  await expect(
    page.getByRole('list', { name: 'In this meal' }).getByText(FAVOURITE_FOOD).first(),
  ).toBeVisible();
  await expect(page.getByLabel('Add a food')).toBeFocused();

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add a meal' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();

  await page.getByRole('button', { name: `Remove ${name} from favourites` }).click();
  await expect(page.getByRole('listitem').filter({ hasText: name })).toHaveCount(0);

  const remaining = await page.request.get(`${API}/meals/favourites`);
  const { items: after } = (await remaining.json()) as { items: { name: string }[] };

  expect(after.map((favourite) => favourite.name)).not.toContain(name);
});

test('suggests the pre-selected meal type once something has been logged for it', async ({
  page,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByRole('button', { name: 'Dinner', exact: true }).click();
  await addFood(page, SUGGESTION_FOOD);
  await page.getByRole('button', { name: /^Log Dinner/ }).click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByRole('button', { name: 'Dinner', exact: true }).click();

  const suggestion = page.getByRole('listitem').filter({ hasText: SUGGESTION_FOOD });
  await expect(suggestion).toBeVisible();

  // Beside the most eaten foods it already shows, not over the field: the field this screen is
  // built around is still the first thing under the thumb.
  const field = page.getByLabel('Add a food');
  await expect(field).toBeVisible();
  const fieldTop = (await field.boundingBox())?.y ?? Infinity;
  const suggestionTop = (await suggestion.boundingBox())?.y ?? -Infinity;

  expect(suggestionTop).toBeGreaterThan(fieldTop);

  await suggestion.click();
  await expect(
    page.getByRole('list', { name: 'In this meal' }).getByText(SUGGESTION_FOOD).first(),
  ).toBeVisible();
  await expect(field).toBeFocused();
});

test('favourites survive a reload with no network, the same as the food cache', async ({
  page,
}) => {
  const name = `Offline ${Date.now()}`;

  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();
  await addFood(page, FAVOURITE_FOOD);
  await page.getByRole('button', { name: 'Save as a favourite' }).click();
  await page.getByLabel('Favourite name').fill(name);
  await page.getByRole('button', { name: 'Save as a favourite' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Reloaded first, still online, so the device holds the server's own answer rather than only
  // the optimistic one `pin` above already put in state.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();
});
