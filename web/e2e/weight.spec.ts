import { expect, test, type Page } from '@playwright/test';

import { ACCOUNTS } from '../playwright.config';

const ACCOUNT = ACCOUNTS.weight;

const API = '/api/v1';

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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
}

async function recordWeight(page: Page, weightKg: number, recordedAt?: string): Promise<void> {
  const response = await page.request.post(`${API}/weight`, {
    headers: { origin: new URL(page.url()).origin },
    data: { weightKg, ...(recordedAt === undefined ? {} : { recordedAt }) },
  });

  expect(response.status()).toBe(201);
}

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

  await expect(page.getByLabel('Weight in kg')).toHaveValue(String(RECORDED_WEIGHT));

  await page.getByLabel('Weight in kg').fill(String(CORRECTED_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${CORRECTED_WEIGHT} kg`)).toBeVisible();

  await expect.poll(async () => (await weightEntriesOf(page, CORRECTED_WEIGHT)).length).toBe(1);
  expect(await weightEntriesOf(page, RECORDED_WEIGHT)).toHaveLength(0);

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
  await page.getByRole('button', { name: 'Yes, remove' }).click();

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

  await page.getByRole('button', { name: 'Correct weight' }).click();
  await expect(page.getByLabel('Weight in kg')).toHaveValue(String(OFFLINE_WEIGHT));
  await page.getByLabel('Weight in kg').fill(String(OFFLINE_CORRECTED_WEIGHT));
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(`${OFFLINE_CORRECTED_WEIGHT} kg`)).toBeVisible();
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(1);

  await page.context().setOffline(false);
  await expect(page.getByRole('img', { name: /not sent yet/ })).toHaveCount(0, { timeout: 15_000 });

  expect(await weightEntriesOf(page, OFFLINE_CORRECTED_WEIGHT)).toHaveLength(1);
  expect(await weightEntriesOf(page, OFFLINE_WEIGHT)).toHaveLength(0);

  await page.reload();
  await expect(page.getByText(`${OFFLINE_CORRECTED_WEIGHT} kg`)).toBeVisible();
});
