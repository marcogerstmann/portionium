import {
  PROBLEM,
  type Category,
  type EntryInput,
  type EntryResponse,
  type FoodResponse,
  type LocalDate,
  type MealResponse,
  type MealType,
  type Timezone,
  type UpdateMealRequest,
  type UserResponse,
  type WeightEntryResponse,
} from '@portionium/schemas';
import { uuidv7 } from 'uuidv7';
import { z } from 'zod';

import { ApiError, request } from './api';
import {
  cachedDay,
  cachedFoods,
  database,
  emptyDay,
  localDateFor,
  putDay,
  refreshDay,
  withClassification,
  withMeal,
  withoutMeal,
  withoutWeight,
  withWeight,
  type OutboxEntry,
} from './db';
import { t } from './i18n';

export const outbox = new EventTarget();

export const OUTBOX_CHANGED_EVENT = 'portionium:outbox-changed';

const DRAIN_LOCK = 'portionium:outbox-drain';

export const OUTBOX_SYNC_TAG = 'portionium:outbox';
export const DRAIN_MESSAGE = 'portionium:drain';

const RETRY_BASE_MS = 1_000;

const RETRY_MAX_MS = 5 * 60 * 1_000;

export function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

export type AttemptOutcome = 'sent' | 'retry' | 'permanent' | 'paused';

/**
 * Reading the server's refusal. A meal id conflict is a success: the id was minted on this device,
 * so the only thing that can already hold it is an earlier attempt whose response was lost.
 */
export function classifyAttempt(cause: unknown): AttemptOutcome {
  if (!(cause instanceof ApiError)) {
    return 'retry';
  }

  const { type, status } = cause.problem;

  if (type === PROBLEM.mealIdConflict) {
    return 'sent';
  }

  if (type === PROBLEM.unauthenticated) {
    return 'paused';
  }

  if (type === PROBLEM.idempotencyRequestInProgress || status === 429 || status >= 500) {
    return 'retry';
  }

  return 'permanent';
}

export function instantFor(date: LocalDate, timezone: Timezone, boundaryHour: number): Date {
  const now = new Date();

  if (localDateFor(now, timezone, boundaryHour) === date) {
    return now;
  }

  return zonedInstant(date, boundaryHour, timezone);
}

function zonedInstant(date: LocalDate, hour: number, timezone: Timezone): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);

  return new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60_000);
}

function offsetMinutes(instant: Date, timezone: Timezone): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);

  const wallClockAsUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );

  return (wallClockAsUtc - instant.getTime()) / 60_000;
}

export type ComposedEntry = FoodResponse | Category;

export async function logMeal(
  user: UserResponse,
  meal: { type: MealType; entries: readonly ComposedEntry[]; notes?: string },
  date: LocalDate,
): Promise<MealResponse> {
  const loggedAt = instantFor(date, user.timezone, user.dayBoundaryHour);

  const optimistic: MealResponse = {
    id: uuidv7(),
    userId: user.id,
    type: meal.type,
    loggedAt: loggedAt.toISOString(),
    localDate: date,
    ...(meal.notes === undefined ? {} : { notes: meal.notes }),
    entries: meal.entries.map((entry, position) => ({
      id: uuidv7(),
      foodId: typeof entry === 'string' ? null : entry.id,
      position,
      category: typeof entry === 'string' ? entry : entry.category,
    })),
  };

  await cacheLocally(date, (day) =>
    withMeal(
      day,
      optimistic,
      meal.entries.filter((entry) => typeof entry !== 'string'),
    ),
  );

  await enqueue({
    path: '/meals',
    date,
    subject: mealSubject(optimistic.id),
    body: {
      id: optimistic.id,
      type: meal.type,
      // This clock's instant, not the server's: an entry drained tomorrow morning is still a meal
      // eaten tonight, and a server-side stamp would file it under the wrong day.
      loggedAt: optimistic.loggedAt,
      entries: meal.entries.map((entry) =>
        typeof entry === 'string' ? { category: entry } : { foodId: entry.id },
      ),
      ...(meal.notes === undefined ? {} : { notes: meal.notes }),
    },
  });

  return optimistic;
}

