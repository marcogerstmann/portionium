import {
  CATEGORIES,
  type Category,
  type DayResponse,
  type FoodResponse,
  type LocalDate,
  type MealItemResponse,
  type MealResponse,
  type UserResponse,
} from '@portionium/schemas';
import { useCallback, useEffect, useRef, useState, type FormEvent, type TouchEvent } from 'react';
import { z } from 'zod';

import { request } from './api';
import { Compose } from './compose';
import { dayLabel, MEAL_TYPE_LABELS, orderMeals, pageTo } from './day';
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
import { Dot, DOTS, dotOf, UNCLASSIFIED, type DotCategory } from './dot';
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

/** An item's colour as a dot takes it: null on the wire is a state, not a missing value. */
function dotFor(item: MealItemResponse): DotCategory {
  return dotOf(item.category);
}

/**
 * The day at a glance: one dot per item, in the order they were eaten.
 *
 * One dot per item rather than a count per colour, because the shape of a day is what somebody
 * is reading here and four numbers are a score. The whole row is one image to a screen reader,
 * which gets the sentence instead, since hearing "green, green, yellow, green" fifteen times is
 * not a summary of anything.
 */
function Summary({ day }: { day: DayResponse }) {
  // The same order as the rows below, so the row of dots reads left to right as the day reads
  // top to bottom. The server lists meals by when they were logged, which is usually the same
  // and is not the same the moment somebody logs a lunch after their dinner.
  const items = orderMeals(day.meals).flatMap((meal) => meal.items);

  if (items.length === 0) {
    return <p>Nothing logged yet.</p>;
  }

  const { green, yellow, orange, unclassified } = day.colourCounts;
  const spoken = [
    `${green} green`,
    `${yellow} yellow`,
    `${orange} orange`,
    ...(unclassified > 0 ? [`${unclassified} not classified yet`] : []),
  ].join(', ');

  return (
    <p className="dots dots--summary" role="img" aria-label={`This day: ${spoken}.`}>
      {items.map((item) => (
        <span key={item.id} aria-hidden="true" className={`dot dot--${dotFor(item)}`}>
          {DOTS[dotFor(item)].letter}
        </span>
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
  return (
    <button type="button" className="row meal" aria-expanded={expanded} onClick={onToggle}>
      <span className="meal__type">{MEAL_TYPE_LABELS[meal.type]}</span>

      <span className="dots">
        {meal.items.map((item) => (
          <Dot key={item.id} category={dotFor(item)} pending={pending} />
        ))}
      </span>
    </button>
  );
}

/**
 * An opened meal: what was in it, and the two things that can be done to it here.
 *
 * An item with no colour is a button rather than a line of text, because it is the one thing on
 * this screen worth fixing in passing: the food is in front of the person who ate it, and asking
 * them then is how a catalog gets classified without anybody sitting down to a queue.
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

  return (
    <div className="meal__detail">
      <ul>
        {meal.items.map((item) => {
          const name = foods.get(item.foodId)?.name ?? 'Unknown food';

          return (
            <li key={item.id}>
              {item.category === null ? (
                <button
                  type="button"
                  className="row item"
                  aria-expanded={classifying === item.foodId}
                  onClick={() =>
                    setClassifying(classifying === item.foodId ? undefined : item.foodId)
                  }
                >
                  <Dot category={UNCLASSIFIED} />
                  <span>{name}</span>
                  <span className="hint">Classify</span>
                </button>
              ) : (
                <p className="row item">
                  <Dot category={item.category} pending={pending.has(foodSubject(item.foodId))} />
                  <span>{name}</span>
                </p>
              )}

              {classifying === item.foodId && (
                <p className="choices">
                  {CATEGORIES.map((category) => (
                    <button
                      key={category}
                      type="button"
                      onClick={() => {
                        setClassifying(undefined);
                        onClassify(item.foodId, category);
                      }}
                    >
                      <Dot category={category} />
                      <span>{DOTS[category].label}</span>
                    </button>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <button type="button" className="danger" onClick={onDelete}>
        Delete this {MEAL_TYPE_LABELS[meal.type].toLowerCase()}
      </button>
    </div>
  );
}

/**
 * The day's weight, or the way to record one.
 *
 * One number and its unit, no trend and no comparison with yesterday: the trend is the headline
 * on the statistics screen WEB 5 builds, and a delta next to a single reading is the daily noise
 * this product exists not to show.
 *
 * ponytail: a bare number field rather than the entry WEB 5 specifies, which prefills the last
 * reading and confirms with the resulting trend. Both need weight history this screen does not
 * load, so they arrive with the screen that does, and this input is what they extend.
 */
function Weight({
  day,
  pending,
  onRecord,
}: {
  day: DayResponse;
  pending: boolean;
  onRecord: (weightKg: number) => void;
}) {
  const [entering, setEntering] = useState(false);

  if (day.weightEntry !== null) {
    return (
      <p className="row">
        <span>Weight</span>
        <span>
          {day.weightEntry.weightKg.toFixed(1)} kg{pending && <PendingMark />}
        </span>
      </p>
    );
  }

  if (!entering) {
    return (
      <button type="button" className="row" onClick={() => setEntering(true)}>
        <span>Weight</span>
        <span className="hint">Add</span>
      </button>
    );
  }

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
      <label htmlFor="weightKg">Weight in kg</label>
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
      />
      <button type="submit">Save</button>
    </form>
  );
}

/** The unsent mark, wherever it is not a dot. Announced, for the reason Dot's `pending` is. */
function PendingMark() {
  return (
    <span className="pending" role="img" aria-label="not sent yet">
      {' · ↻'}
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
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="rejected" aria-label="Writes the server refused">
      {entries.map((entry) => (
        <p key={entry.key} className="row">
          <span>
            {entry.subject?.startsWith('weight:') === true ? 'A weight entry' : 'A meal'} on{' '}
            {entry.date} was not saved. {entry.failure}
          </span>
          <button type="button" onClick={() => onDiscard(entry.key)}>
            Discard
          </button>
        </p>
      ))}
    </section>
  );
}

export function Today({ user, onSignedOut }: { user: UserResponse; onSignedOut: () => void }) {
  const today = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);

  const [date, setDate] = useState<LocalDate>(today);
  const [composing, setComposing] = useState(false);
  const [loaded, setLoaded] = useState<DayResponse | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [undoable, setUndoable] = useState<MealResponse | undefined>(undefined);
  const [queue, setQueue] = useState<{ pending: Set<string>; failed: OutboxEntry[] }>({
    pending: new Set(),
    failed: [],
  });

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

  /**
   * Arrow keys move between days, unless something is being typed into. Without that guard a
   * left arrow inside the weight field would page the day instead of moving the caret.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      // Not while the composer is open. Its own arrows move through the results, and a left
      // arrow aimed at a meal type button must not page the day underneath it.
      if (composing || typing || event.metaKey || event.ctrlKey || event.altKey) {
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
  }, [composing, page]);

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

  // After every hook, so the hook order is the same on both branches. The day behind this is
  // left mounted in state rather than unwound: closing the composer is a render, not a reload.
  if (composing) {
    return <Compose user={user} onDone={() => setComposing(false)} />;
  }

  return (
    <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <header>
        <h1>{dayLabel(date, today)}</h1>
        <button
          type="button"
          onClick={() => {
            // The row is deleted server side, so the credential is dead whatever this client
            // does next. A failure here is still a sign out locally, for the same reason.
            void request('/auth/logout', z.null(), { method: 'POST' }).finally(onSignedOut);
          }}
        >
          Sign out, {user.displayName}
        </button>
      </header>

      <nav aria-label="Day">
        <button type="button" onClick={() => page(-1)} disabled={pageTo(date, -1, today) === date}>
          <span aria-hidden="true">←</span>
          <span className="away">Previous day</span>
        </button>
        <button type="button" onClick={() => page(1)} disabled={date === today}>
          <span className="away">Next day</span>
          <span aria-hidden="true">→</span>
        </button>
      </nav>

      <Summary day={day} />

      <Rejected entries={queue.failed} onDiscard={(key) => void discardWrite(key)} />

      <button
        type="button"
        className="save"
        onClick={() => {
          // A meal is stamped with this clock, so it lands on today whichever day is being read.
          // Paging first is what keeps the screen honest about where it went, rather than logging
          // to a day the person is not looking at.
          setDate(today);
          setComposing(true);
        }}
      >
        Add a meal
      </button>

      <section aria-label="Meals">
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
        <p className="row undo" role="status">
          <span>{MEAL_TYPE_LABELS[undoable.type]} deleted.</span>
          <button
            type="button"
            onClick={() => {
              void restoreMeal(undoable);
              setUndoable(undefined);
            }}
          >
            Undo
          </button>
        </p>
      )}

      <Weight
        day={day}
        pending={queue.pending.has(weightSubject(date))}
        onRecord={(weightKg) => void logWeight(user, weightKg)}
      />
    </main>
  );
}
