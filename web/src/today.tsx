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
  ListChecks,
  Pencil,
  Plus,
  RefreshCw,
  Repeat2,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type TouchEvent } from 'react';

import { budgetPositions, hasAnyLimit, spokenBudget } from './budget';
import { Budgets } from './budgets';
import { Compose } from './compose';
import { dayLabel, mealTypeAt, mealTypeLabel, orderMeals, pageTo } from './day';
import {
  cachedDay,
  emptyDay,
  foodNames,
  localDateFor,
  refreshDay,
  refreshFavourites,
  refreshFoods,
  refreshRecentDays,
  refreshSuggestions,
  type OutboxEntry,
} from './db';
import { Dot, categoryLabel, dotOf, type DotCategory } from './dot';
import { useLocale, useT } from './i18n';
import {
  classifyFood,
  correctWeight,
  deleteMeal,
  discardWrite,
  foodSubject,
  logWeight,
  mealSubject,
  outbox,
  OUTBOX_CHANGED_EVENT,
  outboxState,
  recolourEntry,
  removeWeight,
  repeatMeal,
  restoreMeal,
  weightSubject,
} from './outbox';
import { Review, useUnclassifiedCount } from './review';
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
 * time it closes.
 *
 * Editing a meal is the same surface as composing one, so it is ./compose.tsx opened with the
 * meal rather than a second screen, see there. What stays here are the corrections that need no
 * search: deleting a meal, logging one again, giving a colourless food a colour, and moving one
 * entry's colour.
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
 * Where the week stands against the allowance, under the day's own dots.
 *
 * Rendered from the day response and nothing else, so it costs no request: the server counts
 * the ISO week the displayed day falls in and stamps the limits beside it, which is also what
 * makes paging back show that week's position rather than this week's. See the budget field on
 * dayResponseSchema.
 *
 * Nothing is drawn at all until at least one limit is set, which is what keeps the screen
 * exactly as it was for everybody who never asked for this. There is no bar, no ring and no
 * percentage: the numbers are the whole of it, phrased as a position rather than a verdict, so
 * a week at 12 of 12 says so by being 12 of 12 and not by turning red.
 *
 * The emphasis on a category at its limit is a heavier weight and nothing else. Colour cannot
 * carry it, since every item here is already a colour and a red one would read as a fourth
 * traffic light; an icon or a capitalised word would be the telling-off this feature exists not
 * to deliver.
 *
 * One button, whose accessible name is the whole row as a sentence, with the dots and numbers
 * inside it hidden from the accessibility tree. That is the same arrangement Summary above uses
 * and for the same reason: read item by item this is "green, fourteen, yellow, seven, twelve",
 * which is not a position anybody can hold in their head.
 */