export async function logWeight(
  user: UserResponse,
  weightKg: number,
  date: LocalDate,
): Promise<WeightEntryResponse> {
  const recordedAt = instantFor(date, user.timezone, user.dayBoundaryHour);

  const optimistic: WeightEntryResponse = {
    id: uuidv7(),
    userId: user.id,
    weightKg,
    localDate: date,
    recordedAt: recordedAt.toISOString(),
  };

  await cacheLocally(date, (day) => withWeight(day, optimistic));

  await enqueue({
    path: '/weight',
    date,
    subject: weightSubject(date),
    body: { weightKg, recordedAt: optimistic.recordedAt },
  });

  return optimistic;
}

export async function correctWeight(
  user: UserResponse,
  weightKg: number,
  date: LocalDate,
): Promise<WeightEntryResponse> {
  const recordedAt = instantFor(date, user.timezone, user.dayBoundaryHour);

  const optimistic: WeightEntryResponse = {
    id: uuidv7(),
    userId: user.id,
    weightKg,
    localDate: date,
    recordedAt: recordedAt.toISOString(),
  };

  await cacheLocally(date, (day) => withWeight(day, optimistic));

  const queued = (await database.outbox.orderBy('key').reverse().toArray()).find(
    (entry) =>
      entry.subject === weightSubject(date) &&
      entry.failure === null &&
      (entry.method ?? 'POST') !== 'DELETE',
  );
  const body = { weightKg, recordedAt: optimistic.recordedAt };

  // Zero means the drain took the entry between the read above and this write, so the correction
  // belongs behind a delete like any other.
  if (queued !== undefined && (await database.outbox.update(queued.key, { body })) > 0) {
    announce();
    void drain();

    return optimistic;
  }

  await enqueue({
    path: `/weight/${date}`,
    method: 'DELETE',
    date,
    subject: weightSubject(date),
    body: undefined,
  });

  await enqueue({ path: '/weight', date, subject: weightSubject(date), body });

  return optimistic;
}

export async function removeWeight(date: LocalDate): Promise<void> {
  await cacheLocally(date, withoutWeight);

  await enqueue({
    path: `/weight/${date}`,
    method: 'DELETE',
    date,
    subject: weightSubject(date),
    body: undefined,
  });
}

export async function deleteMeal(meal: MealResponse): Promise<void> {
  await cacheLocally(meal.localDate, (day) => withoutMeal(day, meal.id));

  await enqueue({
    path: `/meals/${meal.id}`,
    method: 'DELETE',
    date: meal.localDate,
    subject: mealSubject(meal.id),
    body: undefined,
  });
}

export async function restoreMeal(meal: MealResponse): Promise<void> {
  const known = await cachedFoods();

  await cacheLocally(meal.localDate, (day) => withMeal(day, meal, known));

  await enqueue({
    path: '/meals',
    date: meal.localDate,
    subject: mealSubject(meal.id),
    body: {
      id: meal.id,
      type: meal.type,
      loggedAt: meal.loggedAt,
      entries: meal.entries.map((entry) =>
        entry.foodId === null ? { category: entry.category } : { foodId: entry.foodId },
      ),
      ...(meal.notes === undefined ? {} : { notes: meal.notes }),
    },
  });
}

export async function repeatMeal(
  user: UserResponse,
  meal: MealResponse,
  date: LocalDate,
  foods: ReadonlyMap<string, FoodResponse>,
): Promise<void> {
  const optimistic: MealResponse = {
    id: uuidv7(),
    userId: user.id,
    type: meal.type,
    loggedAt: instantFor(date, user.timezone, user.dayBoundaryHour).toISOString(),
    localDate: date,
    entries: meal.entries.map((entry, position) => ({
      id: uuidv7(),
      foodId: entry.foodId,
      position,
      category:
        entry.foodId === null ? entry.category : (foods.get(entry.foodId)?.category ?? null),
    })),
  };

  await cacheLocally(date, (day) => withMeal(day, optimistic, [...foods.values()]));

  await enqueue({
    path: '/meals',
    date,
    subject: mealSubject(optimistic.id),
    body: {
      id: optimistic.id,
      type: meal.type,
      loggedAt: optimistic.loggedAt,
      fromMealId: meal.id,
    },
  });
}

