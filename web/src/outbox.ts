import {
  PROBLEM,
  type LocalDate,
  type MealResponse,
  type MealType,
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
  withMeal,
  withWeight,
  type OutboxEntry,
} from './db';

/**
 * The queue of writes that have not reached the server yet, and the routine that replays it.
 *
 * Why this exists at all, what was rejected to get here, and what this deliberately cannot do,
 * is docs/adr/010-pwa-and-offline-outbox.md. The short version is that logging a meal has to
 * work in a basement, so a write is finished the moment it is in IndexedDB, and the network is
 * something that happens to it afterwards.
 *
 * Two properties carry the whole design, and both come from ./db.ts's OutboxEntry.
 *
 * Nothing is ever lost, because a write is durable before any request is made. A tab closed
 * mid flight, a phone that runs out of battery and an app killed by the operating system all
 * leave the entry exactly where it was, and the next launch drains it.
 *
 * Nothing is ever duplicated, because every attempt at one entry is sent under the same
 * `Idempotency-Key`, minted once when the entry was made. A request that timed out after the
 * server had already committed it is the case that matters: the retry is answered from the
 * server's idempotency table and nothing runs twice, see
 * api/src/http/plugins/idempotency.ts and docs/adr/004-idempotency-keys.md.
 *
 * This is a one-directional outbox and it is not a sync engine. It sends local writes to the
 * server, and it reads the server's answer back as the truth. It never merges, never resolves
 * a conflict and never decides that the device is right.
 */

/** Where this module says something changed, following ./api.ts's `session` convention. */
export const outbox = new EventTarget();

export const OUTBOX_CHANGED_EVENT = 'portionium:outbox-changed';

/**
 * The Web Locks name the drain holds. Scoped to the origin, which is what makes it work across
 * tabs, and it is the answer to two tabs both trying to send the same entry.
 */
const DRAIN_LOCK = 'portionium:outbox-drain';

/** The Background Sync tag, and the message the service worker posts when it fires. */
export const OUTBOX_SYNC_TAG = 'portionium:outbox';
export const DRAIN_MESSAGE = 'portionium:drain';

/** The first retry waits this long, and every failure after it doubles the wait. */
const RETRY_BASE_MS = 1_000;

/**
 * The ceiling on that doubling. Five minutes, because the thing being waited out is almost
 * always a connection coming back, and `online` and `visibilitychange` will usually notice that
 * long before this timer does. This is the fallback for the case where neither fires.
 */
const RETRY_MAX_MS = 5 * 60 * 1_000;

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * ponytail: no jitter. Jitter spreads a thundering herd, and this instance serves two people on
 * their own phones, so there is no herd to spread. Add it if this ever ships to a crowd.
 */
export function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/**
 * What one attempt at one entry came to.
 *
 *   sent       the server has it, the entry is done
 *   retry      try again later, the entry stays in the queue
 *   permanent  the server refused in a way a retry cannot fix, the entry leaves the queue
 *   paused     nothing is wrong with the entry, but there is no credential to send it with
 */
export type AttemptOutcome = 'sent' | 'retry' | 'permanent' | 'paused';

/**
 * Reading the server's refusal, which is the one piece of judgement in this module.
 *
 * Getting this wrong is expensive in both directions. Treating a permanent refusal as
 * retryable means a queue that never empties and a battery spent on a request that can only
 * fail. Treating a transient one as permanent means a meal somebody logged is dropped because
 * a phone was in a lift.
 *
 * The default is therefore deliberate rather than incidental: anything that is not an
 * `ApiError` never reached the server or never came back as a problem document, which is what
 * being offline looks like, and that is the overwhelmingly common case here. It retries.
 *
 * Three of the named cases are not obvious:
 *
 *   A meal id conflict means this exact meal is already on the server. The id in the body was
 *   minted on this device, so the only thing that can already be using it is an earlier attempt
 *   at this same entry whose response never arrived, and whose idempotency key has since aged
 *   out of the server's table (see IDEMPOTENCY_RETENTION_HOURS). That is a success that looks
 *   like a failure, and treating it as one would strand the entry forever.
 *
 *   An idempotency request in progress means another copy of this request is being handled
 *   right now, which the server answers 409 to and asks the caller to retry shortly.
 *
 *   Unauthenticated is not this entry's fault. The session expired while the phone was in a
 *   pocket, or it was signed out elsewhere. Burning an attempt and a backoff on every queued
 *   entry would be wrong, so the drain stops and waits for a sign in, which ./api.ts has
 *   already announced, see UNAUTHENTICATED_EVENT.
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

  // Everything left is the server saying no about the content of this request: a validation
  // failure, a food that no longer exists, a fingerprint that does not match the key. Sending
  // the identical bytes again produces the identical refusal.
  return 'permanent';
}

/**
 * Log a meal. Durable when this resolves, sent whenever the network allows.
 *
 * The returned meal is what the screen renders and what goes into the cached day, ids and all.
 * It is a prediction of the row the server will hold, which is safe to make because everything
 * in it except the colours is decided here: the id is minted here, the instant is this clock's,
 * and the local date is derived with the same rule the server derives it with, see localDateFor.
 *
 * The colours are the one part that is a guess, taken from the cached catalog. A food that is
 * not in the cache renders as unclassified until the refresh after the drain replaces the day
 * with the server's copy, which is the correct answer arriving a moment late rather than a
 * wrong one persisting.
 */
