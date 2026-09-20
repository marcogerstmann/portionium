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

function dotFor(entry: EntryResponse): DotCategory {
  return dotOf(entry.category);
}

function Summary({ day }: { day: DayResponse }) {
  const t = useT();
  const locale = useLocale();

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
      {entries.map((entry) => (
        <Dot key={entry.id} category={dotFor(entry)} silent />
      ))}
    </p>
  );
}

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

      <span className="flex flex-wrap justify-end gap-2">
        {meal.entries.map((entry) => (
          <Dot key={entry.id} category={dotFor(entry)} pending={pending} />
        ))}
      </span>
    </button>
  );
}

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
  pending: ReadonlySet<string>;
  onClassify: (foodId: string, category: Category) => void;
  onRecolour: (entryId: string, category: Category) => void;
  onEdit: () => void;
  onRepeat: () => void;
  onDelete: () => void;
}) {
  // By entry id rather than food id: two entries can name one food and only one was tapped.
  const [asking, setAsking] = useState<string | undefined>(undefined);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const t = useT();
  const locale = useLocale();

  return (
    <div>
      <ul className="pl-4">
        {meal.entries.map((entry) => {
          const { foodId } = entry;
          const name =
            foodId === null ? t('bareEntry') : (foods.get(foodId)?.name ?? t('todayUnknownFood'));
          const open = asking === entry.id;
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

function Weight({
  day,
  weight,
  pending,
  onRecord,
  onCorrect,
  onRemove,
}: {
  day: DayResponse;
  weight: StatsWeightResponse | undefined;
  pending: boolean;
  onRecord: (weightKg: number) => void;
  onCorrect: (weightKg: number) => void;
  onRemove: () => void;
}) {
  const [entering, setEntering] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const t = useT();
  const locale = useLocale();

  const days = weight?.days ?? [];
  const trend = trendCaveat(days, locale) === undefined ? (days.at(-1)?.trendKg ?? null) : null;

  if (entering) {
    const prefill = day.weightEntry?.weightKg ?? lastReading(days);

    return (
      <form
        className="row"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const weightKg = Number(new FormData(event.currentTarget).get('weightKg'));

          if (Number.isFinite(weightKg) && weightKg > 0) {
            setEntering(false);
            (day.weightEntry === null ? onRecord : onCorrect)(weightKg);
          }
        }}
      >
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
          // A period decimal separator whatever the active language: the platform parses a number
          // input's value attribute as one, so formatKg must not touch this.
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

function PendingMark() {
  const t = useT();

  return (
    <span role="img" aria-label={t('todayNotSentYet')}>
      <RefreshCw className="size-3.5" />
    </span>
  );
}

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
  active: boolean;
  onComposingChange: (composing: boolean) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const today = localDateFor(new Date(), user.timezone, user.dayBoundaryHour);

  const [date, setDate] = useState<LocalDate>(today);
  const [screen, setScreen] = useState<Screen>({ kind: 'day' });

  useEffect(() => {
    onComposingChange(screen.kind === 'compose');
  }, [screen, onComposingChange]);

  const [queueChanged, setQueueChanged] = useState(0);
  const queued = useUnclassifiedCount(queueChanged);

  const [loaded, setLoaded] = useState<DayResponse | undefined>(undefined);
  const [opened, setOpened] = useState<string | undefined>(undefined);
  const [undoable, setUndoable] = useState<MealResponse | undefined>(undefined);
  const [queue, setQueue] = useState<{ pending: Set<string>; failed: OutboxEntry[] }>({
    pending: new Set(),
    failed: [],
  });

  const { weight } = useWeightStats(today, queue);

  const day = loaded?.date === date ? loaded : emptyDay(date);

  // A ref rather than a dependency, so `load`'s identity stays stable while it can still tell a
  // stale call from a current one.
  const wantedDate = useRef(date);
  wantedDate.current = date;

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

  useEffect(() => {
    if (active) {
      void load(date);
    }
  }, [date, load, active]);

  useEffect(() => {
    void refreshRecentDays(today);

    void refreshFoods().catch(() => undefined);

    void refreshFavourites().catch(() => undefined);
    void refreshSuggestions(mealTypeAt(new Date(), user.timezone)).catch(() => undefined);
  }, [today, user.timezone]);

  useEffect(() => {
    const sync = () => {
      void outboxState().then(setQueue);
      void cachedDay(date).then((cached) => cached !== undefined && setLoaded(cached));
    };

    sync();
    outbox.addEventListener(OUTBOX_CHANGED_EVENT, sync);

    return () => outbox.removeEventListener(OUTBOX_CHANGED_EVENT, sync);
  }, [date]);

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

  const goToday = useCallback(() => {
    setOpened(undefined);
    setUndoable(undefined);
    setDate(today);
  }, [today]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

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
      page(moved < 0 ? 1 : -1);
    }
  };

  const foods = foodNames(day);

  if (screen.kind === 'compose') {
    return (
      <Compose
        user={user}
        date={date}
        {...(screen.meal === undefined ? {} : { meal: screen.meal, foods })}
        onDone={() => {
          setScreen({ kind: 'day' });
          setQueueChanged((count) => count + 1);
        }}
      />
    );
  }

  if (screen.kind === 'budgets') {
    return (
      <Budgets
        budgets={{
          green: day.budget.green.limit,
          yellow: day.budget.yellow.limit,
          orange: day.budget.orange.limit,
        }}
        onDone={(saved) => {
          setScreen({ kind: 'day' });

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

        {date !== today && (
          <button type="button" className="shrink-0" onClick={goToday}>
            <CalendarDays aria-hidden="true" className="size-5" />
            <span className="sr-only">{t('todayBackToToday')}</span>
          </button>
        )}
      </header>

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
                onRepeat={() => {
                  setOpened(undefined);
                  void repeatMeal(user, meal, date, foods);
                }}
                onDelete={() => {
                  setOpened(undefined);
                  setUndoable(meal);
                  void deleteMeal(meal);
                }}
              />
            )}
          </article>
        ))}
      </section>

      {undoable !== undefined && (
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

      {queued > 0 && (
        <button type="button" className="row" onClick={() => setScreen({ kind: 'review' })}>
          <ListChecks aria-hidden="true" className="size-4 shrink-0" />
          <span className="flex-1">{t('todayReviewQueue')}</span>
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
