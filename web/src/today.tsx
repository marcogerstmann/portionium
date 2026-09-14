import {
  CATEGORIES,
  type Category,
  type DayResponse,
  type FoodResponse,
  type LocalDate,
  type EntryResponse,
  type MealResponse,
  type StatsWeightResponse,
  type UserResponse,
} from '@portionium/schemas';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type TouchEvent } from 'react';

import { Compose } from './compose';
import { dayLabel, mealTypeLabel, orderMeals, pageTo } from './day';
import {
  cachedDay,
  emptyDay,
  foodNames,
  localDateFor,
  refreshDay,
  refreshFoods,
  refreshRecentDays,
  type OutboxEntry,
} from './db';
import { Dot, categoryLabel, dotOf, UNCLASSIFIED, type DotCategory } from './dot';
import { useLocale, useT } from './i18n';
import {
  classifyFood,
  deleteMeal,
  discardWrite,
  foodSubject,
  logWeight,
  mealSubject,
  outbox,
  OUTBOX_CHANGED_EVENT,
  outboxState,
  restoreMeal,
  weightSubject,
} from './outbox';
import { formatKg, lastReading, spokenCounts, trendCaveat } from './stats';
import { useWeightStats } from './statistics';

/**
 * The screen the app opens on and the one somebody sees several times a day.
 *
 * One rule decides most of what follows: a day is read from the device and rendered, and the
 * server's answer replaces it whenever it arrives. There is no loading state anywhere below and
 * that is deliberate, not an omission. A spinner on launch is the thing this whole cache exists
 * to avoid, so a day that is not on the device yet renders as an empty day and fills in a moment
 * later, which is the right answer for the overwhelmingly common case of a day with nothing on
 * it and a brief understatement for the rest.
 *
 * Every write goes through ./outbox.ts and none of them are awaited for their effect. What is on
 * screen after a tap is the optimistic copy in the cache, and the refresh that follows the drain
 * replaces it with what the server actually holds. See docs/adr/010-pwa-and-offline-outbox.md.
 *
 * Composing a meal is ./compose.tsx, opened from here and rendered in place of the day. A
 * screen rather than a panel below the list, because the search field wants the keyboard and the
 * whole viewport, and because the day behind it is already showing what was just added by the
 * time it closes. What this screen owns is reading a day and the corrections that need no
 * search, deleting a meal and giving a food a colour.
 *
 * Editing a meal's items is still not here. It is the same surface as composing one, reached
 * from the meal below, and it needs PATCH /meals/{id} rather than the outbox's create path.
 */

/** An entry's colour as a dot takes it: null on the wire is a state, not a missing value. */
function dotFor(entry: EntryResponse): DotCategory {
  return dotOf(entry.category);
}

/**
 * The day at a glance: one dot per entry, in the order they were eaten.
 *
 * One dot per entry rather than a count per colour, because the shape of a day is what somebody
 * is reading here and four numbers are a score. The whole row is one image to a screen reader,
 * which gets the sentence instead, since hearing "green, green, yellow, green" fifteen times is
 * not a summary of anything.
 */
function Summary({ day }: { day: DayResponse }) {
  const t = useT();
  const locale = useLocale();

  // The same order as the rows below, so the row of dots reads left to right as the day reads
  // top to bottom. The server lists meals by when they were logged, which is usually the same
  // and is not the same the moment somebody logs a lunch after their dinner.
  const entries = orderMeals(day.meals).flatMap((meal) => meal.entries);

  if (entries.length === 0) {
    return <p className="mt-4 mb-6 text-muted">{t('todayNothingLogged')}</p>;
  }

  return (
    <p
      className="mt-4 mb-6 flex flex-wrap gap-1.5"
      role="img"
      aria-label={t('todayDayImageLabel', { summary: spokenCounts(day.colourCounts, locale) })}
    >
      {/* Silent, because the row above is already one image with the sentence. Dot rather than a
          second copy of its markup, so the shapes cannot drift between here and the meals. */}
      {entries.map((entry) => (
        <Dot key={entry.id} category={dotFor(entry)} silent />
      ))}
    </p>
  );
}

/**
 * One meal, collapsed to its type and its colours, and the control that opens it.
 *
 * The whole row is the button rather than a chevron at the end of it, which is what makes the
 * touch target the width of the screen instead of a thumb-sized corner of it.
 */
