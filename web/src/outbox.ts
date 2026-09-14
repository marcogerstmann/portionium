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
 * The instant to stamp a write with, for whichever day is being viewed.
 *
 * Today needs no reconstruction: `new Date()` already falls inside today's boundaries, see
 * localDateFor, and using it verbatim is what keeps a meal's precise time meaningful. A past day
 * has no real instant to read, so this manufactures one that localDateFor's own rule (an hour at
 * or past the boundary stays on that calendar date) is guaranteed to place back on `date`: the
 * boundary hour itself, in the user's timezone.
 *
 * `zonedInstant` is the one piece of arithmetic that needs, and Intl.DateTimeFormat has no
 * reverse direction to lean on: it guesses the instant as if the wall clock read UTC and
 * corrects for whatever offset the zone actually carries there. One correction is enough for a
 * boundary hour; the only way it is wrong is a DST transition landing on this exact hour, which
 * is rare enough that a second pass is not worth carrying.
 */
export function instantFor(date: LocalDate, timezone: Timezone, boundaryHour: number): Date {
  const now = new Date();

  if (localDateFor(now, timezone, boundaryHour) === date) {
    return now;
  }

  return zonedInstant(date, boundaryHour, timezone);
}

/** The instant whose wall clock in `timezone` reads `hour`:00:00 on `date`. */
function zonedInstant(date: LocalDate, hour: number, timezone: Timezone): Date {
  const guess = new Date(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);

  return new Date(guess.getTime() - offsetMinutes(guess, timezone) * 60_000);
}

/** How far `timezone`'s wall clock at `instant` sits ahead of UTC, in minutes. */
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

/**
 * One thing the composer has picked: a catalog food, or a bare colour naming nothing.
 *
 * A union of an object and a string rather than a wrapper with a discriminant, because `Category`
 * is a string union and `typeof entry === 'string'` already narrows both halves. There is nothing
 * to carry beside a bare colour: it is the whole entry, which is the point of it.
 */
export type ComposedEntry = FoodResponse | Category;

/**
 * Log a meal. Durable when this resolves, sent whenever the network allows.
 *
 * The returned meal is what the screen renders and what goes into the cached day, ids and all.
 * It is a prediction of the row the server will hold, and every part of it is decided here: the
 * id is minted here, the local date is the one the caller is looking at, the instant is derived
 * from it rather than read off this clock, see instantFor, and the colours come from the entries
 * the caller picked.
 *
 * The whole catalog entry is taken rather than its id, which is what makes that last part true.
 * A food is chosen from a search result or from the cache, so the colour resolved for this user
 * is already in the caller's hand, and taking ids here would mean looking it up again against a
 * cache of fifty entries that a food found on the server is not necessarily in. The name comes
 * with it for the same reason: the screen renders a word next to every dot, and a day the
 * server has not answered for yet has no other source for one. See withMeal.
 *
 * A bare colour needs none of that and is the one write on this screen that can never fail for
 * want of a network: there is no id to mint at the server, so the entry the queue holds is
 * already the whole truth of it, see the refusal in `create` in ./compose.tsx.
 */
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
      // The colour the server is about to stamp, from the same resolution the search result
      // already carried, so the optimistic copy is the row that comes back. See stampEntries in
      // api/src/http/routes/meals.ts. A bare colour is stamped with itself.
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
      // The id the device chose, which is what survives a retry as the same meal rather than a
      // second one. See createMealRequestSchema, where the field exists for exactly this.
      id: optimistic.id,
      type: meal.type,
      // This clock's instant rather than the server's. An entry drained tomorrow morning is
      // still a meal eaten tonight, and letting the server stamp it on arrival would file it
      // under the wrong day.
      loggedAt: optimistic.loggedAt,
      // A food is sent as its id alone and takes the colour standing for this caller when the
      // request lands, the same rule restoreMeal follows. A colour is sent as itself, which is
      // what entryInputSchema's third combination is for.
      entries: meal.entries.map((entry) =>
        typeof entry === 'string' ? { category: entry } : { foodId: entry.id },
      ),
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