export async function editMeal(
  meal: MealResponse,
  changes: Omit<UpdateMealRequest, 'loggedAt'>,
  foods: readonly FoodResponse[],
): Promise<void> {
  await cacheLocally(meal.localDate, (day) => withMeal(day, meal, foods));

  const queued = (await database.outbox.orderBy('key').reverse().toArray()).find(
    (entry) => entry.subject === mealSubject(meal.id) && entry.failure === null,
  );

  if (queued !== undefined && (queued.method ?? 'POST') !== 'DELETE') {
    const { fromMealId, ...rest } = queued.body as Record<string, unknown>;

    const body = {
      ...rest,
      ...(changes.entries === undefined ? { fromMealId } : {}),
      ...changes,
    };

    if ((await database.outbox.update(queued.key, { body })) > 0) {
      announce();
      void drain();

      return;
    }
  }

  await enqueue({
    path: `/meals/${meal.id}`,
    method: 'PATCH',
    date: meal.localDate,
    subject: mealSubject(meal.id),
    body: changes,
  });
}

export async function recolourEntry(
  meal: MealResponse,
  entryId: string,
  category: Category,
): Promise<void> {
  const entries = meal.entries.map((entry) =>
    entry.id === entryId ? { ...entry, category } : entry,
  );

  await editMeal({ ...meal, entries }, { entries: entries.map(toEntryInput) }, []);
}

function toEntryInput(entry: EntryResponse): EntryInput {
  return {
    ...(entry.foodId === null ? {} : { foodId: entry.foodId }),
    ...(entry.category === null ? {} : { category: entry.category }),
    ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
  };
}

export async function classifyFood(
  date: LocalDate,
  foodId: string,
  category: Category,
): Promise<void> {
  await cacheLocally(date, (day) => withClassification(day, foodId, category));

  await enqueue({
    path: `/foods/${foodId}/classification`,
    method: 'PUT',
    date,
    subject: foodSubject(foodId),
    body: { category },
  });
}

export function mealSubject(mealId: string): string {
  return `meal:${mealId}`;
}

export function weightSubject(date: LocalDate): string {
  return `weight:${date}`;
}

export function foodSubject(foodId: string): string {
  return `food:${foodId}`;
}

async function cacheLocally(
  date: LocalDate,
  change: (day: ReturnType<typeof emptyDay>) => ReturnType<typeof emptyDay>,
): Promise<void> {
  await putDay(change((await cachedDay(date)) ?? emptyDay(date)));
}

async function enqueue(
  write: Pick<OutboxEntry, 'path' | 'body' | 'date'> &
    Partial<Pick<OutboxEntry, 'method' | 'subject'>>,
): Promise<void> {
  await database.outbox.add({
    ...write,
    key: uuidv7(),
    attempts: 0,
    nextAttemptAt: 0,
    failure: null,
  });

  announce();

  void drain();
}

export async function drain(): Promise<number> {
  const locks = navigator.locks as LockManager | undefined;

  if (locks === undefined) {
    return sendDue();
  }

  // `ifAvailable`: another tab holding the lock is already draining this queue.
  const sent = await locks.request(DRAIN_LOCK, { ifAvailable: true }, async (lock) =>
    lock === null ? undefined : sendDue(),
  );

  return sent ?? 0;
}

type Stall = 'backoff' | 'paused';

