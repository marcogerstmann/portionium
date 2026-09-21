import {
  CATEGORIES,
  classifyFoodResponseSchema,
  favouriteResponseSchema,
  foodResponseSchema,
  MEAL_TYPES,
  PROBLEM,
  type Category,
  type ClassifyFoodResponse,
  type EntryInput,
  type FavouriteResponse,
  type FoodResponse,
  type LocalDate,
  type MealCompositionEntryResponse,
  type MealResponse,
  type MealSuggestionResponse,
  type MealType,
  type UserResponse,
} from '@portionium/schemas';
import { Check, Sparkles, Star, X } from 'lucide-react';
import { uuidv7 } from 'uuidv7';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { mealTypeAt, mealTypeLabel } from './day';
import {
  cachedFavourites,
  cachedFoods,
  cachedSuggestions,
  refreshFavourites,
  refreshSuggestions,
} from './db';
import { categoryLabel, Dot, dotOf } from './dot';
import { isNewName, matchFoods, normalizeName } from './food-search';
import { useLocale, useT } from './i18n';
import { classifyFood, editMeal, logMeal, type ComposedEntry } from './outbox';

const SEARCH_DEBOUNCE_MS = 200;

/**
 * An instance with no key refuses every text the same way, and a key is not added while the app is
 * open, so one refusal is the whole answer for this session.
 */
let classifierOffered = true;

const SEARCH_LIMIT = 20;

const searchResponseSchema = z.array(foodResponseSchema);

const NOTES_MAX_LENGTH = 2000;

function MealTypes({ chosen, onChoose }: { chosen: MealType; onChoose: (type: MealType) => void }) {
  const t = useT();
  const locale = useLocale();

  return (
    <div className="my-4 flex gap-2" role="group" aria-label={t('composeMealTypeGroup')}>
      {MEAL_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          aria-pressed={type === chosen}
          className="flex-1 px-1 text-sm aria-pressed:border-brand aria-pressed:bg-brand aria-pressed:font-bold aria-pressed:text-on-colour"
          onClick={() => onChoose(type)}
        >
          {mealTypeLabel(type, locale)}
        </button>
      ))}
    </div>
  );
}

function CompositionPreview({ entries }: { entries: readonly MealCompositionEntryResponse[] }) {
  const t = useT();

  return (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
      {entries.map((entry, index) => (
        <span key={index} className="inline-flex items-center gap-1">
          <Dot category={dotOf(entry.category)} silent />
          {entry.foodName ?? t('bareEntry')}
        </span>
      ))}
    </span>
  );
}

function composedInput(entry: ComposedEntry): EntryInput {
  return typeof entry === 'string'
    ? { category: entry }
    : { foodId: entry.id, ...(entry.category === null ? {} : { category: entry.category }) };
}

function composedFrom(
  meal: MealResponse,
  foods: ReadonlyMap<string, FoodResponse>,
  unknownName: string,
): ComposedEntry[] {
  return meal.entries.map((entry) => {
    const { foodId } = entry;

    if (foodId === null) {
      return entry.category ?? 'green';
    }

    const food = foods.get(foodId) ?? {
      id: foodId,
      name: unknownName,
      kind: 'ingredient' as const,
    };

    return { ...food, category: entry.category };
  });
}

function fromComposition(
  entries: readonly MealCompositionEntryResponse[],
  unknownName: string,
): ComposedEntry[] {
  return entries.map((entry) =>
    entry.foodId === undefined
      ? (entry.category ?? 'green')
      : {
          id: entry.foodId,
          name: entry.foodName ?? unknownName,
          kind: 'ingredient' as const,
          category: entry.category,
        },
  );
}

