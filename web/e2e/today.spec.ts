import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.today;

const API = '/api/v1';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function logMeal(page: Page, meal: { type: string; foodNames: string[] }): Promise<void> {
  const entries = [];

  for (const name of meal.foodNames) {
    const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
    const [food] = (await found.json()) as { id: string; name: string }[];
    expect(food, `the seed catalog has ${name}`).toBeDefined();
    entries.push({ foodId: food?.id });
  }

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type: meal.type, entries },
  });

  expect(response.status()).toBe(201);
}

test('shows the day grouped by meal, with a name and a colour per item', async ({ page }) => {
  await signIn(page);
  await logMeal(page, { type: 'breakfast', foodNames: ['Skyr'] });
  await logMeal(page, { type: 'lunch', foodNames: ['Banane'] });
  await page.reload();

  const meals = page.getByRole('region', { name: 'Meals' });
  await expect(meals.getByRole('button', { name: /Breakfast/ })).toBeVisible();
  await expect(meals.getByRole('button', { name: /Lunch/ })).toBeVisible();

  await expect(meals.getByRole('img', { name: 'green' }).first()).toBeVisible();

  await meals.getByRole('button', { name: /Breakfast/ }).click();
  await expect(page.getByText('Skyr')).toBeVisible();
});

test('pages between days with the arrow keys and stops at today', async ({ page }) => {
  await signIn(page);

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next day' })).toBeDisabled();
});

test('jumps back to today in one tap, gone once already there', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: 'Back to today' })).not.toBeVisible();

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Today' })).not.toBeVisible();

  const backToToday = page.getByRole('button', { name: 'Back to today' });
  await expect(backToToday).toBeVisible();
  await backToToday.click();

  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(backToToday).not.toBeVisible();
});

test('pages back through the cached week with no network at all', async ({ page }) => {
  await signIn(page);

  await expect
    .poll(async () =>
      page.evaluate(
        async () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open('portionium');
            open.onsuccess = () => {
              const count = open.result.transaction('days').objectStore('days').count();
              count.onsuccess = () => resolve(count.result);
            };
          }),
      ),
    )
    .toBe(7);

  await page.context().setOffline(true);

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  for (let back = 2; back < 7; back += 1) {
    await page.keyboard.press('ArrowLeft');
  }

  const earliest = await page.getByRole('heading').first().textContent();

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading').first()).toHaveText(earliest ?? '');
  await expect(page.getByRole('button', { name: 'Previous day' })).toBeDisabled();
});

test('deletes a meal and puts it back with undo', async ({ page }) => {
  await signIn(page);
  await logMeal(page, { type: 'dinner', foodNames: ['Skyr'] });
  await page.reload();

  const meals = page.getByRole('region', { name: 'Meals' });
  await meals.getByRole('button', { name: /Dinner/ }).click();
  await page.getByRole('button', { name: /Delete this Dinner/ }).click();
  await page.getByRole('button', { name: 'Yes, delete' }).click();

  await expect(meals.getByRole('button', { name: /Dinner/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(meals.getByRole('button', { name: /Dinner/ })).toBeVisible();

  await page.reload();
  await expect(meals.getByRole('button', { name: /Dinner/ })).toBeVisible();
});

test('gives every tappable row at least a 44 pixel target', async ({ page }) => {
  await signIn(page);
  await logMeal(page, { type: 'snack', foodNames: ['Skyr'] });
  await page.reload();

  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
