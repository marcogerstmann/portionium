import { expect, test, type Page } from '@playwright/test';

import { localDateFor, shiftDate } from '../src/db';
import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.compose;

/**
 * Composing a meal, in a browser, against the real API.
 *
 * The last spec here is the one this story exists for. WEB 2 (POR-41) built the outbox and the
 * idempotency keys and deliberately shipped no UI to drive them, so until now nothing proved
 * that three meals logged with no connection arrive as three meals rather than as six. The
 * weight half of that original criterion is on WEB 5, where weight entry is built.
 *
 * Everything here needs a browser: IndexedDB for the cached catalog, a real keyboard for the
 * combobox, and a network switch for the queue. The matching and the pre-selection underneath
 * are src/food-search.test.ts and src/day.test.ts.
 */

const API = '/api/v1';

/**
 * The seed foods each test below claims, and no other test in this file names.
 *
 * The specs here share an account and a today, so they can see each other's meals. They count
 * the meals they made, and a meal row on screen says only its type, so "the lunch" is not
 * something the screen can point at once a neighbour has logged one too. Claiming a food is what
 * makes "mine" expressible, see mealsOf. Another file's meals are on another account and cannot
 * be here at all, see ACCOUNTS.
 *
 * They are also early in the alphabet on purpose. The cached catalog is what GET /foods/search
 * answers an empty query with, which for an account with little history degrades to the catalog
 * by name, so these are the entries that are certainly on the device once the network goes away,
 * see frequentFoods in api/src/db/food-search.ts.
 */
const OFFLINE_FOODS = ['Aubergine', 'Blumenkohl', 'Brokkoli'];
const KEYBOARD_FOODS = ['Camembert', 'Couscous'];
const PAST_DAY_FOOD = 'Erdbeere';

/**
 * The weights this file records, one per test that records one, for the same reason the foods
 * above are claimed: a count that is only right because nothing else in the file writes one is a
 * count that quietly starts passing for the wrong reason once something else does.
 */
const OFFLINE_WEIGHT = 79.3;
const PAST_DAY_WEIGHT = 68.4;

interface LoggedMeal {
  id: string;
  type: string;
  entries: { foodId: string | null }[];
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/**
 * The catalog ids behind some names, in the order they were asked for.
 *
 * Through the API rather than through the screen, because this is how a spec checks what the
 * screen did. `page.request` carries the browser context's session cookie, see today.spec.ts.
 */
async function foodIds(page: Page, names: readonly string[]): Promise<string[]> {
  const ids: string[] = [];

  for (const name of names) {
    const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
    const [food] = (await found.json()) as { id: string; name: string }[];

    // An exact name outranks every other match, so a first result that is something else means
    // the claim above is wrong and everything below would be asserting against another food.
    expect(food?.name, `the seed catalog has exactly one ${name}`).toBe(name);
    ids.push(food?.id ?? '');
  }

  return ids;
}

/** The meals on the server that name any of these foods, which is how a spec finds its own. */
async function mealsOf(page: Page, names: readonly string[]): Promise<LoggedMeal[]> {
  const wanted = new Set(await foodIds(page, names));
  const response = await page.request.get(`${API}/meals?limit=100`);
  const { items } = (await response.json()) as { items: LoggedMeal[] };

  return items.filter((meal) =>
    meal.entries.some((entry) => entry.foodId !== null && wanted.has(entry.foodId)),
  );
}

/** The readings on the server carrying this exact weight, which is how a spec finds its own. */
async function weightEntriesOf(page: Page, weightKg: number): Promise<{ weightKg: number }[]> {
  const response = await page.request.get(`${API}/weight?limit=100`);
  const { items } = (await response.json()) as { items: { weightKg: number }[] };

  return items.filter((entry) => entry.weightKg === weightKg);
}

/** How many rows are in one of the client's IndexedDB tables, which is what "cached" means. */
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

/** Type a name, take the first result, and leave the field ready for the next one. */
async function addFood(page: Page, name: string) {
  await page.getByLabel('Add a food').fill(name);

  // The dot's letter is the first character of the row, so the name is everything after it.
  // Asserted rather than assumed, for the reason foodIds gives.
  const first = page.getByRole('option').first();
  await expect(first).toHaveText(new RegExp(`^.?${name}$`));

  await first.click();
  await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
}

test('opens on the search field with the meal type already chosen', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  // Focused on the tap that opened the screen, which on a phone is what brings the keyboard up
  // without a second one.
  await expect(page.getByLabel('Add a food')).toBeFocused();

  // One of the four is pre-selected from the clock and any of them is one tap away. Which one
  // depends on when the suite runs, so what is asserted is that exactly one is chosen.
  const types = page.getByRole('group', { name: 'Meal type' }).getByRole('button');
  await expect(types).toHaveCount(4);
  await expect(types.and(page.locator('[aria-pressed="true"]'))).toHaveCount(1);

  // And there is something to choose before anything has been typed, which comes off the device
  // rather than out of a request, see cachedFoods.
  await expect(page.getByRole('option').first()).toBeVisible();

  // A result row is the thing tapped most on this screen and it is not a button, so today.spec's
  // floor over every button does not reach it. Same floor, checked where it applies.
  //
  // One row rather than all of them, and polled rather than measured once. The rows come off the
  // device and are replaced by the server's answer a moment later, so a loop over a snapshot of
  // them measures a node that has already been detached. Every row is the same rule anyway.
  await expect
    .poll(async () => (await page.getByRole('option').first().boundingBox())?.height ?? 0)
    .toBeGreaterThanOrEqual(44);
});

