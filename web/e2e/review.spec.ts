import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.review;

/**
 * The review queue, in a browser, against the real API.
 *
 * This needs a browser rather than a unit test for the two halves that are only true end to
 * end. Several rows have to leave as one request, which is a claim about the network and not
 * about a component. And the entries already logged have to change colour on the device the way
 * the server changed them on its side, which is IndexedDB plus a real confirmation, not a pure
 * function over a day.
 *
 * The tests below share an account and a today, so they run in the order they are written: the
 * first is the only moment this account's queue is empty, and the second fills it.
 */

const API = '/api/v1';

/**
 * The foods this file invents, named so the seed catalog cannot already hold them and so a
 * rerun against a database that somehow survived cannot collide with the last one.
 */
const STAMP = Date.now();
const FIRST = `Testfutter A ${STAMP}`;
const SECOND = `Testfutter B ${STAMP}`;
const INVENTED = [FIRST, SECOND];

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** What the catalog says a food's colour is now, which is what a confirmation is supposed to set. */
async function colourOf(page: Page, name: string): Promise<string | null> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
  const [food] = (await found.json()) as { name: string; category: string | null }[];

  expect(food?.name, `exactly one food is called ${name}`).toBe(name);

  return food?.category ?? null;
}

test('there is no queue row while nothing is waiting', async ({ page }) => {
  await signIn(page);

  // The account has logged nothing yet, so this is the one moment its queue is genuinely empty.
  // Asserted at the source first, or the absence below would pass for having nothing to do with
  // the count at all.
  const count = await page.request.get(`${API}/foods/unclassified/count`);

  expect(((await count.json()) as { count: number }).count).toBe(0);

  await expect(page.getByRole('button', { name: /Foods with no colour/ })).toBeHidden();
});

test('clears several foods in one request and recolours the entries waiting on them', async ({
  page,
}) => {
  await signIn(page);

  // Every confirmation this test causes, so "several rows are one request" is a count rather
  // than an impression. Registered before anything is confirmed.
  const confirmations: string[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().includes('/foods/unclassified/confirm')) {
      confirmations.push(sent.url());
    }
  });

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByRole('button', { name: 'Lunch', exact: true }).click();

  for (const name of INVENTED) {
    await page.getByLabel('Add a food').fill(name);
    const offer = page.getByRole('option', { name: new RegExp(`Add ${name}`) });
    await expect(offer).toBeVisible();
    await offer.click();

    // Before typing the next one. Adding a food the catalog lacks is the one thing on the
    // composer that waits for the server, since the id is minted there, and the field is
    // cleared when it lands: typing into it first would have that clear the second name.
    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: /^Log Lunch/ }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // Both arrived with no colour, which is what put them in the queue: adding a food the catalog
  // lacks is one insert and never a wait on a classifier.
  await expect(page.getByRole('button', { name: /^Lunch/ })).toBeVisible();
  await page.getByRole('button', { name: /^Lunch/ }).click();
  await expect(page.getByRole('img', { name: /2 not classified yet/ })).toBeVisible();

  // The badge, which is what makes the queue advertise itself rather than wait to be found.
  const queueRow = page.getByRole('button', { name: /Foods with no colour/ });
  await expect(queueRow).toBeVisible();
  await expect(queueRow).toHaveAccessibleName(/2 waiting for a colour/);

  await queueRow.click();
  await expect(page.getByRole('heading', { name: 'Give a colour' })).toBeVisible();

  // Two rows, two different colours, and nothing sent yet: a colour button marks a row, which
  // is what lets the queue be cleared in a sitting rather than a round trip at a time.
  await page.getByRole('button', { name: `green ${FIRST}` }).click();
  await page.getByRole('button', { name: `orange ${SECOND}` }).click();
  expect(confirmations).toHaveLength(0);

  await page.getByRole('button', { name: 'Confirm 2 foods' }).click();

  // Both rows are gone and the screen says so plainly rather than showing an error or nothing.
  await expect(
    page.getByText('Nothing to review. Every food you have logged has a colour.'),
  ).toBeVisible();
  expect(confirmations).toHaveLength(1);

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  // The entries logged before the colours existed now carry them, which is the whole point of
  // the screen: a grey entry is one the statistics cannot place. The meal is still open from
  // above, and what is read here is the day, not the queue.
  await expect(page.getByRole('img', { name: /1 green, 0 yellow, 1 orange/ })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: FIRST }).getByRole('img', { name: 'green' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: SECOND }).getByRole('img', { name: 'orange' }),
  ).toBeVisible();

  // And the verdict is the server's now, not a colour this client is holding on screen: it is
  // what the catalog resolves to for this caller, so every future entry of these foods gets it.
  expect(await colourOf(page, FIRST)).toBe('green');
  expect(await colourOf(page, SECOND)).toBe('orange');

  // The queue row went with the queue, the same rule that kept it off the screen in the first
  // test: it appears while there is something in it and not otherwise.
  await expect(page.getByRole('button', { name: /Foods with no colour/ })).toBeHidden();
});