/**
 * Correct a weight already recorded for this day to a new number, and put the correction on the
 * cached day the way the server would once it drains.
 *
 * Delete then post, in that order: the superseded reading is queued for removal before the
 * corrected one is queued behind it, so the queue drains to one row for the day rather than two.
 * The queue drains in key order and a UUIDv7 sorts by the moment it was minted, so enqueueing in
 * this order is the whole of the ordering, see deleteMeal for the same trick played on a meal.
 *
 * Unless the reading being corrected has not drained yet, which `editMeal` below is the worked
 * example of: `weightSubject(date)` is already exactly the key a write is queued under, one per
 * day, so its body is rewritten in place rather than queuing a delete and a post behind it. This
 * is not an optimisation. A `DELETE /weight/{date}` for a date the server has never held a
 * reading on is a 404, which `classifyAttempt` reads as permanent, and that is what keeps a
 * correction made on a train from landing in the refused list.
 */
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

  // Zero means the drain took it between the read above and this write, so the server has the
  // superseded reading after all and the correction belongs behind a delete like any other, see
  // the same race called out on editMeal.
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

/**
 * Remove the reading recorded for this day, and put the day back to having none.
 *
 * Queued unconditionally, the same reasoning `deleteMeal` gives: a reading whose own POST has
 * not drained yet needs nothing special, since both writes are in one queue in the order they
 * were made and the server sees the create and then the delete.
 */
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

/**
 * Delete a meal, and hand back what it takes to put it back.
 *
 * The undo is the returned meal rather than anything stored here, because the server's own
 * delete is soft and reviving it is posting the same id again, see insertMeal in
 * api/src/db/meal.ts and restoreMeal below. So there is no pending-deletion timer, no window to
 * expire and nothing to lose if the app is closed mid undo: the delete is durable the moment
 * this resolves, exactly like every other write here, and undoing it is another durable write.
 *
 * A meal whose own POST has not drained yet is the interesting case and needs nothing special.
 * Both entries are in one queue in the order they were made, so the server sees the create and
 * then the delete, and ends up where the person left it.
 */
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

/**
 * Put back a meal this device deleted, which is what undo means here.
 *
 * The same id, the same instant and the same entries, so this is the row coming back rather than
 * a second meal that looks like it: the id was minted on this device in the first place and the
 * server revives its own soft deleted row for it.
 *
 * An entry naming a food is sent as that food alone and takes the colour it has now, which is
 * what every other write here does; a bare colour is sent as itself, because it has nothing
 * else to be.
 */
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

/**
 * Log a meal again, on the day it is being read on.
 *
 * The server is handed `fromMealId` and never an entry list, which is the whole point of that
 * field: the entries are already on the server, and resending them would be this device
 * deciding what was in a meal it only has a cached copy of. It is also why the two can never
 * arrive together, see the refusal in POST /meals.
 *
 * A repeat is a new write and not a copy of the old row, so the colours are resolved afresh:
 * an entry naming a food takes that food's colour as the catalog holds it now, which is what
 * `foods` carries on a day response, and a bare colour has nothing else to be. That is the
 * same rule stampEntries applies on the way in, so the optimistic copy below is the row that
 * comes back.
 *
 * The notes are deliberately not carried over. A note is about the occasion rather than about
 * the food, and repeating a meal is a statement about the food.
 */
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

/**
 * Change a meal already logged, and correct the cached day in place.
 *
 * `meal` is the row as it should now read, which the caller predicts because the caller is the
 * one that knows what changed: the composer has the foods it picked and their colours, and a
 * recolour has the entry it moved. `changes` is the wire half and carries only the fields that
 * actually differ, so an edit that touched the notes does not restamp the entry list, see the
 * comment on PATCH /meals/{id}.
 *
 * The interesting half is the coalescing. A meal edited thirty seconds after it was logged, on
 * a train, has a create still sitting in this queue, and the server holds no id to PATCH: sent
 * as a second entry it would be a 404 that leaves the meal on screen looking saved. So the edit
 * is folded into the write that has not gone yet, whichever kind it is, a create or an earlier
 * edit, and the queue stays one write per meal.
 *
 * ponytail: the coalesced entry keeps its idempotency key rather than minting a new one. If the
 * original request had in fact reached the server and only its response was lost, the retry
 * carries a different fingerprint under a used key and is refused as a mismatch, which is
 * visible in the refused list rather than silent. A new key would instead be answered with a
 * meal id conflict, which this module reads as success, and the edit would disappear. Give the
 * queue a proper supersede operation if that window ever matters.
 */