function MealRow({
  meal,
  pending,
  expanded,
  onToggle,
}: {
  meal: MealResponse;
  pending: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const locale = useLocale();

  return (
    <button type="button" className="row" aria-expanded={expanded} onClick={onToggle}>
      <span>{mealTypeLabel(meal.type, locale)}</span>

      {/* A step wider than the summary's, because these are the dots that can wear the unsent
          ring and a ring wants a little more air around it. See Dot's `pending`. */}
      <span className="flex flex-wrap justify-end gap-2">
        {meal.entries.map((entry) => (
          <Dot key={entry.id} category={dotFor(entry)} pending={pending} />
        ))}
      </span>
    </button>
  );
}

/**
 * An opened meal: what was in it, and the two things that can be done to it here.
 *
 * An entry with no colour is a button rather than a line of text, because it is the one thing on
 * this screen worth fixing in passing: the food is in front of the person who ate it, and asking
 * them then is how a catalog gets classified without anybody sitting down to a queue.
 *
 * Only an entry that names a food can be that button, and only while it is grey. A bare colour
 * names nothing to classify, and an entry that already carries a colour is history rather than a
 * question: recolouring the food behind it leaves it exactly as it is, see
 * docs/adr/011-an-entry-is-a-colour.md. Correcting one entry on its own is WEB 15.
 */
function MealDetail({
  meal,
  foods,
  pending,
  onClassify,
  onDelete,
}: {
  meal: MealResponse;
  foods: ReadonlyMap<string, FoodResponse>;
  /** The subjects still queued, so a colour given a moment ago is marked as not sent yet. */
  pending: ReadonlySet<string>;
  onClassify: (foodId: string, category: Category) => void;
  onDelete: () => void;
}) {
  const [classifying, setClassifying] = useState<string | undefined>(undefined);
  const t = useT();
  const locale = useLocale();

  return (
    <div>
      <ul className="pl-4">
        {meal.entries.map((entry) => {
          // Destructured so it narrows inside the handlers below rather than needing a cast at
          // each one: a bare entry has no food to name, to classify, or to be pending on.
          const { foodId } = entry;
          const name =
            foodId === null ? t('bareEntry') : (foods.get(foodId)?.name ?? t('todayUnknownFood'));

          return (
            <li key={entry.id}>
              {entry.category === null && foodId !== null ? (
                <button
                  type="button"
                  className="row justify-start"
                  aria-expanded={classifying === foodId}
                  onClick={() => setClassifying(classifying === foodId ? undefined : foodId)}
                >
                  <Dot category={UNCLASSIFIED} />
                  <span>{name}</span>
                  <span className="ml-auto text-sm text-muted">{t('todayClassify')}</span>
                </button>
              ) : (
                <p className="row justify-start">
                  <Dot
                    category={dotFor(entry)}
                    pending={foodId !== null && pending.has(foodSubject(foodId))}
                  />
                  <span>{name}</span>
                </p>
              )}

              {foodId !== null && classifying === foodId && (
                <p className="mb-2 flex gap-2 pl-4">
                  {CATEGORIES.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className="flex flex-1 items-center justify-center gap-2 text-sm"
                      onClick={() => {
                        setClassifying(undefined);
                        onClassify(foodId, category);
                      }}
                    >
                      <Dot category={category} />
                      <span>{categoryLabel(category)}</span>
                    </button>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        className="mt-4 flex w-full items-center justify-center gap-2 border-danger text-danger"
        onClick={onDelete}
      >
        <Trash2 aria-hidden="true" className="size-4" />
        {t('todayDeleteMeal', { mealType: mealTypeLabel(meal.type, locale) })}
      </button>
    </div>
  );
}

/**
 * The day's weight: one tap to record one, and the trend as the answer.
 *
 * What is shown back is deliberately not what was typed in. A daily weight is mostly water,
 * salt and when the last meal was, and a screen that answers a reading with that reading is the
 * one that makes a good fortnight look like a failure. So the smoothed trend is the line in
 * normal text and the reading sits under it as a footnote, which is the same ordering the
 * statistics screen is built around, see ./statistics.tsx.
 *
 * The trend is the server's, always. It arrives here from the same cached `GET /stats/weight`
 * the statistics screen reads, so a reading that has not drained yet is confirmed against the
 * trend as it stands, with the unsent mark beside it saying exactly that, and the number moves
 * once the queue empties and the outbox announces, see the sync effect in Today.
 */
function Weight({
  day,
  weight,
  pending,
  onRecord,
}: {
  day: DayResponse;
  /** The last thing the server said about the trend, or nothing on a device that never asked. */
  weight: StatsWeightResponse | undefined;
  pending: boolean;
  onRecord: (weightKg: number) => void;
}) {
  const [entering, setEntering] = useState(false);
  const t = useT();
  const locale = useLocale();

  const days = weight?.days ?? [];
  // Null rather than a number whenever the server says there is not enough behind the value to
  // stand on, which is the same judgement the statistics screen refuses to draw a line through.
  const trend = trendCaveat(days, locale) === undefined ? (days.at(-1)?.trendKg ?? null) : null;

  if (day.weightEntry !== null) {
    return (
      <p className="row">
        <span>{t('todayWeightLabel')}</span>
        {/* A column rather than a row, so the two stack against the right edge and the trend is
            plainly the line being read: the whole product principle in a flex direction. */}
        <span className="flex flex-col items-end">
          <span>
            {trend === null
              ? t('todayTrendForming')
              : t('todayTrendKg', { trend: formatKg(trend, locale) })}
          </span>
          <span className="flex items-center gap-1 text-sm text-muted">
            {formatKg(day.weightEntry.weightKg, locale)} kg{pending && <PendingMark />}
          </span>
        </span>
      </p>
    );
  }

  if (!entering) {
    return (
      <button type="button" className="row" onClick={() => setEntering(true)}>
        <span>{t('todayWeightLabel')}</span>
        <span className="flex items-center gap-1 text-sm text-muted">
          <Plus aria-hidden="true" className="size-4" />
          {t('todayAddWeight')}
        </span>
      </button>
    );
  }

  // The last thing that was actually on the scale, which on most days is within a few hundred
  // grams of what is about to be typed. Selected on focus rather than only offered, so the
  // field is both a default to accept and an empty one to type over, at no extra tap either way.
  const last = lastReading(days);

  return (
    <form
      className="row"
      onSubmit={(event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const weightKg = Number(new FormData(event.currentTarget).get('weightKg'));

        // The browser's own `required` and `min` refuse an empty or negative field and announce
        // why, so what is left to check here is that it parsed as a number at all.
        if (Number.isFinite(weightKg) && weightKg > 0) {
          setEntering(false);
          onRecord(weightKg);
        }
      }}
    >
      {/* The field and its button keep their own size inside the row: the generic column the
          login form uses is right there and wrong here, because opening this must not push
          everything under it down the screen, under a thumb that is already over the row. */}
      <label htmlFor="weightKg" className="shrink-0">
        {t('todayWeightKgLabel')}
      </label>
      <input
        id="weightKg"
        name="weightKg"
        type="number"
        inputMode="decimal"
        step="0.1"
        min="1"
        max="1000"
        required
        autoFocus
        className="min-w-0 flex-1"
        // A period decimal separator, whatever the active language: the value attribute of a
        // number input is parsed by the platform as one regardless of locale, never displayed
        // text, so this is the one number on this screen formatKg must not touch.
        defaultValue={last === undefined ? undefined : last.toFixed(1)}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button type="submit" className="shrink-0">
        {t('todaySave')}
      </button>
    </form>
  );
}

/** The unsent mark, wherever it is not a dot. Announced, for the reason Dot's `pending` is. */
function PendingMark() {
  const t = useT();

  return (
    <span role="img" aria-label={t('todayNotSentYet')}>
      <RefreshCw className="size-3.5" />
    </span>
  );
}

/**
 * The writes the server refused for good, and the only way they leave the queue.
 *
 * Shown rather than retried, because a 422 sent again is the same 422, and shown rather than
 * dropped, because what was refused is something a person typed. The server's own sentence is
 * the only part of a problem document written to be read, see ./api.ts.
 */
function Rejected({
  entries,
  onDiscard,
}: {
  entries: OutboxEntry[];
  onDiscard: (key: string) => void;
}) {
  const t = useT();

  if (entries.length === 0) {
    return null;
  }

  return (
    <section
      className="my-4 rounded-md border border-danger px-3 shadow-xs"
      aria-label={t('todayRefusedWritesLabel')}
    >
      {entries.map((entry) => (
        <p key={entry.key} className="row last:border-b-0">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-danger" />
          <span className="flex-1 text-sm">
            {t('todayNotSaved', {
              noun:
                entry.subject?.startsWith('weight:') === true
                  ? t('todayWeightEntryNoun')
                  : t('todayMealNoun'),
              date: entry.date,
              failure: entry.failure ?? '',
            })}
          </span>
          <button type="button" className="shrink-0 text-sm" onClick={() => onDiscard(entry.key)}>
            {t('todayDiscard')}
          </button>
        </p>
      ))}
    </section>
  );
}

export function Today({
  user,
  onComposingChange,
}: {
  user: UserResponse;
  /** So the tab bar in App can get out of the composer's way, see there. */
  onComposingChange: (composing: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const today = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);

  const [date, setDate] = useState<LocalDate>(today);
  // The day and the composer, rather than a boolean each: two booleans would allow a state that
  // means nothing. Statistics and Settings are no longer screens this component owns, see POR-65
  // and App; what is left here is the one thing the composer still needs to be, an overlay on
  // top of the day rather than a fourth tab.
  const [screen, setScreen] = useState<'day' | 'compose'>('day');

  useEffect(() => {
    onComposingChange(screen === 'compose');
  }, [screen, onComposingChange]);

  const [loaded, setLoaded] = useState<DayResponse | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [undoable, setUndoable] = useState<MealResponse | undefined>(undefined);
  const [queue, setQueue] = useState<{ pending: Set<string>; failed: OutboxEntry[] }>({
    pending: new Set(),
    failed: [],
  });

  // The trend behind the weight row, from the device first and the server second like everything
  // else here. `queue` is the reload trigger: the sync effect below replaces it on every outbox
  // announce, so a weight that has just drained is asked about again and the confirmation under
  // it becomes the trend that includes it. See useWeightStats.
  const { weight } = useWeightStats(today, queue);

  // Only the day that was asked for, so paging never shows the previous day's meals under the
  // new day's heading while the cache is being read.
  const day = loaded?.date === date ? loaded : emptyDay(date);

  /** Read the device's copy and then replace it with the server's, in that order. */
  const load = useCallback(async (wanted: LocalDate) => {
    const cached = await cachedDay(wanted);

    if (cached !== undefined) {
      setLoaded(cached);
    }

    const fresh = await refreshDay(wanted).catch(() => undefined);

    if (fresh !== undefined) {
      setLoaded(fresh);
    }
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  // The rest of the window, behind the day in front of the person, so paging back works with no
  // network. Once per launch: the days do not change while somebody is reading one.
  useEffect(() => {
    void refreshRecentDays(today);

    // And the catalog the composer searches when there is no network, which is the other half of
    // what the device has to hold for logging to work in a basement, see refreshFoods. Swallowed
    // for the same reason the days are: a cache that could not be warmed is the offline case.
    void refreshFoods().catch(() => undefined);
  }, [today]);

  // Both the queue's own state and the day it changed. A drain that lands re-fetches the day in
  // ./outbox.ts, so what is read back here is the server's copy rather than the optimistic one.
  useEffect(() => {
    const sync = () => {
      void outboxState().then(setQueue);
      void cachedDay(date).then((cached) => cached !== undefined && setLoaded(cached));
    };

    sync();
    outbox.addEventListener(OUTBOX_CHANGED_EVENT, sync);

    return () => outbox.removeEventListener(OUTBOX_CHANGED_EVENT, sync);
  }, [date]);

  const page = useCallback(
    (days: number) => {
      setOpened(undefined);
      setUndoable(undefined);
      setDate((current) => pageTo(current, days, today));
    },
    [today],
  );

  /** POR-66: one tap home from anywhere in the cached window, the same reset `page` does. */
  const goToday = useCallback(() => {
    setOpened(undefined);
    setUndoable(undefined);
    setDate(today);
  }, [today]);

  /**
   * Arrow keys move between days, unless something is being typed into. Without that guard a
   * left arrow inside the weight field would page the day instead of moving the caret.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      // Not while another screen is open. The composer's own arrows move through its results,
      // and a left arrow aimed at a meal type button must not page the day underneath it.
      if (screen !== 'day' || typing || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (event.key === 'ArrowLeft') {
        page(-1);
      } else if (event.key === 'ArrowRight') {
        page(1);
      }
    };

    addEventListener('keydown', onKeyDown);

    return () => removeEventListener('keydown', onKeyDown);
  }, [screen, page]);

  /**
   * Swipe, as two touch positions and a threshold, rather than a gesture library.
   *
   * The vertical comparison is what keeps it from firing on a scroll: a finger travelling mostly
   * down the screen is somebody reading, and a day that jumped every time they scrolled would be
   * worse than no swipe at all.
   */
  const swipe = useRef<{ x: number; y: number } | undefined>(undefined);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    swipe.current = touch && { x: touch.clientX, y: touch.clientY };
  };

  const onTouchEnd = (event: TouchEvent) => {
    const start = swipe.current;
    const touch = event.changedTouches[0];
    swipe.current = undefined;

    if (start === undefined || touch === undefined) {
      return;
    }

    const moved = touch.clientX - start.x;

    if (Math.abs(moved) > 60 && Math.abs(moved) > Math.abs(touch.clientY - start.y)) {
      // Left is forward, the direction a page of paper goes. A swipe left brings the next day.
      page(moved < 0 ? 1 : -1);
    }
  };

  const foods = foodNames(day);

  // After every hook, so the hook order is the same on every branch. The day behind these is
  // left mounted in state rather than unwound: closing one is a render, not a reload.
  if (screen === 'compose') {
    return <Compose user={user} date={date} onDone={() => setScreen('day')} />;
  }

  return (
    <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <header className="flex items-center justify-between gap-2">
        <h1>{dayLabel(date, today, locale)}</h1>

        {/* A calendar face rather than the word "today", so it reads as a jump home wherever the
            day label already says which day this is. Disabled rather than hidden while it is
            today, the same reasoning as the chevrons: the header must not reflow as somebody
            pages. */}
        <button
          type="button"
          className="shrink-0 disabled:text-muted"
          onClick={goToday}
          disabled={date === today}
        >
          <CalendarDays aria-hidden="true" className="size-5" />
          <span className="sr-only">{t('todayBackToToday')}</span>
        </button>
      </header>

      {/* Visually an arrow, still read aloud. `sr-only` is Tailwind's own, which is what the
          hand written `.away` was: "Previous day" beside a chevron is noise to everyone who can
          see the chevron, and the only name the control has to everyone who cannot. */}
      <nav className="mt-4 flex gap-2" aria-label={t('todayDayNav')}>
        <button
          type="button"
          className="flex flex-1 items-center justify-center disabled:text-muted"
          onClick={() => page(-1)}
          disabled={pageTo(date, -1, today) === date}
        >
          <ChevronLeft aria-hidden="true" className="size-6" />
          <span className="sr-only">{t('todayPreviousDay')}</span>
        </button>
        <button
          type="button"
          className="flex flex-1 items-center justify-center disabled:text-muted"
          onClick={() => page(1)}
          disabled={date === today}
        >
          <span className="sr-only">{t('todayNextDay')}</span>
          <ChevronRight aria-hidden="true" className="size-6" />
        </button>
      </nav>

      <Summary day={day} />

      <Rejected entries={queue.failed} onDiscard={(key) => void discardWrite(key)} />

      <button
        type="button"
        className="primary mb-2 flex items-center justify-center gap-2"
        onClick={() => setScreen('compose')}
      >
        <Plus aria-hidden="true" className="size-5" />
        {t('todayAddMeal')}
      </button>

      <section aria-label={t('todayMealsLabel')}>
        {orderMeals(day.meals).map((meal) => (
          <article key={meal.id}>
            <MealRow
              meal={meal}
              pending={queue.pending.has(mealSubject(meal.id))}
              expanded={opened === meal.id}
              onToggle={() => setOpened(opened === meal.id ? undefined : meal.id)}
            />

            {opened === meal.id && (
              <MealDetail
                meal={meal}
                foods={foods}
                pending={queue.pending}
                onClassify={(foodId, category) => void classifyFood(date, foodId, category)}
                onDelete={() => {
                  setOpened(undefined);
                  // Held for the undo, which is what puts it back: the server's delete is soft
                  // and reviving it is posting the same id again, see restoreMeal.
                  setUndoable(meal);
                  void deleteMeal(meal);
                }}
              />
            )}
          </article>
        ))}
      </section>

      {undoable !== undefined && (
        /* Its own box rather than the row the refusals are wrapped in, and in the flow rather
           than floating over the screen: a toast that fades is a control somebody has to catch,
           and this one stays until it is used or the day changes. */
        <p
          className="mt-4 flex min-h-touch items-center justify-between gap-3 rounded-md border border-line px-3 py-2 shadow-xs"
          role="status"
        >
          <span className="text-sm">
            {t('todayMealDeleted', { mealType: mealTypeLabel(undoable.type, locale) })}
          </span>
          <button
            type="button"
            className="flex shrink-0 items-center gap-2 text-sm"
            onClick={() => {
              void restoreMeal(undoable);
              setUndoable(undefined);
            }}
          >
            <Undo2 aria-hidden="true" className="size-4" />
            {t('todayUndo')}
          </button>
        </p>
      )}

      <Weight
        day={day}
        weight={weight}
        pending={queue.pending.has(weightSubject(date))}
        onRecord={(weightKg) => void logWeight(user, weightKg, date)}
      />
    </main>
  );
}
