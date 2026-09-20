import { expect, test, type Page } from '@playwright/test';

import { localDateFor, shiftDate } from '../src/db';
import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.compose;

const API = '/api/v1';

const OFFLINE_FOODS = ['Aubergine', 'Blumenkohl', 'Brokkoli'];
const KEYBOARD_FOODS = ['Camembert', 'Couscous'];
const PAST_DAY_FOOD = 'Erdbeere';

const OFFLINE_WEIGHT = 79.3;
const PAST_DAY_WEIGHT = 68.4;

interface LoggedMeal {
  id: string;
  type: string;
  entries: { foodId: string | null; category: string | null }[];
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function foodIds(page: Page, names: readonly string[]): Promise<string[]> {
  const ids: string[] = [];

  for (const name of names) {
    const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
    const [food] = (await found.json()) as { id: string; name: string }[];

    expect(food?.name, `the seed catalog has exactly one ${name}`).toBe(name);
    ids.push(food?.id ?? '');
  }

  return ids;
}

async function mealsOf(page: Page, names: readonly string[]): Promise<LoggedMeal[]> {
  const wanted = new Set(await foodIds(page, names));
  const response = await page.request.get(`${API}/meals?limit=100`);
  const { items } = (await response.json()) as { items: LoggedMeal[] };

  return items.filter((meal) =>
    meal.entries.some((entry) => entry.foodId !== null && wanted.has(entry.foodId)),
  );
}

async function weightEntriesOf(page: Page, weightKg: number): Promise<{ weightKg: number }[]> {
  const response = await page.request.get(`${API}/weight?limit=100`);
  const { items } = (await response.json()) as { items: { weightKg: number }[] };

  return items.filter((entry) => entry.weightKg === weightKg);
}

function cachedRows(page: Page, store: string): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('portionium');
        open.onsuccess = () => {
          const count = open.result.transaction(name).objectStore(name).count();
          count.onsuccess = () => resolve(count.result);
        };
      }),
    store,
  );
}

async function addFood(page: Page, name: string) {
  await page.getByLabel('Add a food').fill(name);

  const first = page.getByRole('option').first();
  await expect(first).toHaveText(new RegExp(`^.?${name}$`));

  await first.click();
  await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
}

test('opens on the search field with the meal type already chosen', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  await expect(page.getByLabel('Add a food')).toBeFocused();

  const types = page.getByRole('group', { name: 'Meal type' }).getByRole('button');
  await expect(types).toHaveCount(4);
  await expect(types.and(page.locator('[aria-pressed="true"]'))).toHaveCount(1);

  await expect(page.getByRole('option').first()).toBeVisible();

  await expect
    .poll(async () => (await page.getByRole('option').first().boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
});

test('logs a meal from the keyboard alone: type, arrow down, enter, repeat', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  await page.getByRole('button', { name: 'Lunch', exact: true }).click();
  await page.getByLabel('Add a food').focus();

  for (const name of KEYBOARD_FOODS) {
    await page.keyboard.type(name);
    // The catalog has this one, so wait for the row rather than arrowing over a stale list.
    await expect(page.getByRole('option').first()).toHaveText(new RegExp(`^.?${name}$`));
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
  }

  await expect(page.getByLabel('Add a food')).toBeFocused();
  await expect(page.getByLabel('Add a food')).toHaveValue('');

  await page.getByRole('button', { name: /^Log Lunch/ }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await expect.poll(async () => (await mealsOf(page, KEYBOARD_FOODS)).length).toBe(1);

  const [meal] = await mealsOf(page, KEYBOARD_FOODS);

  expect(meal?.type).toBe('lunch');
  expect(meal?.entries.map((entry) => entry.foodId)).toEqual(await foodIds(page, KEYBOARD_FOODS));
});

test('adds a food the catalog does not have, with nothing but a name', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  const invented = `Testfutter ${Date.now()}`;
  await page.getByLabel('Add a food').fill(invented);

  const offer = page.getByRole('option', { name: new RegExp(`Add ${invented}`) });
  await expect(offer).toBeVisible();
  await offer.click();

  await expect(page.getByRole('listitem').filter({ hasText: invented })).toBeVisible();
  await expect(page.getByRole('img', { name: 'not classified yet' }).first()).toBeVisible();

  const queued = await page.request.get(`${API}/foods/unclassified?limit=50`);
  const entries = (await queued.json()) as { name: string }[];

  expect(entries.map((entry) => entry.name)).toContain(invented);
});

