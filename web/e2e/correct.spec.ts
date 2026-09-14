import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.correct;

/**
 * Correcting a meal and repeating one, in a browser, against the real API.
 *
 * Its own file rather than more of today.spec.ts, because the interesting half of this story is
 * what happens to a queued write, which wants the connection switched off and a drain waited
 * out, and that is a different shape of test from paging a day.
 *
 * Every claim here needs a browser: IndexedDB for the queue an edit is folded into, a real
 * network switch for the offline case, and the accessibility tree for which question a tapped
 * entry is asking. The pure halves are src/db.test.ts and src/outbox.test.ts.
 */

const API = '/api/v1';

/**
 * The foods this file's tests claim, one per test that logs a meal through the API.
 *
 * The specs here share an account and a today, so they can see each other's meals, and a meal
 * row on screen says only its type. Claiming a food is what makes "mine" expressible, the same
 * convention compose.spec.ts follows and for the same reason. There are four meal types and
 * more tests than that, so the type cannot be the claim.
 */
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

/** The catalog entry behind a name. Asserted exactly, for the reason compose.spec.ts gives. */
async function food(page: Page, name: string): Promise<{ id: string; category: string | null }> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
  const [first] = (await found.json()) as { id: string; name: string; category: string | null }[];

  expect(first?.name, `the seed catalog has exactly one ${name}`).toBe(name);

  return { id: first?.id ?? '', category: first?.category ?? null };
}

/**
 * Put a meal on today through the API rather than through the screen, because what is under test
 * below is what happens to a meal that is already there. `page.request` carries the browser
 * context's session cookie and the Origin header the CSRF check wants, see today.spec.ts.
 */
async function logMeal(page: Page, type: string, name: string, loggedAt?: string): Promise<void> {
  const { id } = await food(page, name);

  const response = await page.request.post(`${API}/meals`, {
    headers: { origin: new URL(page.url()).origin },
    data: { type, entries: [{ foodId: id }], ...(loggedAt === undefined ? {} : { loggedAt }) },
  });

  expect(response.status()).toBe(201);
}

/** Roughly this time yesterday, so a meal stamped with it lands on the day before today. */
function yesterday(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
}

/** The meals on the server naming this food, which is how a test finds its own. */
async function mealsOf(page: Page, name: string): Promise<LoggedMeal[]> {
  const { id } = await food(page, name);
  const response = await page.request.get(`${API}/meals?limit=100`);
  const { items } = (await response.json()) as { items: LoggedMeal[] };

  return items.filter((meal) => meal.entries.some((entry) => entry.foodId === id));
}

/** Open the one meal of this type on the day in front of us. */
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

  // Two rows on the day and, after a reload, two meals on the server: the repeat is a real write
  // rather than a copy this device made of a row it was already holding.
  const meals = page.getByRole('region', { name: 'Meals' });
  await expect(meals.getByRole('button', { name: /Breakfast/ })).toHaveCount(2);

  await expect.poll(async () => (await mealsOf(page, REPEAT_FOOD)).length).toBe(2);

  // Named rather than listed: the server is handed `fromMealId` and no entry list, which is what
  // makes the two mutually exclusive fields unreachable from this path, see POST /meals. The
  // entries come back all the same, which is the only observable half of that from out here.
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

  // The composer opens holding what was logged, which is what makes this a correction rather
  // than a re-entry: the food is already in the list and the meal's own type is chosen.
  await expect(page.getByRole('heading', { name: 'Edit meal' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: EDIT_FOOD })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Lunch' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Dinner' }).click();
  await page.getByLabel('Notes').fill('At the canteen');
  await page.getByRole('button', { name: /Save changes/ }).click();

  await expect.poll(async () => (await mealsOf(page, EDIT_FOOD))[0]?.type).toBe('dinner');

  const [edited] = await mealsOf(page, EDIT_FOOD);
  expect(edited?.notes).toBe('At the canteen');
  // Untouched, which is the point of sending only what changed: the entry list never went, so
  // there was nothing for the server to restamp.
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

  // A coloured entry asks about the entry, where a grey one asks about the food. The affordance
  // says which, see MealDetail.
  await page.getByRole('button', { name: new RegExp(`${RECOLOUR_FOOD}.*Change colour`) }).click();
  await page.getByRole('button', { name: 'orange', exact: true }).click();

  await expect
    .poll(async () => (await mealsOf(page, RECOLOUR_FOOD))[0]?.entries[0]?.category)
    .toBe('orange');

  // The food is what the whole story turns on: correcting what was eaten once must not decide
  // every future entry of it, which is what classifying the food would have done. See ADR 011.
  expect((await food(page, RECOLOUR_FOOD)).category).toBe(before.category);

  await page.reload();
  await openMeal(page, 'Snack');
  await expect(page.getByRole('img', { name: 'orange' }).first()).toBeVisible();
});

test('refuses to empty a meal at the field rather than in the queue an hour later', async ({
  page,
}) => {
  await signIn(page);

  // Yesterday, which is this test's claim rather than a food: the repeat above leaves two
  // breakfasts on today and a meal row says only its type, so "the one holding Gurke" is not
  // something the day can be asked for. Nothing else in this file writes to a past day.
  await logMeal(page, 'breakfast', EMPTY_FOOD, yesterday());
  await page.reload();
  await page.keyboard.press('ArrowLeft');

  // Counted rather than clicked straight away. A day is rendered from the device first and
  // replaced by the server's answer, and yesterday is not on the device yet on a fresh account,
  // so this is what waits for the meal to actually be there. See the load in today.tsx.
  const row = page
    .getByRole('region', { name: 'Meals' })
    .getByRole('button', { name: /Breakfast/ });
  await expect(row).toHaveCount(1);

  await row.click();
  await page.getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: new RegExp(`Remove ${EMPTY_FOOD}`) }).click();

  // A domain invariant the server refuses, said here beside the list it is about. Left to the
  // queue it would come back as a refused write in a list of them, long after the tap.
  await expect(page.getByRole('alert').filter({ hasText: /at least one thing/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save changes/ })).toBeDisabled();

  // And nothing was sent: the meal is still whole on the server.
  expect((await mealsOf(page, EMPTY_FOOD))[0]?.entries).toHaveLength(1);
});

test('folds an edit into a create that has not been sent yet, so one meal arrives', async ({
  page,
}) => {
  await signIn(page);

  // What the device has to be holding before the connection goes: a meal references a food by
  // id, so a client with no catalog has no id to reference. See refreshFoods.
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

  // A food no other test in this file claims, typed rather than looked up, because the point is
  // that nothing here touches the network.
  const OFFLINE_FOOD = 'Dattel getrocknet';

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByLabel('Add a food').fill(OFFLINE_FOOD);
  await page.getByRole('option').first().click();
  await page.getByRole('button', { name: /^Log / }).click();

  // Editing a meal logged thirty seconds ago on a train is the ordinary case. The server holds
  // no id to PATCH, so the edit is folded into the create still sitting in the queue.
  //
  // Found by its unsent ring rather than by its type or its position, because the composer picks
  // the type off the clock and what that is when this suite runs is not knowable when it is
  // written, see the note on ACCOUNTS.
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

  // One meal rather than a create followed by a PATCH against an id the server never held, and
  // it arrives already corrected.
  const logged = await mealsOf(page, OFFLINE_FOOD);

  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ type: 'snack', notes: 'Queued and then corrected' });
  expect(logged[0]?.entries).toHaveLength(1);
});