function Allowance({ day, onEdit }: { day: DayResponse; onEdit: () => void }) {
  const t = useT();
  const locale = useLocale();

  if (!hasAnyLimit(day.budget)) {
    return null;
  }

  return (
    <button
      type="button"
      className="row mb-4"
      aria-label={`${spokenBudget(day.budget, locale)} ${t('budgetRowAction')}`}
      onClick={onEdit}
    >
      <span aria-hidden="true" className="text-sm text-muted">
        {t('budgetWeekLabel')}
      </span>

      <span aria-hidden="true" className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
        {budgetPositions(day.budget).map(({ category, count, limit, atLimit }) => (
          <span key={category} className="flex items-center gap-1.5">
            <Dot category={category} silent />
            <span className={atLimit ? 'font-semibold' : undefined}>
              {limit === null ? count : `${count}/${limit}`}
            </span>
          </span>
        ))}
      </span>
    </button>
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
 * An opened meal: what was in it, and the four things that can be done to it here.
 *
 * Every entry is a button, and which question it asks depends on the colour it already carries,
 * which is the whole of docs/adr/011-an-entry-is-a-colour.md read off one row.
 *
 * A grey entry naming a food asks about the **food**: nothing has judged it, so a verdict here
 * decides every future entry of it and fills in the ones still waiting, see classifyFood. That
 * is the one thing on this screen worth fixing in passing, because the food is in front of the
 * person who ate it and asking them then is how a catalog gets classified without anybody
 * sitting down to a queue.
 *
 * A coloured entry asks about the **entry**: it is history, the food behind it is not in
 * question, and what somebody is correcting is what they ate that one time. Nothing else moves,
 * not the food and not another day, see recolourEntry. A bare colour is only ever this, since it
 * names no food to have an opinion about.
 *
 * The three meal-level controls sit under the list rather than in the row above it, where the
 * whole row is already one button. Logging it again before correcting it, because repeating is
 * the daily one and editing is the occasional one, and deleting last and alone in red.
 */
function MealDetail({
  meal,
  foods,
  pending,
  onClassify,
  onRecolour,
  onEdit,
  onRepeat,
  onDelete,
}: {
  meal: MealResponse;
  foods: ReadonlyMap<string, FoodResponse>;
  /** The subjects still queued, so a colour given a moment ago is marked as not sent yet. */
  pending: ReadonlySet<string>;
  onClassify: (foodId: string, category: Category) => void;
  onRecolour: (entryId: string, category: Category) => void;
  onEdit: () => void;
  onRepeat: () => void;
  onDelete: () => void;
}) {
  // The entry whose colour buttons are open, by entry id rather than by food id: two entries can
  // name one food and only the one that was tapped is the one being asked about.
  const [asking, setAsking] = useState<string | undefined>(undefined);
  // Whether the delete button's own confirmation is open, the same inline-ask shape as `asking`
  // above rather than a modal: this screen has no dialog primitive and nothing else here needed
  // one either.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
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
          const open = asking === entry.id;
          // Grey and naming a food is the one case that is about the catalog. Everything else is
          // about this entry alone, which includes a bare colour.
          const classifying = entry.category === null && foodId !== null;

          return (
            <li key={entry.id}>
              <button
                type="button"
                className="row justify-start"
                aria-expanded={open}
                onClick={() => setAsking(open ? undefined : entry.id)}
              >
                <Dot
                  category={dotFor(entry)}
                  pending={foodId !== null && pending.has(foodSubject(foodId))}
                />
                <span>{name}</span>
                <span className="ml-auto shrink-0 text-sm text-muted">
                  {classifying ? t('todayClassify') : t('todayRecolour')}
                </span>
              </button>

              {open && (
                <p className="mb-2 flex gap-2 pl-4">
                  {CATEGORIES.map((category) => (
                    <button
                      key={category}
                      type="button"
                      className="flex flex-1 items-center justify-center gap-2 text-sm"
                      onClick={() => {
                        setAsking(undefined);

                        if (classifying && foodId !== null) {
                          onClassify(foodId, category);
                        } else {
                          onRecolour(entry.id, category);
                        }
                      }}
                    >
                      {/* Silent: the button already says the colour, which is what Dot's
                          `silent` exists for, the same call the composer's colour row makes.
                          Announced twice these read "orange, orange". */}
                      <Dot category={category} silent />
                      <span>{categoryLabel(category)}</span>
                    </button>
                  ))}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-2"
          onClick={onRepeat}
        >
          <Repeat2 aria-hidden="true" className="size-4" />
          {t('todayRepeatMeal')}
        </button>
        <button
          type="button"
          className="flex flex-1 items-center justify-center gap-2"
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" className="size-4" />
          {t('todayEditMeal')}
        </button>
      </div>

      {confirmingDelete ? (
        <div className="mt-2">
          <p className="mb-2 text-center text-sm">
            {t('todayDeleteMealConfirm', { mealType: mealTypeLabel(meal.type, locale) })}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="flex flex-1 items-center justify-center gap-2"
              onClick={() => setConfirmingDelete(false)}
            >
              {t('todayCancel')}
            </button>
            <button
              type="button"
              className="flex flex-1 items-center justify-center gap-2 border-danger text-danger"
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" className="size-4" />
              {t('todayConfirmDelete')}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="mt-2 flex w-full items-center justify-center gap-2 border-danger text-danger"
          onClick={() => setConfirmingDelete(true)}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {t('todayDeleteMeal', { mealType: mealTypeLabel(meal.type, locale) })}
        </button>
      )}
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
  onCorrect,
  onRemove,
}: {
  day: DayResponse;
  /** The last thing the server said about the trend, or nothing on a device that never asked. */
  weight: StatsWeightResponse | undefined;
  pending: boolean;
  onRecord: (weightKg: number) => void;
  /** POR-74: the reading already on this day, replaced rather than added to. */
  onCorrect: (weightKg: number) => void;
  onRemove: () => void;
}) {
  const [entering, setEntering] = useState(false);
  // The same inline-ask shape as MealDetail's own delete confirmation, see there.
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const t = useT();
  const locale = useLocale();

  const days = weight?.days ?? [];
  // Null rather than a number whenever the server says there is not enough behind the value to
  // stand on, which is the same judgement the statistics screen refuses to draw a line through.
  const trend = trendCaveat(days, locale) === undefined ? (days.at(-1)?.trendKg ?? null) : null;

  if (entering) {
    // The reading being corrected, when there is one, rather than the last global reading: on
    // the day being corrected that last reading is the wrong number to offer. Falls back to the
    // empty row's own default otherwise, see lastReading.
    const prefill = day.weightEntry?.weightKg ?? lastReading(days);

    return (
      <form
        className="row"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const weightKg = Number(new FormData(event.currentTarget).get('weightKg'));

          // The browser's own `required` and `min` refuse an empty or negative field and
          // announce why, so what is left to check here is that it parsed as a number at all.
          if (Number.isFinite(weightKg) && weightKg > 0) {
            setEntering(false);
            (day.weightEntry === null ? onRecord : onCorrect)(weightKg);
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
          defaultValue={prefill === undefined ? undefined : prefill.toFixed(1)}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="submit" className="shrink-0">
          {t('todaySave')}
        </button>
      </form>
    );
  }

  if (day.weightEntry !== null) {
    return (
      <div className="row">
        <span>{t('todayWeightLabel')}</span>
        <span className="flex items-center gap-2">
          {/* A column rather than a row, so the two stack against the right edge and the trend
              is plainly the line being read: the whole product principle in a flex direction. A
              correction control grows the tap target beside it, never the type scale. Swapped
              for the question while confirming a removal, since the trend is not what is being
              decided right then. */}
          <span className="flex flex-col items-end">
            {confirmingRemove ? (
              <span className="text-sm">{t('todayRemoveWeightConfirm')}</span>
            ) : (
              <>
                <span>
                  {trend === null
                    ? t('todayTrendForming')
                    : t('todayTrendKg', { trend: formatKg(trend, locale) })}
                </span>
                <span className="flex items-center gap-1 text-sm text-muted">
                  {formatKg(day.weightEntry.weightKg, locale)} kg{pending && <PendingMark />}
                </span>
              </>
            )}
          </span>
          {confirmingRemove ? (
            <>
              <button type="button" className="shrink-0" onClick={() => setConfirmingRemove(false)}>
                {t('todayCancel')}
              </button>
              <button
                type="button"
                className="shrink-0 border-danger text-danger"
                onClick={() => {
                  setConfirmingRemove(false);
                  onRemove();
                }}
              >
                {t('todayConfirmRemove')}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="shrink-0" onClick={() => setEntering(true)}>
                <Pencil aria-hidden="true" className="size-4" />
                <span className="sr-only">{t('todayCorrectWeight')}</span>
              </button>
              <button type="button" className="shrink-0" onClick={() => setConfirmingRemove(true)}>
                <Trash2 aria-hidden="true" className="size-4" />
                <span className="sr-only">{t('todayRemoveWeight')}</span>
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

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

/**
 * What is in front of the person. A composer with no meal is a new one and a composer with one
 * is that meal being corrected, which is the same screen either way, see ./compose.tsx.
 */
type Screen =
  | { kind: 'day' }
  | { kind: 'compose'; meal?: MealResponse }
  | { kind: 'review' }
  | { kind: 'budgets' };

export function Today({
  user,
  active,
  onComposingChange,
}: {
  user: UserResponse;
  /**
   * Whether this tab is the one on screen. This screen stays mounted behind the other two, see
   * App, so without it a day read at sign in would still be on screen an hour and a settings
   * change later. The same reload trigger ./statistics.tsx already takes and for the same reason.
   */
  active: boolean;
  /** So the tab bar in App can get out of the composer's way, see there. */
  onComposingChange: (composing: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const today = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);

  const [date, setDate] = useState<LocalDate>(today);
  // One value rather than a boolean each: two booleans would allow a state that means nothing.
  // The composer carries the meal it is correcting for the same reason, since "composing" and
  // "which meal" are one fact and a separate `editing` beside a screen name is two halves of it
  // that can disagree. Statistics and Settings are no longer screens this component owns, see
  // POR-65 and App.
  const [screen, setScreen] = useState<Screen>({ kind: 'day' });

  useEffect(() => {
    onComposingChange(screen.kind === 'compose');
  }, [screen, onComposingChange]);

  // Bumped whenever something that changes the queue has happened behind a screen that was
  // just closed: composing can add a food with no colour, and reviewing takes them away again.
  // It is the badge's reload trigger and nothing else, see useUnclassifiedCount.
  const [queueChanged, setQueueChanged] = useState(0);
  const queued = useUnclassifiedCount(queueChanged);

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

  // A plain ref rather than a dependency `load` closes over, so `load`'s identity stays stable
  // while it can still tell a stale call from a current one, see below.
  const wantedDate = useRef(date);
  wantedDate.current = date;

  /**
   * Read the device's copy and then replace it with the server's, in that order.
   *
   * A page away while this is still in flight leaves it holding a `wanted` date that is no
   * longer `date`, and there is nothing to cancel a fetch already sent. Without the guard on
   * `wantedDate.current` below, that stale answer would still land in `setLoaded` once it
   * arrives and, since it is for a different day, silently override what the day actually being
   * looked at had just correctly loaded, until something asks for that day again. The render
   * guard two lines up only stops the two from being shown mixed together, not one clobbering
   * the other.
   */
  const load = useCallback(async (wanted: LocalDate) => {
    const cached = await cachedDay(wanted);

    if (cached !== undefined && wantedDate.current === wanted) {
      setLoaded(cached);
    }

    const fresh = await refreshDay(wanted).catch(() => undefined);

    if (fresh !== undefined && wantedDate.current === wanted) {
      setLoaded(fresh);
    }
  }, []);

  // On the day changing and on this tab becoming the visible one, never while it is hidden: a
  // limit set in Settings changes what the allowance row draws and clears the cached days behind
  // it, see invalidateDays, and coming back to a screen that still holds the old answer in state
  // is how a saved change looks like one that was not saved.
  useEffect(() => {
    if (active) {
      void load(date);
    }
  }, [date, load, active]);

  // The rest of the window, behind the day in front of the person, so paging back works with no
  // network. Once per launch: the days do not change while somebody is reading one.
  useEffect(() => {
    void refreshRecentDays(today);

    // And the catalog the composer searches when there is no network, which is the other half of
    // what the device has to hold for logging to work in a basement, see refreshFoods. Swallowed
    // for the same reason the days are: a cache that could not be warmed is the offline case.
    void refreshFoods().catch(() => undefined);

    // The composer's other two shortlists, POR-73, warmed here for the same reason: pinning or
    // removing a favourite only updates this screen's own state, not the device, so without this
    // the cache would still hold whatever the composer last saw open, offline or not. Suggestions
    // are scoped to a meal type, and the type this warms is the one the composer will open on,
    // see mealTypeAt, so a launch offline still opens the composer with something to suggest.
    void refreshFavourites().catch(() => undefined);
    void refreshSuggestions(mealTypeAt(new Date(), user.timezone)).catch(() => undefined);
  }, [today, user.timezone]);

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

  // The undo toast's own lifetime: ten seconds from whichever deletion set it, then it is gone
  // the same as if somebody had let it expire on purpose. Restarted rather than counted down
  // across renders, because `undoable` only ever changes to a new meal or back to undefined, so
  // a fresh ten seconds per meal is the only thing this effect has to express.
  useEffect(() => {
    if (undoable === undefined) {
      return;
    }

    const timer = setTimeout(() => setUndoable(undefined), 10_000);

    return () => clearTimeout(timer);
  }, [undoable]);

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
      if (screen.kind !== 'day' || typing || event.metaKey || event.ctrlKey || event.altKey) {
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
  if (screen.kind === 'compose') {
    return (
      <Compose
        user={user}
        date={date}
        {...(screen.meal === undefined ? {} : { meal: screen.meal, foods })}
        onDone={() => {
          setScreen({ kind: 'day' });
          // A food the catalog did not have was possibly just minted, and it arrived with no
          // colour, so the badge under this screen is a count that has just changed.
          setQueueChanged((count) => count + 1);
        }}
      />
    );
  }

  if (screen.kind === 'budgets') {
    return (
      <Budgets
        // The limits the day response already carried, so opening the editor costs no request
        // either. They are the same three numbers the row was just drawn from.
        budgets={{
          green: day.budget.green.limit,
          yellow: day.budget.yellow.limit,
          orange: day.budget.orange.limit,
        }}
        onDone={(saved) => {
          setScreen({ kind: 'day' });

          // Only after a save. The counts behind the row are the server's and a new limit
          // changes what it draws, so the day is read again rather than patched here.
          if (saved !== undefined) {
            void load(date);
          }
        }}
      />
    );
  }

  if (screen.kind === 'review') {
    return (
      <Review
        onDone={() => {
          setScreen({ kind: 'day' });
          // The cached day was recoloured in place by the confirmation, and the server has
          // already applied the same rule to the real one, so this reads both back in order.
          void load(date);
        }}
        onConfirmed={() => setQueueChanged((count) => count + 1)}
      />
    );
  }

  return (
    <main onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <header className="flex items-center justify-between gap-2">
        <h1>{dayLabel(date, today, locale)}</h1>

        {/* A calendar face rather than the word "today", so it reads as a jump home wherever the
            day label already says which day this is. Gone entirely on today itself: there is
            nowhere left for it to jump to, and a control with nothing to do is not a state worth
            showing. */}
        {date !== today && (
          <button type="button" className="shrink-0" onClick={goToday}>
            <CalendarDays aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('todayBackToToday')}</span>
          </button>
        )}
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

      {/* Under the day's own dots and above the one button this screen is for, so it is read on
          the way past rather than competing with logging. */}
      <Allowance day={day} onEdit={() => setScreen({ kind: 'budgets' })} />

      <Rejected entries={queue.failed} onDiscard={(key) => void discardWrite(key)} />

      <button
        type="button"
        className="primary mb-2 flex items-center justify-center gap-2"
        onClick={() => setScreen({ kind: 'compose' })}
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
                onRecolour={(entryId, category) => void recolourEntry(meal, entryId, category)}
                onEdit={() => setScreen({ kind: 'compose', meal })}
                // The day being read rather than today, the same rule every write on this screen
                // follows, see instantFor. The day's own foods are what the new entries take
                // their colours from, which is the catalog as it stands now.
                onRepeat={() => {
                  setOpened(undefined);
                  void repeatMeal(user, meal, date, foods);
                }}
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
        /* Fixed to the bottom of the viewport rather than in the flow, so it sits over whatever
           is on screen instead of shoving the weight row down the moment a meal is deleted. It
           still does not fade, it is dismissed, by ten seconds passing (see the effect above),
           by using it, or by the day changing. */
        <p
          className="fixed inset-x-6 bottom-4 z-10 mx-auto flex min-h-touch max-w-(--container-lg) items-center justify-between gap-3 rounded-md border border-line bg-background px-3 py-2 shadow-md"
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

      {/* Only while there is something in it, which is what makes it an errand that appears
          rather than a permanent row saying zero. Below the meals and above the weight, because
          it is a chore and must not compete with the one button this screen is for. */}
      {queued > 0 && (
        <button type="button" className="row" onClick={() => setScreen({ kind: 'review' })}>
          <ListChecks aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1">{t('todayReviewQueue')}</span>
          {/* The badge, and the same fact as a sentence for a reader who gets no shape from a
              pill with a number in it. */}
          <span
            aria-hidden="true"
            className="rounded-full bg-brand px-2 py-0.5 text-sm font-bold text-on-colour"
          >
            {queued}
          </span>
          <span className="sr-only">{t('todayReviewCount', { count: queued })}</span>
        </button>
      )}

      <Weight
        day={day}
        weight={weight}
        pending={queue.pending.has(weightSubject(date))}
        onRecord={(weightKg) => void logWeight(user, weightKg, date)}
        onCorrect={(weightKg) => void correctWeight(user, weightKg, date)}
        onRemove={() => void removeWeight(date)}
      />
    </main>
  );
}