export async function logMeal(
  user: UserResponse,
  meal: { type: MealType; foodIds: readonly string[]; notes?: string },
): Promise<MealResponse> {
  const loggedAt = new Date();
  const date = localDateFor(loggedAt, user.timezone, user.dayBoundaryHour);
  const colours = new Map((await cachedFoods()).map((food) => [food.id, food.category]));

  const optimistic: MealResponse = {
    id: uuidv7(),
    userId: user.id,
    type: meal.type,
    loggedAt: loggedAt.toISOString(),
    localDate: date,
    ...(meal.notes === undefined ? {} : { notes: meal.notes }),
    items: meal.foodIds.map((foodId, position) => ({
      id: uuidv7(),
      foodId,
      position,
      category: colours.get(foodId) ?? null,
    })),
  };

  await cacheLocally(date, (day) => withMeal(day, optimistic));

  await enqueue({
    path: '/meals',
    date,
    body: {
      // The id the device chose, which is what survives a retry as the same meal rather than a
      // second one. See createMealRequestSchema, where the field exists for exactly this.
      id: optimistic.id,
      type: meal.type,
      // This clock's instant rather than the server's. An entry drained tomorrow morning is
      // still a meal eaten tonight, and letting the server stamp it on arrival would file it
      // under the wrong day.
      loggedAt: optimistic.loggedAt,
      items: meal.foodIds.map((foodId) => ({ foodId })),
      ...(meal.notes === undefined ? {} : { notes: meal.notes }),
    },
  });

  return optimistic;
}

/**
 * Record a weight reading. The same contract as logMeal, with one difference worth knowing.
 *
 * There is no client minted id here, because POST /weight does not accept one, see
 * createWeightEntryRequestSchema. The idempotency key is therefore the only thing standing
 * between a retry and a second reading, which it is sufficient for. The id in the optimistic
 * copy below is this device's invention and is replaced by the server's on the next refresh,
 * so nothing may be stored that outlives the cache.
 */
export async function logWeight(
  user: UserResponse,
  weightKg: number,
): Promise<WeightEntryResponse> {
  const recordedAt = new Date();
  const date = localDateFor(recordedAt, user.timezone, user.dayBoundaryHour);

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
    body: { weightKg, recordedAt: optimistic.recordedAt },
  });

  return optimistic;
}

/** Apply an optimistic change to the cached day, creating the day if it was never fetched. */
async function cacheLocally(
  date: LocalDate,
  change: (day: ReturnType<typeof emptyDay>) => ReturnType<typeof emptyDay>,
): Promise<void> {
  await putDay(change((await cachedDay(date)) ?? emptyDay(date)));
}

/**
 * Append one write to the queue and try to send it straight away.
 *
 * The drain is not awaited. Awaiting it would make a caller wait on the network, which is the
 * one thing this whole module exists to avoid, and the entry is already durable by then.
 */
