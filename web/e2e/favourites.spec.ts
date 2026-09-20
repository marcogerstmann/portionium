import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.favourites;

const API = '/api/v1';

const FAVOURITE_FOOD = 'Aubergine';
const SUGGESTION_FOOD = 'Blumenkohl';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

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

  await expect(page.getByRole('heading', { name: 'Add a meal' })).toBeVisible();

  const pinned = await page.request.get(`${API}/meals/favourites`);
  const { items } = (await pinned.json()) as { items: { id: string; name: string }[] };

  expect(items.map((favourite) => favourite.name)).toContain(name);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Add a meal' }).click();

  const row = page.getByRole('listitem').filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row.getByText(FAVOURITE_FOOD)).toBeVisible();

  await row.getByRole('button', { name: new RegExp(`^${name}`) }).click();

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

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  await expect(page.getByRole('listitem').filter({ hasText: name })).toBeVisible();
});