export function Compose({
  user,
  date,
  meal,
  foods,
  onDone,
}: {
  user: UserResponse;
  date: LocalDate;
  meal?: MealResponse;
  foods?: ReadonlyMap<string, FoodResponse>;
  onDone: () => void;
}) {
  const t = useT();
  const locale = useLocale();

  // Once, on mount, so this stays what the edit is compared against while `chosen` moves.
  const [initial] = useState<ComposedEntry[]>(() =>
    meal === undefined ? [] : composedFrom(meal, foods ?? new Map(), t('todayUnknownFood')),
  );

  const [type, setType] = useState<MealType>(
    () => meal?.type ?? mealTypeAt(new Date(), user.timezone),
  );
  const [chosen, setChosen] = useState<ComposedEntry[]>(initial);
  const [notes, setNotes] = useState(meal?.notes ?? '');
  const [query, setQuery] = useState('');
  const [cached, setCached] = useState<FoodResponse[]>([]);
  const [results, setResults] = useState<FoodResponse[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<{ text: string; answer?: ClassifyFoodResponse } | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const [favourites, setFavourites] = useState<FavouriteResponse[]>([]);
  const [suggestions, setSuggestions] = useState<MealSuggestionResponse[]>([]);
  const [pinning, setPinning] = useState(false);
  const [favouriteName, setFavouriteName] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void cachedFoods().then((foods) => {
      setCached(foods);
      setResults((current) => (current.length === 0 ? foods : current));
    });
  }, []);

  useEffect(() => {
    if (meal !== undefined) {
      return;
    }

    void cachedFavourites().then(setFavourites);
    void refreshFavourites()
      .then(setFavourites)
      .catch(() => undefined);
  }, [meal]);

  useEffect(() => {
    if (meal !== undefined) {
      return;
    }

    let live = true;

    void cachedSuggestions(type).then((cached) => live && setSuggestions(cached));
    void refreshSuggestions(type)
      .then((fresh) => live && setSuggestions(fresh))
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [type]);

  useEffect(() => {
    let live = true;

    setResults(matchFoods(cached, query));
    setActive(0);

    const timer = setTimeout(() => {
      const url = `/foods/search?q=${encodeURIComponent(query.trim())}&limit=${SEARCH_LIMIT}`;

      void request(url, searchResponseSchema)
        .then((fresh) => live && setResults(fresh))
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, cached]);

  const trimmedNotes = notes.trim();
  const typed = query.trim();
  const creatable = isNewName(results, typed);

  // Offline the row is not offered at all: minting a food id needs the server, which is already
  // true of the plain create row.
  const askable = creatable && classifierOffered && navigator.onLine;

  // Tagged with the text it answers rather than cleared by an effect, so an answer to one word can
  // never be rendered against another.
  const suggestion = asked?.text === typed ? asked.answer : undefined;
  const asking = asked?.text === typed && asked.answer === undefined;

  const createIndex = results.length;
  const askIndex = createIndex + 1;
  const optionCount = results.length + (creatable ? 1 : 0) + (askable ? 1 : 0);

  function add(entry: ComposedEntry) {
    setChosen((current) => [...current, entry]);
    setQuery('');
    setError(undefined);
    // Keeps the caret, and on a phone the keyboard that is already up, so a three entry meal is one
    // journey to the keyboard rather than three.
    field.current?.focus();
  }

  function fill(entries: readonly MealCompositionEntryResponse[], favouriteType?: MealType) {
    setChosen(fromComposition(entries, t('todayUnknownFood')));

    if (favouriteType !== undefined) {
      setType(favouriteType);
    }

    setQuery('');
    setError(undefined);
    field.current?.focus();
  }

  /**
   * The catalog row is written here and nowhere earlier, so a suggestion the person reads and walks
   * away from leaves nothing behind. See docs/adr/011-an-entry-is-a-colour.md for the verdict.
   */
  async function create(name: string, category?: Category) {
    setBusy(true);
    setError(undefined);

    try {
      const food = await request('/foods', foodResponseSchema, { method: 'POST', body: { name } });

      add(category === undefined ? food : { ...food, category });

      if (category !== undefined) {
        void classifyFood(date, food.id, category);
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('composeCreateError'));
    } finally {
      setBusy(false);
    }
  }

  async function pin() {
    const name = favouriteName.trim();

    if (name === '') {
      return;
    }

    setPinBusy(true);
    setError(undefined);

    try {
      const favourite = await request('/meals/favourites', favouriteResponseSchema, {
        method: 'POST',
        body: { name, type, entries: chosen.map(composedInput) },
      });

      setFavourites((current) => [favourite, ...current]);
      setPinning(false);
      setFavouriteName('');
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('composeFavouritePinError'));
    } finally {
      setPinBusy(false);
    }
  }

  async function removeFavourite(id: string) {
    const previous = favourites;

    setFavourites((current) => current.filter((favourite) => favourite.id !== id));
    setError(undefined);

    try {
      await request(`/meals/favourites/${id}`, z.null(), { method: 'DELETE' });
    } catch (cause) {
      setFavourites(previous);
      setError(cause instanceof ApiError ? cause.problem.detail : t('composeFavouritePinError'));
    }
  }

  function log() {
    return logMeal(
      user,
      { type, entries: chosen, ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }) },
      date,
    );
  }

  function save(current: MealResponse) {
    const entries = chosen.map(composedInput);
    const changed = JSON.stringify(entries) !== JSON.stringify(initial.map(composedInput));

    return editMeal(
      {
        id: current.id,
        userId: current.userId,
        type,
        loggedAt: current.loggedAt,
        localDate: current.localDate,
        ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }),
        entries: chosen.map((entry, position) => ({
          id: uuidv7(),
          foodId: typeof entry === 'string' ? null : entry.id,
          position,
          category: typeof entry === 'string' ? entry : entry.category,
        })),
      },
      {
        ...(type === current.type ? {} : { type }),
        // An emptied field is sent as an empty string: omitted means "nobody touched this".
        ...(trimmedNotes === (current.notes ?? '') ? {} : { notes: trimmedNotes }),
        ...(changed ? { entries } : {}),
      },
      chosen.flatMap((entry) => (typeof entry === 'string' ? [] : [entry])),
    );
  }

  /** Reached by choosing the row and never by a keystroke: one of these is a model call. */
  async function ask() {
    const text = typed;

    setAsked({ text });
    setError(undefined);

    try {
      // Keyed by the text, so a retry of a question already answered replays rather than pays.
      const answer = await request('/foods/classify', classifyFoodResponseSchema, {
        method: 'POST',
        body: { text },
        idempotencyKey: `classify:${normalizeName(text)}`,
      });

      setAsked({ text, answer });
    } catch (cause) {
      setAsked(undefined);

      if (cause instanceof ApiError) {
        // Nothing this session will answer differently, so the row goes rather than repeat itself.
        classifierOffered = cause.problem.type !== PROBLEM.classifierUnavailable;
        setError(cause.problem.detail);
      } else {
        setError(t('composeAskError'));
      }
    }
  }

  function choose(index: number) {
    const food = results[index];

    if (food !== undefined) {
      add(food);
    } else if (index === createIndex && creatable) {
      void create(typed);
    } else if (index === askIndex && askable) {
      if (suggestion === undefined) {
        if (!asking) {
          void ask();
        }
      } else {
        void create(suggestion.name, suggestion.category);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (optionCount === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => (current + 1) % optionCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current - 1 + optionCount) % optionCount);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
  }

  function option(index: number, children: ReactNode) {
    return (
      <li
        key={index}
        id={`food-option-${index}`}
        role="option"
        aria-selected={index === active}
        className={`row cursor-pointer justify-start px-2${index === active ? ' bg-active' : ''}`}
        // Before focus can leave the field, so choosing with the mouse does not close the keyboard
        // on a phone and reopen it a moment later.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(index)}
      >
        {children}
      </li>
    );
  }

  return (
    <main>
      <header className="flex items-center justify-between gap-4">
        <h1>{meal === undefined ? t('composeTitle') : t('composeEditTitle')}</h1>
        <button type="button" className="flex shrink-0 items-center gap-2 text-sm" onClick={onDone}>
          <X aria-hidden="true" className="size-4" />
          {t('composeCancel')}
        </button>
      </header>

      <button
        type="button"
        className="primary mb-4 flex items-center justify-center gap-2 disabled:border-line disabled:bg-transparent disabled:text-muted disabled:shadow-none"
        disabled={chosen.length === 0}
        onClick={() => {
          void (meal === undefined ? log() : save(meal));
          onDone();
        }}
      >
        <Check aria-hidden="true" className="size-5" />
        {meal === undefined
          ? t('composeLog', { mealType: mealTypeLabel(type, locale) })
          : t('composeSave')}
        {chosen.length > 0 && ` · ${chosen.length}`}
      </button>

      <MealTypes chosen={type} onChoose={setType} />

      {chosen.length > 0 && (
        <ul className="mb-4" aria-label={t('composeInThisMeal')}>
          {chosen.map((entry, position) => {
            const bare = typeof entry === 'string';
            const name = bare ? t('bareEntry') : entry.name;

            return (
              // Position rather than id: one meal may name one food twice, or carry two greens.
              <li key={position} className="row justify-start">
                <Dot category={bare ? entry : dotOf(entry.category)} />
                <span>{name}</span>
                <button
                  type="button"
                  className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted"
                  onClick={() => setChosen((current) => current.filter((_, at) => at !== position))}
                >
                  <X aria-hidden="true" className="size-4" />
                  {t('composeRemove')} <span className="sr-only">{name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {chosen.length > 0 &&
        (pinning ? (
          <div className="mb-4 flex gap-2">
            <label htmlFor="favourite-name" className="sr-only">
              {t('composeFavouriteNameLabel')}
            </label>
            <input
              id="favourite-name"
              className="flex-1"
              value={favouriteName}
              maxLength={100}
              placeholder={t('composeFavouriteNameLabel')}
              autoFocus
              onChange={(event) => setFavouriteName(event.target.value)}
            />
            <button
              type="button"
              disabled={pinBusy || favouriteName.trim() === ''}
              onClick={() => void pin()}
            >
              <Check aria-hidden="true" className="size-4" />
              <span className="sr-only">{t('composeFavouritePin')}</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setPinning(false);
                setFavouriteName('');
              }}
            >
              <X aria-hidden="true" className="size-4" />
              <span className="sr-only">{t('composeFavouritePinCancel')}</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="mb-4 flex items-center gap-2 border-none bg-transparent p-0 text-sm text-muted"
            onClick={() => setPinning(true)}
          >
            <Star aria-hidden="true" className="size-4" />
            {t('composeFavouritePin')}
          </button>
        ))}

      {meal !== undefined && chosen.length === 0 && (
        <p role="alert" className="mb-4 text-danger">
          {t('composeNoEntries')}
        </p>
      )}

      <div className="mb-4 flex gap-2" role="group" aria-label={t('composeColoursLabel')}>
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className="flex flex-1 items-center justify-center gap-2 text-sm"
            onClick={() => add(category)}
          >
            <Dot category={category} silent />
            <span>{categoryLabel(category)}</span>
          </button>
        ))}
      </div>

      <label htmlFor="food" className="block">
        {t('composeAddFoodLabel')}
      </label>
      <input
        ref={field}
        id="food"
        className="w-full"
        type="search"
        role="combobox"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        aria-expanded={optionCount > 0}
        aria-controls="food-results"
        aria-autocomplete="list"
        aria-activedescendant={optionCount > 0 ? `food-option-${active}` : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />

      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {meal === undefined && typed === '' && favourites.length > 0 && (
        <section className="mb-4">
          <h2>{t('composeFavouritesLabel')}</h2>
          <ul aria-label={t('composeFavouritesLabel')}>
            {favourites.map((favourite) => (
              <li key={favourite.id} className="flex items-center gap-2 border-b border-line">
                <button
                  type="button"
                  className="flex min-h-touch flex-1 flex-col items-start gap-1 border-none bg-transparent p-2 text-left"
                  onClick={() => fill(favourite.entries, favourite.type)}
                >
                  <span className="block font-bold">{favourite.name}</span>
                  <CompositionPreview entries={favourite.entries} />
                </button>
                <button
                  type="button"
                  className="shrink-0 border-none bg-transparent p-1 text-muted"
                  aria-label={t('composeFavouriteRemove', { name: favourite.name })}
                  onClick={() => void removeFavourite(favourite.id)}
                >
                  <X aria-hidden="true" className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {meal === undefined && typed === '' && suggestions.length > 0 && (
        <section className="mb-4">
          <h2>{t('composeSuggestionsLabel')}</h2>
          <ul aria-label={t('composeSuggestionsLabel')}>
            {suggestions.map((suggestion) => (
              <li key={suggestion.mealId} className="border-b border-line">
                <button
                  type="button"
                  className="min-h-touch w-full border-none bg-transparent p-2 text-left"
                  onClick={() => fill(suggestion.entries)}
                >
                  <CompositionPreview entries={suggestion.entries} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <ul id="food-results" role="listbox" aria-label={t('composeFoodsLabel')}>
        {results.map((food, index) =>
          option(
            index,
            <>
              <Dot category={dotOf(food.category)} silent />
              <span>{food.name}</span>
            </>,
          ),
        )}

        {creatable &&
          option(
            createIndex,
            <>
              <Dot category={dotOf(null)} silent />
              <span>
                {busy ? t('composeAdding', { name: typed }) : t('composeAddAsNew', { name: typed })}
              </span>
            </>,
          )}

        {/* Once answered, the dot speaks, unlike every other row in this listbox: the colour is
            the thing being confirmed, and hue alone would leave a colour blind reader confirming
            nothing. */}
        {askable &&
          option(
            askIndex,
            suggestion === undefined ? (
              <>
                <Sparkles aria-hidden="true" className="size-5 shrink-0 text-brand" />
                <span>{asking ? t('composeAsking', { name: typed }) : t('composeAsk')}</span>
              </>
            ) : (
              <>
                <Dot category={suggestion.category} />
                <span>{t('composeAddSuggested', { name: suggestion.name })}</span>
              </>
            ),
          )}
      </ul>

      <label htmlFor="notes" className="mt-4 block">
        {t('composeNotesLabel')}
      </label>
      <textarea
        id="notes"
        className="w-full"
        rows={2}
        maxLength={NOTES_MAX_LENGTH}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />
    </main>
  );
}