async function enqueue(write: Pick<OutboxEntry, 'path' | 'body' | 'date'>): Promise<void> {
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

/**
 * Send whatever is due, oldest first, and report how many entries left the queue.
 *
 * Exclusive across every tab of this origin. Without that, two open tabs both wake on `online`
 * and send the same entry, and while the idempotency key means the server still only acts once,
 * it is a request nobody needed and a 409 to interpret.
 *
 * A browser with no Web Locks runs it anyway rather than refusing to drain. The lock is an
 * optimisation over a correctness property that the idempotency key already provides on its own,
 * so losing the lock costs a wasted request and never a duplicate.
 */
export async function drain(): Promise<number> {
  const locks = navigator.locks as LockManager | undefined;

  if (locks === undefined) {
    return sendDue();
  }

  // `ifAvailable` rather than waiting: if another tab holds the lock the queue is already being
  // drained, and queueing behind it would only drain an empty queue a moment later.
  const sent = await locks.request(DRAIN_LOCK, { ifAvailable: true }, async (lock) =>
    lock === null ? undefined : sendDue(),
  );

  return sent ?? 0;
}

/**
 * Why the drain stopped before the end of the queue.
 *
 * The difference decides whether a timer is worth setting, and getting that wrong is a busy
 * loop rather than a cosmetic mistake. `backoff` means the head of the queue is waiting out a
 * failure, which is a moment in the future to wake at. `paused` means there is no usable
 * session, which no amount of waiting fixes: nothing was written, so a timer would fire
 * immediately, fail the same way and set another one, spending a battery on 401s until somebody
 * signs in. That wake-up comes from the sign in itself, see App.
 */
type Stall = 'backoff' | 'paused';

async function sendDue(): Promise<number> {
  const queued = await database.outbox.orderBy('key').toArray();
  const now = Date.now();
  const changed = new Set<LocalDate>();
  let stalled: Stall | undefined;
  let attempted = false;

  for (const entry of queued) {
    // Out of the queue and waiting for a person, see failedWrites. Skipped rather than stopped
    // on, because one rejected meal must not hold up the ones logged after it.
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

    // A permanent refusal is about this entry alone, so the queue moves on. The other two are
    // about the connection or the credential, which the entries behind this one share, and
    // trying them would spend a backoff each to learn the same thing.
    if (outcome !== 'permanent') {
      stalled = outcome === 'paused' ? 'paused' : 'backoff';
      break;
    }
  }

  // The server is the source of truth for reads, so a day this drain changed is re-fetched
  // rather than left as the optimistic copy: this is where the real ids, the real positions and
  // any colour the device guessed wrong come back. A failure here is not the write's problem,
  // the write landed, so it is swallowed and the next refresh picks it up.
  for (const date of changed) {
    await refreshDay(date).catch(() => undefined);
  }

  if (stalled === 'backoff') {
    await scheduleNextAttempt();
  } else {
    // Either the queue emptied or there is nothing a timer can do about why it did not.
    clearTimeout(wake);
  }

  if (attempted) {
    announce();
  }

  return changed.size;
}

/** One attempt at one entry, and the bookkeeping its outcome implies. */
async function attempt(entry: OutboxEntry): Promise<AttemptOutcome> {
  let outcome: AttemptOutcome;
  let detail = '';

  try {
    // The response is parsed as unknown and thrown away on purpose. What the server now holds
    // is read back by the day refresh above, so keeping a schema per path here would be a
    // second, thinner copy of the contract with nothing reading it.
    await request(entry.path, z.unknown(), {
      method: 'POST',
      body: entry.body,
      idempotencyKey: entry.key,
    });

    outcome = 'sent';
  } catch (cause) {
    outcome = classifyAttempt(cause);
    // The API writes `detail` to be shown to a person and it is the only part safe to show,
    // see ./api.ts. Anything else that got this far has no sentence worth quoting.
    detail = cause instanceof ApiError ? cause.problem.detail : 'The write could not be sent.';
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

    // Best effort, and never awaited for its effect: if the browser has Background Sync it will
    // wake the app once it is confident the connection is back, which is earlier and more
    // reliable than `online` on a phone. Correctness does not depend on it, the timer below and
    // the visibility trigger cover every browser.
    void requestBackgroundSync();
  }

  return outcome;
}

/** The timer that exists in case nothing else fires. One at a time, for the earliest entry. */
let wake: ReturnType<typeof setTimeout> | undefined;

/**
 * Wake for the head of the queue, and deliberately not for the earliest time in it.
 *
 * The drain stops at the first entry that is not due, so the head is the only entry whose time
 * means anything. Everything behind it still carries the `nextAttemptAt` of zero it was enqueued
 * with, and waking at the earliest of those would fire immediately, stall on the same head, and
 * schedule zero again.
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

/**
 * Not in lib.dom: Background Sync is implemented in Chromium and not in every engine, so
 * TypeScript does not put `sync` on a registration. Declared here rather than in a global
 * augmentation so the optionality is visible at the one place that reads it.
 */
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

/** How many writes have not reached the server. Excludes the ones waiting for a person. */
export async function pendingCount(): Promise<number> {
  return database.outbox.filter((entry) => entry.failure === null).count();
}

/**
 * The writes the server refused for good, oldest first, so a screen can say so and offer to
 * throw them away. Nothing retries these, which is the point: a queue that retries a rejected
 * request forever is a queue that never drains and a battery nobody gets back.
 */
export async function failedWrites(): Promise<OutboxEntry[]> {
  return (await database.outbox.orderBy('key').toArray()).filter((entry) => entry.failure !== null);
}

/** Throw one rejected write away. The only way an entry leaves the queue unsent. */
export async function discardWrite(key: string): Promise<void> {
  await database.outbox.delete(key);

  announce();
}

function announce(): void {
  outbox.dispatchEvent(new Event(OUTBOX_CHANGED_EVENT));
}

/**
 * Wire up every trigger, once, at startup.
 *
 * Four of them, because no single one is enough on a phone. `online` misses the case where a
 * connection was already back before the app was opened. `visibilitychange` catches the app
 * being returned to, which is when a person is most likely to be looking at what they logged.
 * The service worker message is Background Sync arriving. And the drain at the end of this
 * function is the cold launch, where the queue may have survived a restart.
 *
 * The fifth trigger is not here: a successful write drains immediately, in enqueue.
 */
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