export async function editMeal(
  meal: MealResponse,
  changes: Omit<UpdateMealRequest, 'loggedAt'>,
  foods: readonly FoodResponse[],
): Promise<void> {
  await cacheLocally(meal.localDate, (day) => withMeal(day, meal, foods));

  const queued = (await database.outbox.orderBy('key').reverse().toArray()).find(
    (entry) => entry.subject === mealSubject(meal.id) && entry.failure === null,
  );

  // A queued delete is not something to fold an edit into: the meal is off the screen the edit
  // would have come from, so this is the ordinary path rather than a case to reason about.
  if (queued !== undefined && (queued.method ?? 'POST') !== 'DELETE') {
    const { fromMealId, ...rest } = queued.body as Record<string, unknown>;

    const body = {
      ...rest,
      // A repeat names an id instead of an entry list and the two together are refused, so an
      // edit that supplies entries replaces the reference rather than joining it.
      ...(changes.entries === undefined ? { fromMealId } : {}),
      ...changes,
    };

    // Zero means the drain took it between the read above and this write, so the server has it
    // after all and the edit belongs in a PATCH like any other.
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

/**
 * Change one entry's colour, from whichever day was on screen when somebody tapped a coloured
 * dot. The food is not touched and no other day moves, which is the difference between this and
 * classifyFood below: an entry is a colour and this corrects that one entry's, where a verdict
 * on a food decides every future entry of it, see docs/adr/011-an-entry-is-a-colour.md.
 *
 * The whole entry list goes back rather than the one that moved, because PATCH replaces it, and
 * each entry carries its own colour explicitly. Without that the server would resolve the
 * others afresh against the catalog as it stands, and correcting one dot would quietly recolour
 * its neighbours, which is exactly the history rewrite the ADR exists to prevent.
 */
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

/**
 * One stored entry as the wire takes it back. A colour is omitted rather than sent as null,
 * which entryInputSchema has no room for anyway: an entry still waiting for one is an entry the
 * server restamps, and restamping a waiting entry is what a user verdict would do to it too.
 */
function toEntryInput(entry: EntryResponse): EntryInput {
  return {
    ...(entry.foodId === null ? {} : { foodId: entry.foodId }),
    ...(entry.category === null ? {} : { category: entry.category }),
    ...(entry.quantity === undefined ? {} : { quantity: entry.quantity }),
  };
}

/**
 * Give a food a colour, from whichever day was on screen when somebody tapped a grey dot.
 *
 * This is the caller's own verdict, which outranks the seeded one and the model's for them and
 * for nobody else, see resolveClassification in api/src/domain/classification.ts. The optimistic
 * half changes every item on this day that names the food, so the dot, the name and the summary
 * row move together on the tap.
 *
 * Only the day in front of the person is corrected, not the other six in the cache. Their
 * refresh brings the new colour with it, and reaching across the cache to rewrite days nobody is
 * looking at would be this module deciding what the server thinks, which is the one thing it
 * must never do.
 */
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

/** How a write says what it is about, so a screen can match one against what it renders. */
export function mealSubject(mealId: string): string {
  return `meal:${mealId}`;
}

export function weightSubject(date: LocalDate): string {
  return `weight:${date}`;
}

export function foodSubject(foodId: string): string {
  return `food:${foodId}`;
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
      // POST for an entry written before the field existed, which is every entry this app
      // queued while creating was the only write it could make. See OutboxEntry.method.
      method: entry.method ?? 'POST',
      body: entry.body,
      idempotencyKey: entry.key,
    });

    outcome = 'sent';
  } catch (cause) {
    outcome = classifyAttempt(cause);
    // The API writes `detail` to be shown to a person and it is the only part safe to show,
    // see ./api.ts. Anything else that got this far has no sentence worth quoting.
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
 * What is still queued and what was refused, in one read, because a screen showing either shows
 * both and two queries over the same handful of rows is one more than the queue is worth.
 */
export async function outboxState(): Promise<{ pending: Set<string>; failed: OutboxEntry[] }> {
  const queued = await database.outbox.orderBy('key').toArray();

  return {
    // Subjects rather than entries: what a screen asks is "has this meal reached the server",
    // which is a membership test and not a list to walk per rendered row.
    pending: new Set(
      queued.flatMap((entry) =>
        entry.failure === null && entry.subject !== undefined ? [entry.subject] : [],
      ),
    ),
    failed: queued.filter((entry) => entry.failure !== null),
  };
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
