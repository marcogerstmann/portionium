import { expect, test, type Page } from '@playwright/test';

import { ACCOUNT } from '../playwright.config';

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
 * The seed foods each spec below claims, and no other spec names.
 *
 * One database serves the whole run and every spec shares an account, which is the convention
 * today.spec.ts states as "a type no other spec logs". Claiming foods is the same idea one level
 * down, and it is what these specs need instead: they count the meals they made, and a meal row
 * on screen says only its type, so "the lunch" is not something the screen can point at when
 * another spec has logged one too.
 *
 * They are also early in the alphabet on purpose. The cached catalog is what GET /foods/search
 * answers an empty query with, which for an account with little history degrades to the catalog
 * by name, so these are the entries that are certainly on the device once the network goes away,
 * see frequentFoods in api/src/db/food-search.ts.
 */
const OFFLINE_FOODS = ['Aubergine', 'Blumenkohl', 'Brokkoli'];
const KEYBOARD_FOODS = ['Camembert', 'Couscous'];

/**
 * The weight the offline spec records, and no other spec types.
 *
 * The same claiming convention as the foods above, one dimension across. Every spec shares an
 * account and today.spec.ts records a weight of its own, so "the reading on today" is not
 * something a count can point at; a value nobody else uses is.
 */
const OFFLINE_WEIGHT = 79.3;

interface LoggedMeal {
  id: string;
  type: string;
  items: { foodId: string }[];
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

  return items.filter((meal) => meal.items.some((item) => wanted.has(item.foodId)));
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

  await page.getByRole('button', { name: /^Log lunch/ }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Read back from the server, which is what proves the keyboard built the meal rather than just
  // filled a list: the right type, and the right two foods in the order they were typed, since
  // an item's position is its meaning, see createMealRequestSchema.
  await expect.poll(async () => (await mealsOf(page, KEYBOARD_FOODS)).length).toBe(1);

  const [meal] = await mealsOf(page, KEYBOARD_FOODS);

  expect(meal?.type).toBe('lunch');
  expect(meal?.items.map((item) => item.foodId)).toEqual(await foodIds(page, KEYBOARD_FOODS));
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

  // Three meals rather than six, and three items rather than six. Every attempt at one entry
  // carries the idempotency key minted when it was queued, and a meal carries the id this device
  // minted, so a retry whose first response was lost cannot become a second meal. See
  // docs/adr/004-idempotency-keys.md and classifyAttempt in src/outbox.ts.
  const logged = await mealsOf(page, OFFLINE_FOODS);

  expect(logged).toHaveLength(3);
  expect(logged.flatMap((meal) => meal.items)).toHaveLength(3);

  // And exactly one reading rather than two. A weight carries no client minted id, so the
  // idempotency key is the only thing standing between a retry and a second row, see logWeight.
  expect(await weightEntriesOf(page, OFFLINE_WEIGHT)).toHaveLength(1);

  // The server's copy afterwards, not the optimistic one, which a reload is what tells apart.
  await page.reload();
  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();
});
