import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.today;

/**
 * The Today screen, in a browser, against the real API.
 *
 * Here rather than in a unit test because every claim below needs something Vitest does not
 * have: IndexedDB for the cache, a layout for the touch targets, an accessibility tree for the
 * labels, and a key press for the paging. The pure arithmetic underneath is src/day.test.ts.
 */

const API = '/api/v1';

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/**
 * Put a meal on a day through the API rather than through the screen, because composing one is
 * WEB 4's search surface and this story renders what is already there. `page.request` carries
 * the browser context's session cookie, and the Origin header is what the API's CSRF check
 * wants, see api/src/http/plugins/auth.ts.
 */
async function logMeal(page: Page, meal: { type: string; foodNames: string[] }): Promise<void> {
  const items = [];

  for (const name of meal.foodNames) {
    const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
    const [food] = (await found.json()) as { id: string; name: string }[];
    expect(food, `the seed catalog has ${name}`).toBeDefined();
    items.push({ foodId: food?.id });
  }

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type: meal.type, items },
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

  // Colour alone must not carry the meaning, so every dot is an image with a name. Reading one
  // back is what proves a colour-blind or screen-reader user is told which light this is.
  await expect(meals.getByRole('img', { name: 'green' }).first()).toBeVisible();

  // The name is why the day payload carries its foods, see dayResponseSchema.
  await meals.getByRole('button', { name: /Breakfast/ }).click();
  await expect(page.getByText('Skyr')).toBeVisible();
});

test('pages between days with the arrow keys and stops at today', async ({ page }) => {
  await signIn(page);

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Nothing ahead to have eaten, so the day does not move and the control says so.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next day' })).toBeDisabled();
});

test('pages back through the cached week with no network at all', async ({ page }) => {
  await signIn(page);

  // The window is warmed behind the screen on launch, so this is what is already on the device.
  // Without it, paging back offline would find nothing, see refreshRecentDays.
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

  // Six presses is the far end of the window. Each one has to render from the device, and the
  // seventh must not move: paging never leaves the days that are actually there, see pageTo.
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
  await page.getByRole('button', { name: /Delete this dinner/ }).click();

  await expect(meals.getByRole('button', { name: /Dinner/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(meals.getByRole('button', { name: /Dinner/ })).toBeVisible();

  // The server's soft delete is revived by posting the same id, so the meal genuinely comes back
  // rather than reappearing only on this device. A reload is what tells the two apart.
  await page.reload();
  await expect(meals.getByRole('button', { name: /Dinner/ })).toBeVisible();
});

/*
 * Recording a weight offline is not here, it is the offline spec in compose.spec.ts, where the
 * story that asks for it put it. The claims this file used to make about it, durable and marked
 * offline, unmarked once drained, and the server's copy after a reload, moved with it.
 */

test('gives every tappable row at least a 44 pixel target', async ({ page }) => {
  await signIn(page);
  // A type no other test in this file logs. The specs here share an account and a today, so two
  // of them using one type would have each other's meals in their way; another file's meals
  // cannot be here at all, see ACCOUNTS.
  await logMeal(page, { type: 'snack', foodNames: ['Skyr'] });
  await page.reload();

  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
});
