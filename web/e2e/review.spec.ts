import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.review;

const API = '/api/v1';

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

async function colourOf(page: Page, name: string): Promise<string | null> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
  const [food] = (await found.json()) as { name: string; category: string | null }[];

  expect(food?.name, `exactly one food is called ${name}`).toBe(name);

  return food?.category ?? null;
}

async function unclassifiedCount(page: Page): Promise<number> {
  const response = await page.request.get(`${API}/foods/unclassified/count`);

  return ((await response.json()) as { count: number }).count;
}

test('the queue row is hidden exactly when the count is zero, and names the count otherwise', async ({
  page,
}) => {
  await signIn(page);

  const pending = await unclassifiedCount(page);
  const queueRow = page.getByRole('button', { name: /Foods with no colour/ });

  if (pending === 0) {
    await expect(queueRow).toBeHidden();
  } else {
    await expect(queueRow).toHaveAccessibleName(new RegExp(`${pending} waiting for a colour`));
  }
});

test('clears several foods in one request and recolours the entries waiting on them', async ({
  page,
}) => {
  await signIn(page);

  const before = await unclassifiedCount(page);

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

    await expect(page.getByRole('listitem').filter({ hasText: name }).first()).toBeVisible();
  }

  await page.getByRole('button', { name: /^Log Lunch/ }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await expect(page.getByRole('button', { name: /^Lunch/ })).toBeVisible();
  await page.getByRole('button', { name: /^Lunch/ }).click();
  await expect(page.getByRole('img', { name: /2 not classified yet/ })).toBeVisible();

  const queueRow = page.getByRole('button', { name: /Foods with no colour/ });
  await expect(queueRow).toBeVisible();
  await expect(queueRow).toHaveAccessibleName(new RegExp(`${before + 2} waiting for a colour`));

  await queueRow.click();
  await expect(page.getByRole('heading', { name: 'Give a colour' })).toBeVisible();

  await page.getByRole('button', { name: `green ${FIRST}` }).click();
  await page.getByRole('button', { name: `orange ${SECOND}` }).click();
  expect(confirmations).toHaveLength(0);

  await page.getByRole('button', { name: 'Confirm 2 foods' }).click();

  await expect(page.getByText(FIRST)).toHaveCount(0);
  await expect(page.getByText(SECOND)).toHaveCount(0);

  if (before === 0) {
    await expect(
      page.getByText('Nothing to review. Every food you have logged has a colour.'),
    ).toBeVisible();
  }

  expect(confirmations).toHaveLength(1);

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await expect(page.getByRole('img', { name: /1 green, 0 yellow, 1 orange/ })).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: FIRST }).getByRole('img', { name: 'green' }),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: SECOND }).getByRole('img', { name: 'orange' }),
  ).toBeVisible();

  expect(await colourOf(page, FIRST)).toBe('green');
  expect(await colourOf(page, SECOND)).toBe('orange');

  if (before === 0) {
    await expect(page.getByRole('button', { name: /Foods with no colour/ })).toBeHidden();
  } else {
    await expect(page.getByRole('button', { name: /Foods with no colour/ })).toHaveAccessibleName(
      new RegExp(`${before} waiting for a colour`),
    );
  }
});
