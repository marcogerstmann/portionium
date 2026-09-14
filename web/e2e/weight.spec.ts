import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

/** This file's own account, so nothing another spec logs is visible here. See ACCOUNTS. */
const ACCOUNT = ACCOUNTS.weight;

/**
 * Correcting or removing a weight reading, in a browser, against the real API. POR-74.
 *
 * Its own file rather than more of today.spec.ts, claiming its own account, see the isolation
 * note in AGENTS.md. The interesting half of the offline case is what happens to a queued write,
 * the same shape of test as correct.spec.ts's own folding case. Every claim here needs a
 * browser: IndexedDB for the queue a correction folds into, a real network switch for the
 * offline case, and the accessibility tree for which control is which. The pure halves are
 * src/db.test.ts and src/outbox.test.ts.
 *
 * "The" reading for a day is the most recently recorded one, and the specs here share an
 * account and a today the way every file's do, see ACCOUNTS. Recording a second reading on a
 * day that already has one is already a correction from the server's own point of view, so the
 * two tests that check the empty state work on their own past day each, a day none of the
 * others here ever touches, rather than on today alongside the offline test.
 */

const API = '/api/v1';

/**
 * The readings this file records, one per test that records one, so a count that only happens
 * to be right because nothing else here writes one does not quietly start passing for the wrong
 * reason once something else does. See compose.spec.ts's OFFLINE_WEIGHT for the same convention.
 */
const RECORDED_WEIGHT = 74.5;
const CORRECTED_WEIGHT = 76.2;
const REMOVED_WEIGHT = 80.7;
const OFFLINE_WEIGHT = 71.9;
const OFFLINE_CORRECTED_WEIGHT = 73.4;

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill(ACCOUNT.email);
  await page.getByLabel('Password').fill(ACCOUNT.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** Roughly this time, `days` ago, so a reading stamped with it lands on that day. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

/** Record a weight through the API rather than through the screen, the way correct.spec.ts does. */
async function recordWeight(page: Page, weightKg: number, recordedAt?: string): Promise<void> {
  const response = await page.request.post(`${API}/weight`, {
    headers: { origin: new URL(page.url()).origin },
    data: { weightKg, ...(recordedAt === undefined ? {} : { recordedAt }) },
  });

  expect(response.status()).toBe(201);
}

/**
 * Sign in over the API and record a past reading before the app ever renders a single frame,
 * rather than after, the way `signIn` followed by `recordWeight` would.
 *
 * The Today screen warms a week of cached days the moment it mounts, see refreshRecentDays, and
 * that prefetch only fills gaps: a day it has already cached once is left exactly as it was,
 * stale or not. Recording a reading after the screen has already cached that day empty is a race
 * with no promise about which side wins, so this signs in and writes the reading first, on a
 * page that has not mounted the app at all yet, and only then loads it.
 */
async function seedWeight(page: Page, weightKg: number, recordedAt: string): Promise<void> {
  await page.goto('/');

  const login = await page.request.post(`${API}/auth/login`, {
    data: { email: ACCOUNT.email, password: ACCOUNT.password },
  });
  expect(login.status()).toBe(200);

  await recordWeight(page, weightKg, recordedAt);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
}

/** The readings on the server carrying this exact weight, which is how a test finds its own. */
async function weightEntriesOf(page: Page, weightKg: number): Promise<unknown[]> {
  const response = await page.request.get(`${API}/weight?limit=100`);
  const { items } = (await response.json()) as { items: { weightKg: number }[] };

  return items.filter((entry) => entry.weightKg === weightKg);
}

test('corrects a weight already recorded, prefilled with the reading being corrected', async ({
  page,
}) => {
  await seedWeight(page, RECORDED_WEIGHT, daysAgo(1));
  await page.keyboard.press('ArrowLeft');

  await expect(page.getByText(`${RECORDED_WEIGHT} kg`)).toBeVisible();

  await page.getByRole('button', { name: 'Correct weight' }).click();

  // Prefilled with the reading being corrected, not with lastReading(days): on the day being
  // corrected that last global reading is the wrong number to offer, see Weight in today.tsx.
  await expect(page.getByLabel('Weight in kg')).toHaveValue(String(RECORDED_WEIGHT));

  await page.getByLabel('Weight in kg').fill(String(CORRECTED_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${CORRECTED_WEIGHT} kg`)).toBeVisible();

  // One reading on the server, the corrected one, and the superseded one gone rather than left
  // behind as a second row for the day.
  await expect.poll(async () => (await weightEntriesOf(page, CORRECTED_WEIGHT)).length).toBe(1);
  expect(await weightEntriesOf(page, RECORDED_WEIGHT)).toHaveLength(0);

  // The server's copy, not the optimistic one, which a reload is what tells apart. Waited for
  // rather than paged straight away: the keydown listener ArrowLeft needs is registered by an
  // effect, and pressing it before that effect has run sends it into an empty page.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByText(`${CORRECTED_WEIGHT} kg`)).toBeVisible();
});

test('removes a weight and shows the empty row again', async ({ page }) => {
  await seedWeight(page, REMOVED_WEIGHT, daysAgo(2));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  await expect(page.getByText(`${REMOVED_WEIGHT} kg`)).toBeVisible();

  await page.getByRole('button', { name: 'Remove weight' }).click();

  // The empty row again, the same button the day with no reading has always shown.
  await expect(page.getByRole('button', { name: /Weight/ })).toBeVisible();
  await expect(page.getByText(`${REMOVED_WEIGHT} kg`)).not.toBeVisible();
  expect(await weightEntriesOf(page, REMOVED_WEIGHT)).toHaveLength(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('button', { name: /Weight/ })).toBeVisible();
});

test('folds an offline correction into a create that has not drained yet, so one reading arrives', async ({
  page,
}) => {
  await signIn(page);
  await page.context().setOffline(true);

  await page.getByRole('button', { name: /Weight/ }).click();
  await page.getByLabel('Weight in kg').fill(String(OFFLINE_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${OFFLINE_WEIGHT} kg`)).toBeVisible();

  // Corrected before the create above has ever reached the server: the server holds no reading
  // to delete, so this is folded into the queued create rather than followed by one, see
  // correctWeight in src/outbox.ts.
  await page.getByRole('button', { name: 'Correct weight' }).click();
  await expect(page.getByLabel('Weight in kg')).toHaveValue(String(OFFLINE_WEIGHT));
  await page.getByLabel('Weight in kg').fill(String(OFFLINE_CORRECTED_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${OFFLINE_CORRECTED_WEIGHT} kg`)).toBeVisible();
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(1);

  await page.context().setOffline(false);
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(0, { timeout: 15_000 });

  // One reading, the corrected one, rather than a create followed by a delete and a post that
  // would have 404ed against a date the server never held a reading on.
  expect(await weightEntriesOf(page, OFFLINE_CORRECTED_WEIGHT)).toHaveLength(1);
  expect(await weightEntriesOf(page, OFFLINE_WEIGHT)).toHaveLength(0);

  await page.reload();
  await expect(page.getByText(`${OFFLINE_CORRECTED_WEIGHT} kg`)).toBeVisible();
});