test('logs a meal from the keyboard alone: type, arrow down, enter, repeat', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  await page.getByRole('button', { name: 'Lunch', exact: true }).click();
  // The click moved focus onto the meal type. Getting back to the field is the one reach this
  // flow costs, and after it the hand never leaves the letters.
  await page.getByLabel('Add a food').focus();

  for (const name of KEYBOARD_FOODS) {
    await page.keyboard.type(name);
    // Down onto the first option, Enter to take it. The field keeps focus throughout, which is
    // what the combobox pattern is for, so the next name is simply typed.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
  }

  await expect(page.getByLabel('Add a food')).toBeFocused();
  await expect(page.getByLabel('Add a food')).toHaveValue('');

  await page.getByRole('button', { name: /^Log Lunch/ }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Read back from the server, which is what proves the keyboard built the meal rather than just
  // filled a list: the right type, and the right two foods in the order they were typed, since
  // an item's position is its meaning, see createMealRequestSchema.
  await expect.poll(async () => (await mealsOf(page, KEYBOARD_FOODS)).length).toBe(1);

  const [meal] = await mealsOf(page, KEYBOARD_FOODS);

  expect(meal?.type).toBe('lunch');
  expect(meal?.entries.map((entry) => entry.foodId)).toEqual(await foodIds(page, KEYBOARD_FOODS));
});

test('adds a food the catalog does not have, with nothing but a name', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Add a meal' }).click();

  // A name the seed catalog cannot have, so the offer is the only option in the list.
  const invented = `Testfutter ${Date.now()}`;
  await page.getByLabel('Add a food').fill(invented);

  const offer = page.getByRole('option', { name: new RegExp(`Add ${invented}`) });
  await expect(offer).toBeVisible();
  await offer.click();

  // On the meal straight away and with no colour, which is what puts it in the review queue: one
  // insert, and never a wait on a classifier, see POST /foods.
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

  // What the device has to be holding before the connection goes: a meal references a food by
  // id, so a client with no catalog has no id to reference. See refreshFoods.
  await expect.poll(() => cachedRows(page, 'foods')).toBeGreaterThan(0);

  await page.context().setOffline(true);

  for (const name of OFFLINE_FOODS) {
    await page.getByRole('button', { name: 'Add a meal' }).click();
    await addFood(page, name);
    await page.getByRole('button', { name: /^Log / }).click();
  }

  // The other half of the criterion that moved off WEB 2, recorded through this UI rather than
  // through the API, because what is being tested is that the screen's own write goes into the
  // outbox rather than onto the network. See the weight entry on the Today screen.
  await page.getByRole('button', { name: /Weight/ }).click();
  await page.getByLabel('Weight in kg').fill(String(OFFLINE_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();

  // Durable and on screen with no network at all, and marked as not sent in a way that is
  // announced rather than only dimmed, see the accessibility note on POR-42. Four marks: three
  // meals and the reading.
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(4);

  await page.context().setOffline(false);

  // The queue empties on its own: `online` fires, the drain sends what is due, and each day it
  // changed is re-fetched from the server, which is what clears the marks.
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(0, { timeout: 15_000 });

  // Three meals rather than six, and three entries rather than six. Every attempt at one entry
  // carries the idempotency key minted when it was queued, and a meal carries the id this device
  // minted, so a retry whose first response was lost cannot become a second meal. See
  // docs/adr/004-idempotency-keys.md and classifyAttempt in src/outbox.ts.
  const logged = await mealsOf(page, OFFLINE_FOODS);

  expect(logged).toHaveLength(3);
  expect(logged.flatMap((meal) => meal.entries)).toHaveLength(3);

  // And exactly one reading rather than two. A weight carries no client minted id, so the
  // idempotency key is the only thing standing between a retry and a second row, see logWeight.
  expect(await weightEntriesOf(page, OFFLINE_WEIGHT)).toHaveLength(1);

  // The server's copy afterwards, not the optimistic one, which a reload is what tells apart.
  await page.reload();
  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();
});

/**
 * POR-62: both writes used to be stamped with this clock regardless of the day on screen, which
 * put a backdated meal or weight on today and forced a page back to today to hide it. See
 * outbox.ts's logMeal and logWeight.
 */
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

  // Back on the day the composer was opened from, not paged to today, see today.tsx.
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
