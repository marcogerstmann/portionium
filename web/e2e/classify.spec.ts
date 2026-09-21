import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.classify;

const API = '/api/v1';

/** Absent from the catalog, so the search finds nothing and the row is offered. */
const TYPED = 'nussschnecke vom bäcker';

/**
 * The model's answer names a food the catalog already has, so accepting it reuses that row rather
 * than adding one. Nothing here creates a food: an unjudged one is global, and the review queue
 * another spec is counting would count it too.
 */
const SUGGESTED = 'Fenchel';
const QUEUED = 'Sauerkraut';

interface Verdict {
  category: string;
  source: string;
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

async function foodId(page: Page, name: string): Promise<string> {
  const found = await page.request.get(`${API}/foods/search?q=${encodeURIComponent(name)}`);
  const [food] = (await found.json()) as { id: string; name: string }[];

  expect(food?.name, `the seed catalog has exactly one ${name}`).toBe(name);

  return food?.id ?? '';
}

async function verdicts(page: Page, id: string): Promise<Verdict[]> {
  const history = await page.request.get(`${API}/foods/${id}/classification/history`);

  return (await history.json()) as Verdict[];
}

/**
 * The model is stubbed in the browser rather than behind the API: the route's own behaviour has
 * tests in api/test/http/foods.test.ts, and what is worth a browser here is the row.
 */
async function stubClassifier(page: Page, held?: Promise<void>) {
  await page.route(`**${API}/foods/classify`, async (route) => {
    await held;

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: SUGGESTED, category: 'orange', confidence: 0.82 }),
    });
  });
}

test('asks the model only when the row is chosen, never on a keystroke', async ({ page }) => {
  await signIn(page);

  const id = await foodId(page, SUGGESTED);
  await stubClassifier(page);

  const asked: string[] = [];
  page.on('request', (sent) => {
    if (sent.url().includes('/foods/classify')) {
      asked.push(sent.url());
    }
  });

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByLabel('Add a food').fill(TYPED);

  const plain = page.getByRole('option', { name: `${TYPED} as a new food` });
  const ask = page.getByRole('option', { name: 'Suggest a colour with AI' });

  // Both rows are there, and typing has bought nothing.
  await expect(plain).toBeVisible();
  await expect(ask).toBeVisible();
  await page.waitForTimeout(1500);
  expect(asked).toHaveLength(0);

  await ask.click();

  const offer = page.getByRole('option', { name: `Add ${SUGGESTED}` });
  await expect(offer).toBeVisible();
  await expect(offer.getByRole('img', { name: 'orange' })).toBeVisible();
  expect(asked).toHaveLength(1);

  await offer.click();

  await expect(page.getByRole('listitem').filter({ hasText: SUGGESTED })).toBeVisible();
  // The caret never leaves the field, which is what makes a three item meal one journey.
  await expect(page.getByLabel('Add a food')).toBeFocused();

  await expect
    .poll(async () => (await verdicts(page, id))[0])
    .toMatchObject({ source: 'user', category: 'orange' });
});

test('says it is waiting, and keeps the row where the finger already is', async ({ page }) => {
  let release = () => undefined as void;

  await signIn(page);
  await stubClassifier(
    page,
    new Promise<void>((resolve) => {
      release = () => resolve();
    }),
  );

  await page.getByRole('button', { name: 'Add a meal' }).click();
  await page.getByLabel('Add a food').fill(TYPED);
  await page.getByRole('option', { name: 'Suggest a colour with AI' }).click();

  const waiting = page.getByRole('option', { name: `Suggesting a colour for ${TYPED}` });
  await expect(waiting).toBeVisible();

  release();

  await expect(page.getByRole('option', { name: `Add ${SUGGESTED}` })).toBeVisible();
});

test('pre-marks the colour the model suggested, so confirming the queue accepts it', async ({
  page,
}) => {
  // Today reads the count once, on mount, so it is answered before the screen is there to ask.
  await page.route(`**${API}/foods/unclassified/count?*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"count":1}' }),
  );

  await signIn(page);

  const id = await foodId(page, QUEUED);

  await page.route(`**${API}/foods/unclassified?*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id,
          name: QUEUED,
          kind: 'ingredient',
          suggestion: {
            id,
            category: 'yellow',
            source: 'ai_text',
            model: 'gpt-test',
            promptVersion: 'v1',
            confidence: 0.62,
            createdAt: new Date().toISOString(),
          },
        },
      ]),
    }),
  );

  await page.getByRole('button', { name: /Foods with no colour/ }).click();
  await expect(page.getByRole('heading', { name: 'Give a colour' })).toBeVisible();

  await expect(page.getByRole('button', { name: `yellow ${QUEUED}` })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.getByRole('button', { name: 'Confirm 1 food' }).click();

  await expect
    .poll(async () => (await verdicts(page, id))[0])
    .toMatchObject({ source: 'user', category: 'yellow' });
});
