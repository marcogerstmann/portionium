import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.correct;

const API = '/api/v1';

const REPEAT_FOOD = 'Skyr';
const EDIT_FOOD = 'Banane';
const RECOLOUR_FOOD = 'Apfel';
const EMPTY_FOOD = 'Gurke';

interface LoggedMeal {
  id: string;
  type: string;
  notes?: string;
  entries: { foodId: string | null; category: string | null }[];
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function food(page: Page, name: string): Promise<{ id: string; category: string | null }> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
  const [first] = (await found.json()) as { id: string; name: string; category: string | null }[];

  expect(first?.name, `the seed catalog has exactly one ${name}`).toBe(name);

  return { id: first?.id ?? '', category: first?.category ?? null };
}

async function logMeal(page: Page, type: string, name: string, loggedAt?: string): Promise<void> {
  const { id } = await food(page, name);

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type, entries: [{ foodId: id }], ...(loggedAt === undefined ? {} : { loggedAt }) },
  });

  expect(response.status()).toBe(201);
}

function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
}

async function mealsOf(page: Page, name: string): Promise<LoggedMeal[]> {
  const { id } = await food(page, name);
  const response = await page.request.get(`${API}/meals?limit=100`);
  const { items } = (await response.json()) as { items: LoggedMeal[] };

  return items.filter((meal) => meal.entries.some((entry) => entry.foodId === id));
}

function openMeal(page: Page, type: string) {
  return page
    .getByRole('region', { name: 'Meals' })
    .getByRole('button', { name: new RegExp(type) })
    .click();
}

test('logs a meal again from the day it is being read on', async ({ page }) => {
  await signIn(page);
  await logMeal(page, 'breakfast', REPEAT_FOOD);
  await page.reload();

  await openMeal(page, 'Breakfast');
  await page.getByRole('button', { name: 'Log again' }).click();

  const meals = page.getByRole('region', { name: 'Meals' });
  await expect(meals.getByRole('button', { name: /Breakfast/ })).toHaveCount(2);

  await expect.poll(async () => (await mealsOf(page, REPEAT_FOOD)).length).toBe(2);

  const [repeat] = await mealsOf(page, REPEAT_FOOD);
  expect(repeat?.entries).toHaveLength(1);

  await page.reload();
  await expect(meals.getByRole('button', { name: /Breakfast/ })).toHaveCount(2);
});

test('edits a meal: its type, its notes and its entries, sending only what changed', async ({
  page,
}) => {
  await signIn(page);
  await logMeal(page, 'lunch', EDIT_FOOD);
  await page.reload();

  await openMeal(page, 'Lunch');
  await page.getByRole('button', { name: 'Edit' }).click();

  await expect(page.getByRole('heading', { name: 'Edit meal' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: EDIT_FOOD })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Dinner' }).click();
  await page.getByLabel('Notes').fill('At the canteen');
  await page.getByRole('button', { name: /Save changes/ }).click();

  await expect.poll(async () => (await mealsOf(page, EDIT_FOOD))[0]?.type).toBe('dinner');

  const [edited] = await mealsOf(page, EDIT_FOOD);
  expect(edited?.notes).toBe('At the canteen');
  expect(edited?.entries).toHaveLength(1);

  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Meals' }).getByRole('button', { name: /Dinner/ }),
  ).toBeVisible();
});

test('changes one entry colour without touching the food behind it', async ({ page }) => {
  await signIn(page);
  await logMeal(page, 'snack', RECOLOUR_FOOD);
  await page.reload();

  const before = await food(page, RECOLOUR_FOOD);
  expect(before.category, `${RECOLOUR_FOOD} ships with a colour that is not orange`).not.toBe(
    'orange',
  );

  await openMeal(page, 'Snack');

  await page.getByRole('button', { name: new RegExp(`${RECOLOUR_FOOD}.*Change colour`) }).click();
  await page.getByRole('button', { name: 'orange', exact: true }).click();

  await expect
    .poll(async () => (await mealsOf(page, RECOLOUR_FOOD))[0]?.entries[0]?.category)
    .toBe('orange');

  expect((await food(page, RECOLOUR_FOOD)).category).toBe(before.category);

  await page.reload();
  await openMeal(page, 'Snack');
  await expect(page.getByRole('img', { name: 'orange' }).first()).toBeVisible();
});

test('refuses to empty a meal at the field rather than in the queue an hour later', async ({
  page,
}) => {
  await signIn(page);

  await logMeal(page, 'breakfast', EMPTY_FOOD, yesterday());
  await expect.poll(() => mealsOf(page, EMPTY_FOOD)).toHaveLength(1);

  await page.reload();
  await page.keyboard.press('ArrowLeft');

  const rows = page
    .getByRole('region', { name: 'Meals' })
    .getByRole('button', { name: /Breakfast/ });
  await expect(rows.first()).toBeVisible();

  let found = false;

  for (let index = 0; index < (await rows.count()); index += 1) {
    await rows.nth(index).click();

    if ((await page.getByRole('listitem').filter({ hasText: EMPTY_FOOD }).count()) > 0) {
      found = true;
      break;
    }

    await rows.nth(index).click();
  }

  expect(found, `a Breakfast meal on this day names ${EMPTY_FOOD}`).toBe(true);

  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: new RegExp(`Remove ${EMPTY_FOOD}`) }).click();

  await expect(page.getByRole('alert').filter({ hasText: /at least one thing/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();

  expect((await mealsOf(page, EMPTY_FOOD))[0]?.entries).toHaveLength(1);
});

test('folds an edit into a create that has not been sent yet, so one meal arrives', async ({
  page,
}) => {
  await signIn(page);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const open = indexedDB.open('portionium');
            open.onsuccess = () => {
              const count = open.result.transaction('foods').objectStore('foods').count();
              count.onsuccess = () => resolve(count.result);
            };
          }),
      ),
    )
    .toBeGreaterThan(0);

  await page.context().setOffline(true);

  const OFFLINE_FOOD = 'Dattel getrocknet';

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByLabel('Add a food').fill(OFFLINE_FOOD);
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: /^Log / }).click();

  await page
    .getByRole('region', { name: 'Meals' })
    .getByRole('button')
    .filter({ has: page.getByRole('img', { name: /not sent yet/ }) })
    .click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Snack' }).click();
  await page.getByLabel('Notes').fill('Queued and then corrected');
  await page.getByRole('button', { name: /Save changes/ }).click();

  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(1);

  await page.context().setOffline(false);

  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(0, { timeout: 15_000 });

  const logged = await mealsOf(page, OFFLINE_FOOD);

  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ type: 'snack', notes: 'Queued and then corrected' });
  expect(logged[0]?.entries).toHaveLength(1);
});