async function sendDue(): Promise<number> {
  const queued = await database.outbox.orderBy('key').toArray();
  const now = Date.now();
  const changed = new Set<LocalDate>();
  let stalled: Stall | undefined;
  let attempted = false;

  for (const entry of queued) {
    if (entry.failure !== null) {
      continue;
    }

    if (entry.nextAttemptAt > now) {
      stalled = 'backoff';
      break;
    }

    const outcome = await attempt(entry);
    attempted = true;

    if (outcome === 'sent') {
      changed.add(entry.date);
      continue;
    }

    if (outcome !== 'permanent') {
      stalled = outcome === 'paused' ? 'paused' : 'backoff';
      break;
    }
  }

  for (const date of changed) {
    await refreshDay(date).catch(() => undefined);
  }

  if (stalled === 'backoff') {
    await scheduleNextAttempt();
  } else {
    clearTimeout(wake);
  }

  if (attempted) {
    announce();
  }

  return changed.size;
}

async function attempt(entry: OutboxEntry): Promise<AttemptOutcome> {
  let outcome: AttemptOutcome;
  let detail = '';

  try {
    await request(entry.path, z.unknown(), {
      // POST for an entry queued before `method` existed, which is every entry an older app wrote.
      method: entry.method ?? 'POST',
      body: entry.body,
      idempotencyKey: entry.key,
    });

    outcome = 'sent';
  } catch (cause) {
    outcome = classifyAttempt(cause);
    detail = cause instanceof ApiError ? cause.problem.detail : t('outboxWriteFailed');
  }

  if (outcome === 'sent') {
    await database.outbox.delete(entry.key);
  } else if (outcome === 'permanent') {
    await database.outbox.update(entry.key, { failure: detail });
  } else if (outcome === 'retry') {
    const attempts = entry.attempts + 1;

    await database.outbox.update(entry.key, {
      attempts,
      nextAttemptAt: Date.now() + backoffMs(attempts),
    });

    // Best effort. The timer and the visibility trigger cover every browser on their own.
    void requestBackgroundSync();
  }

  return outcome;
}

let wake: ReturnType<typeof setTimeout> | undefined;

/**
 * The head of the queue rather than the earliest time in it: the drain stops at the first entry
 * that is not due.
 */
async function scheduleNextAttempt(): Promise<void> {
  const head = (await database.outbox.orderBy('key').toArray()).find(
    (entry) => entry.failure === null,
  );

  clearTimeout(wake);

  if (head === undefined) {
    return;
  }

  wake = setTimeout(() => void drain(), Math.max(0, head.nextAttemptAt - Date.now()));
}

/** Not in lib.dom: Background Sync is Chromium only. */
interface BackgroundSyncRegistration extends ServiceWorkerRegistration {
  sync?: { register: (tag: string) => Promise<void> };
}

async function requestBackgroundSync(): Promise<void> {
  try {
    const registration: BackgroundSyncRegistration | undefined =
      await navigator.serviceWorker?.ready;

    await registration?.sync?.register(OUTBOX_SYNC_TAG);
  } catch {
    // No service worker, no Background Sync, or permission refused. All three are fine.
  }
}

export async function pendingCount(): Promise<number> {
  return database.outbox.filter((entry) => entry.failure === null).count();
}

export async function outboxState(): Promise<{ pending: Set<string>; failed: OutboxEntry[] }> {
  const queued = await database.outbox.orderBy('key').toArray();

  return {
    pending: new Set(
      queued.flatMap((entry) =>
        entry.failure === null && entry.subject !== undefined ? [entry.subject] : [],
      ),
    ),
    failed: queued.filter((entry) => entry.failure !== null),
  };
}

export async function failedWrites(): Promise<OutboxEntry[]> {
  return (await database.outbox.orderBy('key').toArray()).filter((entry) => entry.failure !== null);
}

export async function discardWrite(key: string): Promise<void> {
  await database.outbox.delete(key);

  announce();
}

function announce(): void {
  outbox.dispatchEvent(new Event(OUTBOX_CHANGED_EVENT));
}

export function startDraining(): void {
  addEventListener('online', () => void drain());

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void drain();
    }
  });

  navigator.serviceWorker?.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.data === DRAIN_MESSAGE) {
      void drain();
    }
  });

  void drain();
}