test('logs three meals and a weight with no network and drains them exactly once', async ({
  page,
}) => {
  await signIn(page);

  await expect.poll(() => cachedRows(page, 'foods')).toBeGreaterThan(0);

  await page.context().setOffline(true);

  for (const name of OFFLINE_FOODS) {
    await page.getByRole('button', { name: 'Add a meal' }).click();
    await addFood(page, name);

    if (name === OFFLINE_FOODS.at(-1)) {
      await page
        .getByRole('group', { name: 'Or just a colour' })
        .getByRole('button', { name: 'green' })
        .click();

      await expect(page.getByRole('listitem').filter({ hasText: 'Something eaten' })).toBeVisible();
      await expect(page.getByLabel('Add a food')).toBeFocused();
    }

    await page.getByRole('button', { name: /^Log / }).click();
  }

  await page.getByRole('button', { name: /Weight/ }).click();
  await page.getByLabel('Weight in kg').fill(String(OFFLINE_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();

  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(5);

  await page.context().setOffline(false);

  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(0, { timeout: 15_000 });

  const logged = await mealsOf(page, OFFLINE_FOODS);

  expect(logged).toHaveLength(3);
  expect(logged.flatMap((meal) => meal.entries)).toHaveLength(4);

  const mixed = logged.find((meal) => meal.entries.length === 2);

  expect(mixed?.entries[0]?.foodId).not.toBeNull();
  expect(mixed?.entries[1]).toMatchObject({ foodId: null, category: 'green' });

  expect(await weightEntriesOf(page, OFFLINE_WEIGHT)).toHaveLength(1);

  await page.reload();
  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();
});

test('composing a meal and recording a weight on a past day files both there, not on today', async ({
  page,
}) => {
  await signIn(page);

  const me = await page.request.get(`${API}/me`);
  const { timezone, dayBoundaryHour } = (await me.json()) as {
    timezone: string;
    dayBoundaryHour: number;
  };
  const today = localDateFor(new Date(), timezone, dayBoundaryHour);
  const yesterday = shiftDate(today, -1);

  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await addFood(page, PAST_DAY_FOOD);
  await page.getByRole('button', { name: /^Log / }).click();

  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  await page.getByRole('button', { name: /Weight/ }).click();
  await page.getByLabel('Weight in kg').fill(String(PAST_DAY_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${PAST_DAY_WEIGHT} kg`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();

  const [foodId] = await foodIds(page, [PAST_DAY_FOOD]);

  const yesterdayResponse = await page.request.get(`${API}/days/${yesterday}`);
  const yesterdayBody = (await yesterdayResponse.json()) as {
    meals: { entries: { foodId: string | null }[] }[];
    weightEntry: { weightKg: number } | null;
  };

  expect(
    yesterdayBody.meals.some((meal) => meal.entries.some((entry) => entry.foodId === foodId)),
  ).toBe(true);
  expect(yesterdayBody.weightEntry?.weightKg).toBe(PAST_DAY_WEIGHT);

  const todayResponse = await page.request.get(`${API}/days/${today}`);
  const todayBody = (await todayResponse.json()) as typeof yesterdayBody;

  expect(
    todayBody.meals.some((meal) => meal.entries.some((entry) => entry.foodId === foodId)),
  ).toBe(false);
  expect(todayBody.weightEntry?.weightKg).not.toBe(PAST_DAY_WEIGHT);
});
