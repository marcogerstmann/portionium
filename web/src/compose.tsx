import {
  CATEGORIES,
  favouriteResponseSchema,
  foodResponseSchema,
  MEAL_TYPES,
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
import { Check, Star, X } from 'lucide-react';
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
import { isNewName, matchFoods } from './food-search';
import { useLocale, useT } from './i18n';
import { editMeal, logMeal, type ComposedEntry } from './outbox';

/**
 * Composing a meal, which is the interaction that decides whether this app is still in use in
 * six months. Everything below is arranged around one number: the taps between opening the app
 * and a logged three item meal.
 *
 * Three rules follow from that and explain most of the code.
 *
 * Nothing on this screen waits for the network to become useful. The search field answers from
 * ./db.ts's cached catalog on the first keystroke and the server's better answer replaces it
 * when it arrives, so a canteen with no signal is a slightly shorter list rather than a spinner.
 * Saving goes through ./outbox.ts and is durable before any request is made.
 *
 * The field keeps focus. Choosing a food adds it and puts the cursor back, so a three item meal
 * is one journey to the keyboard rather than three, and the whole flow works from the keyboard
 * alone: type, arrow down, enter, repeat.
 *
 * A colour can be logged without naming anything, which is the same rule read backwards: an
 * entry is a colour and a food is a name for one, so the three buttons below are the shortest
 * path this screen has. They are also the only write here that can never want a connection,
 * since there is no id to mint at the server, see `create`.
 *
 * There is no quantity field and there will not be one. The product's claim is that nobody
 * weighs their food; the moment portions become enterable this turns back into the calorie
 * tracker it exists to replace. `entrySchema.quantity` exists on the wire and stays unused,
 * see the note on it in packages/schemas/src/entities.ts. A bare colour is the opposite of a
 * portion rather than a step towards one.
 *
 * The same screen edits a meal already logged, opened from the day rather than from the add
 * button and told apart by nothing but the `meal` prop. A second component would be this one
 * with the combobox, the colour buttons, the type row and the keyboard handling copied, and the
 * two would drift the first time one of them was touched. What edit mode changes is where the
 * initial state comes from and what the last button does, which is two branches rather than a
 * file.
 *
 * Favourites and suggestions, POR-73, are two more shortlists ahead of the search field, cached
 * on the device the way the frequent foods list already is. Both are compositions rather than
 * history, `MealCompositionEntryResponse`, and picking either fills the composer the same way a
 * search result fills one entry: nothing here is logged until the usual button at the top is
 * pressed, so a favourite is a starting point to adjust rather than a shortcut around adjusting
 * it. They render with no lookup per food because POR-72 put `foodName` on the wire for exactly
 * that. See `CompositionPreview`, `fill` and `pin` below.
 */

/**
 * How long the field waits before asking the server.
 *
 * Long enough that typing a word is one request rather than four, short enough that it lands
 * before somebody has read the local answer and decided. The local list has already changed by
 * then, so this delay is never a delay before anything appears.
 */
const SEARCH_DEBOUNCE_MS = 200;

/** The page the server is asked for. The same cap the cache is filled to, see CACHED_FOODS. */
const SEARCH_LIMIT = 20;

const searchResponseSchema = z.array(foodResponseSchema);

/** The server's own ceiling, so the field stops where mealSchema.notes does rather than at a 400. */
const NOTES_MAX_LENGTH = 2000;

/**
 * The four types, as one tap each rather than a select.
 *
 * A native `<select>` would be fewer lines and is the wrong control: it costs a tap to open, a
 * tap to choose and a tap to dismiss on a phone, on a field that is already correct most of the
 * time. Four buttons is one tap in the case where the guess was wrong and none in the case
 * where it was right.
 */
function MealTypes({ chosen, onChoose }: { chosen: MealType; onChoose: (type: MealType) => void }) {
  const t = useT();
  const locale = useLocale();

  return (
    <div className="my-4 flex gap-2" role="group" aria-label={t('composeMealTypeGroup')}>
      {MEAL_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          // Pressed rather than a class, so the choice is in the accessibility tree and not only
          // in the styling. A screen reader says "Lunch, pressed" instead of "Lunch", and the
          // fill below is styled off the same attribute, so the two cannot disagree.
          //
          // A fill rather than only a border: a border alone is the weakest signal a design has,
          // and this is the field somebody checks at a glance before saving.
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

/**
 * A composition's entries, as a favourite or a suggestion previews them: a dot and a name per
 * entry, wrapping rather than truncating since there is no fold to protect below the field this
 * sits under. `silent`, the dots already sit beside the word they are about.
 */
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

/**
 * One composed thing as the wire takes it.
 *
 * The colour travels with the food rather than being left to the server to resolve, which is the
 * whole of what keeps an edit from rewriting history: an entry that survived the edit goes back
 * carrying the colour it was logged with, and the restamp PATCH does becomes a no-op on it, see
 * docs/adr/011-an-entry-is-a-colour.md. A newly picked food carries the colour its search result
 * showed, which is the same resolution the server is about to make anyway.
 *
 * A food still waiting for a colour sends none, because entryInputSchema has no null to send.
 * That entry is restamped, which is exactly what a verdict on the food would have done to it.
 *
 * ponytail: no quantity, because this screen has no field for one and never will, see above. An
 * entry logged with one through the MCP adapter loses it if somebody edits that meal's entry
 * list here. Carry it on ComposedEntry the day anything in this client can set one.
 */
function composedInput(entry: ComposedEntry): EntryInput {
  return typeof entry === 'string'
    ? { category: entry }
    : { foodId: entry.id, ...(entry.category === null ? {} : { category: entry.category }) };
}

/**
 * A logged meal as this screen holds it: one chosen thing per entry, in the order they were
 * eaten.
 *
 * A food carries the colour the **entry** was logged with rather than the one the catalog
 * resolves for it now, so the edit view shows the same dots the day behind it does. A food the
 * day does not name is not something this can happen for, since a day response carries every
 * food its entries reference, but a stale optimistic day could; it becomes an entry with the
 * same name the day gives it, which keeps the food id and therefore the entry.
 */
function composedFrom(
  meal: MealResponse,
  foods: ReadonlyMap<string, FoodResponse>,
  unknownName: string,
): ComposedEntry[] {
  return meal.entries.map((entry) => {
    const { foodId } = entry;

    if (foodId === null) {
      // A bare entry always carries a colour, both by entryInputSchema's refinement and by
      // stampEntries, so the fallback below is unreachable rather than a default worth choosing.
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

/**
 * A favourite or a suggestion, taken as the starting point for a new composition.
 *
 * `foodName` is what lets this build a `ComposedEntry` with no lookup, see `mealCompositionEntryResponseSchema`
 * in packages/schemas/src/api.ts. `kind` is invented, `ingredient`, the same placeholder
 * composedFrom above falls back to for a food the device has never seen: nothing here ever reads
 * it, since composedInput sends only the id and the colour back to the server.
 */
function fromComposition(
  entries: readonly MealCompositionEntryResponse[],
  unknownName: string,
): ComposedEntry[] {
  return entries.map((entry) =>
    entry.foodId === undefined
      ? // A bare entry always carries a colour, the same invariant composedFrom's fallback rests
        // on, so this is unreachable rather than a default worth choosing.
        (entry.category ?? 'green')
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
  /** The day this meal is logged for, whichever day was on screen when this opened. */
  date: LocalDate;
  /**
   * The meal being corrected, when this screen is an edit rather than a new entry. Its presence
   * is the whole of the difference: where the initial state comes from, and whether the last
   * button logs a meal or patches one.
   */
  meal?: MealResponse;
  /** The day's catalog, so an edit can render its entries as words. Only read alongside `meal`. */
  foods?: ReadonlyMap<string, FoodResponse>;
  /** Back to the day. Called whether the meal was saved or abandoned. */
  onDone: () => void;
}) {
  const t = useT();
  const locale = useLocale();

  // Once, on mount, which is what makes this the thing the edit is compared against: `chosen`
  // moves as somebody edits and this does not, so the two disagreeing is exactly "the entry list
  // changed". Both sides go through composedInput, so an untouched list compares equal whatever
  // the entries carry that this screen cannot show.
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
  const [error, setError] = useState<string | undefined>(undefined);
  const [favourites, setFavourites] = useState<FavouriteResponse[]>([]);
  const [suggestions, setSuggestions] = useState<MealSuggestionResponse[]>([]);
  const [pinning, setPinning] = useState(false);
  const [favouriteName, setFavouriteName] = useState('');
  const [pinBusy, setPinBusy] = useState(false);

  const field = useRef<HTMLInputElement>(null);

  // The device's own catalog, read once. This is what makes the field answer with no network at
  // all, and what it shows before anything has been typed, see refreshFoods.
  useEffect(() => {
    void cachedFoods().then((foods) => {
      setCached(foods);
      // Only if nothing has been typed in the meantime, so a slow IndexedDB read cannot replace
      // a list somebody is already looking at.
      setResults((current) => (current.length === 0 ? foods : current));
    });
  }, []);

  // Favourites, the same device first and then server pattern as the catalog above. Once, on
  // mount: nothing about which favourite is pinned depends on the meal type in progress, unlike
  // suggestions below, so there is nothing here that a later change to `type` should re-ask for.
  // Neither this nor suggestions below is worth asking for while editing, since neither renders
  // then, see the two sections near the bottom of this file.
  useEffect(() => {
    if (meal !== undefined) {
      return;
    }

    void cachedFavourites().then(setFavourites);
    void refreshFavourites()
      .then(setFavourites)
      .catch(() => undefined);
  }, [meal]);

  // Suggestions, scoped to whichever meal type is chosen right now, see mealSuggestionsQuerySchema.
  // Re-run when `type` changes, the same `live` guard the search effect below uses, so a slower
  // answer for a type somebody has since clicked away from cannot land after the faster one.
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

  /**
   * The device answers, then the server refines, and both are this one effect.
   *
   * The cached answer is set synchronously on every keystroke, so there is never a moment with
   * nothing on screen. The request behind it is debounced by the timer and its result is
   * discarded if the query moved on, which the cleanup does by flipping `live`: that is the same
   * mechanism covering two problems, a request per keystroke and an answer to an old query
   * arriving after a newer one.
   *
   * A failure is swallowed rather than shown. It means there is no connection, the local answer
   * is already on screen, and an error beside a list that is working is noise.
   */
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
  // The last option, offered only when nothing on screen already means this. See isNewName.
  const creatable = isNewName(results, typed);
  const optionCount = results.length + (creatable ? 1 : 0);

  function add(entry: ComposedEntry) {
    setChosen((current) => [...current, entry]);
    setQuery('');
    setError(undefined);
    // The whole reason a three entry meal is one journey to the keyboard. React has just
    // re-rendered the field with an empty value and it is still the same element, so this keeps
    // the caret and, on a phone, the keyboard that is already up. A colour button goes through
    // here too, which is what puts focus back on the field after a tap that never touched it.
    field.current?.focus();
  }

  /**
   * A favourite or a suggestion, taken as the composition to start from.
   *
   * Replaces `chosen` rather than appending to it, which is the whole of "fills the composer":
   * this is a preset offered instead of a search, and adjusting a half-built meal to match one
   * is more taps than starting from it and removing what does not belong. A favourite carries its
   * own type, since it was pinned for one, and taking it moves the meal type row along with the
   * entries; a suggestion needs no such move, it was asked for in the type already chosen.
   */
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
   * Add a food the catalog does not have, with nothing but a name.
   *
   * `kind` is left to its default and no colour is sent, which is what puts the entry in the
   * review queue rather than anywhere else: a food with no verdict resolves to no colour and
   * shows up in GET /foods/unclassified for everybody, see the classification rules in
   * api/src/http/routes/foods.ts. Nothing here asks a model anything, so this is one round trip
   * to a database insert and never a wait on a classifier.
   *
   * The one thing on this screen that needs a connection, because the id has to come from the
   * server: POST /foods mints it and the request schema has no field to offer one. A meal
   * references a food by id, so there is nothing to queue offline. The refusal says so.
   */
  async function create(name: string) {
    setBusy(true);
    setError(undefined);

    try {
      // Sent without an idempotency key on purpose, the same rule ./api.ts states: this is a
      // call a person is waiting on rather than one anything retries. Sending it twice is
      // harmless anyway, the server answers the second with the entry the first made.
      add(await request('/foods', foodResponseSchema, { method: 'POST', body: { name } }));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('composeCreateError'));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Pin what is currently composed as a named favourite.
   *
   * Sent without an idempotency key, the same rule `create` above states: this is a call a
   * person is waiting on and not one anything retries. `favouriteHasNoEntries` is the server's
   * name for the one case the disabled state of the button already prevents, see the pin button
   * below, so a refusal here can only be that race and is shown the same way `create`'s is.
   */
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

  /**
   * Unpin a favourite. Removed from the list the moment it is tapped rather than after the
   * response, the same optimism the day screen's delete uses, and put back if the server refused.
   */
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

  /** A new meal. Durable the moment ./outbox.ts has it, see logMeal. */
  function log() {
    return logMeal(
      user,
      { type, entries: chosen, ...(trimmedNotes === '' ? {} : { notes: trimmedNotes }) },
      date,
    );
  }

  /**
   * A meal already logged, as a PATCH carrying only the fields that actually differ.
   *
   * The entry list is the one worth leaving out: PATCH restamps whatever list it is sent, so an
   * edit that only moved the meal from lunch to dinner must not resend the entries, or a food
   * recoloured since would drag the day it was eaten on with it. What is left out is also what
   * survives: an entry's quantity, which this screen has no way to show, see composedInput.
   *
   * The optimistic copy is predicted here rather than in ./outbox.ts, because this is the half
   * that knows what was picked. Fresh entry ids because the server mints fresh ones too, see
   * updateMeal in api/src/db/meal.ts, and the refresh behind the drain replaces them anyway.
   */
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
        // An emptied field is sent as an empty string rather than omitted, because omitted is
        // what "nobody touched this" means on a PATCH, see applyMealChanges.
        ...(trimmedNotes === (current.notes ?? '') ? {} : { notes: trimmedNotes }),
        ...(changed ? { entries } : {}),
      },
      chosen.flatMap((entry) => (typeof entry === 'string' ? [] : [entry])),
    );
  }

  /** Take the option at this index, whichever kind it is. */
  function choose(index: number) {
    const food = results[index];

    if (food !== undefined) {
      add(food);
    } else if (creatable) {
      void create(typed);
    }
  }

  /**
   * The keyboard half of the combobox, which is the whole of desktop operation: type, arrow
   * down, enter, repeat, without the hand leaving the keys.
   *
   * The arrows wrap rather than stopping at the ends, so holding one never gets stuck, and
   * Enter is prevented from submitting the form around this, which would save a half composed
   * meal on the keystroke that was meant to add a food to it.
   */
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

  /**
   * One option, whether it is a catalog entry or the offer to make one.
   *
   * A function that returns the element rather than a component declared in here. A component
   * declared during a render is a new type on every render, so React would unmount and remount
   * the whole list on each keystroke, and a row replaced between mousedown and mouseup is a row
   * whose click never arrives.
   */
  function option(index: number, children: ReactNode) {
    return (
      <li
        key={index}
        id={`food-option-${index}`}
        role="option"
        aria-selected={index === active}
        className={`row cursor-pointer justify-start px-2${index === active ? ' bg-active' : ''}`}
        // Before focus can leave the field, so choosing with the mouse does not close the
        // keyboard on a phone and reopen it a moment later.
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

      {/* At the top rather than under everything this screen can grow, the search results, the
          favourites and suggestions lists, the notes field: the tap that ends this screen must
          not need a scroll to reach it, on a phone least of all. */}
      <button
        type="button"
        className="primary mb-4 flex items-center justify-center gap-2 disabled:border-line disabled:bg-transparent disabled:text-muted disabled:shadow-none"
        // An empty meal is refused by the server as a domain invariant, see createMeal. Refusing
        // it here means nobody finds that out from a queue entry that could never be sent.
        disabled={chosen.length === 0}
        onClick={() => {
          // Not awaited, and that is the contract: the write is durable once ./outbox.ts has it
          // in IndexedDB, and the day behind this screen already shows it.
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
            // A bare colour is its dot and a neutral word, the same sentence the day gives it,
            // see MealDetail in ./today.tsx. There is no name to render because there is no food.
            const bare = typeof entry === 'string';
            const name = bare ? t('bareEntry') : entry.name;

            return (
              // Position rather than id, because one meal may legitimately name one food twice,
              // or carry two greens, and React needs the rows to be different things.
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

      {/* Only once there is something to name. The disabled state stands in for the check the
          server would otherwise answer with favouriteHasNoEntries, see `pin`. */}
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

      {/* An empty meal is a domain invariant the server refuses, and removing the last entry is
          something somebody does by accident on this screen rather than on purpose. Said here,
          beside the list it is about, rather than left to come back as a refused write in a list
          of refused writes an hour later. The button above is disabled to match. */}
      {meal !== undefined && chosen.length === 0 && (
        <p role="alert" className="mb-4 text-danger">
          {t('composeNoEntries')}
        </p>
      )}

      {/* Above the field rather than under the results, because one tap is the whole claim: a
          colour is what this app records and naming it is the optional part. Three buttons in
          the document before the combobox, so the only keyboard cost is one Shift+Tab and `add`
          hands focus straight back to the field afterwards. */}
      <div className="mb-4 flex gap-2" role="group" aria-label={t('composeColoursLabel')}>
        {CATEGORIES.map((category) => (
          <button
            key={category}
            type="button"
            className="flex flex-1 items-center justify-center gap-2 text-sm"
            onClick={() => add(category)}
          >
            {/* Silent: the button already says the colour, and announcing it twice is what
                Dot's `silent` exists for. */}
            <Dot category={category} silent />
            <span>{categoryLabel(category)}</span>
          </button>
        ))}
      </div>

      {/* A block of its own rather than a label sitting beside the input. A `label` is inline by
          default, which would put the two on one line and leave the field as wide as its default
          size rather than as wide as the results underneath it. */}
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
        // No spelling correction and no capitalisation. A phone that helpfully capitalises or
        // rewrites a half typed food name is a phone fighting the search index.
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        // On mount, which is the tap that opened this screen, so the keyboard comes up without a
        // second one. Every later focus is add() putting the caret back.
        autoFocus
        aria-expanded={optionCount > 0}
        aria-controls="food-results"
        aria-autocomplete="list"
        aria-activedescendant={optionCount > 0 ? `food-option-${active}` : undefined}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />

      {/* Always in the tree, so a screen reader announces a refusal rather than having to look
          again on the off chance. See the same pattern on the login form. */}
      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {/* Below the field rather than above it, so neither list can push the field itself out of
          reach: nothing above here changes size because of what is below. Both are gone once
          somebody is typing, when the field's own results take over, and gone entirely while
          editing: a preset is a starting point for a new meal, and correcting one already logged
          is a statement about that meal in particular, the same distinction that keeps the three
          colour buttons meaning "log" rather than "recolour" wherever they appear. */}
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
            results.length,
            <>
              <Dot category={dotOf(null)} silent />
              <span>
                {busy ? t('composeAdding', { name: typed }) : t('composeAddAsNew', { name: typed })}
              </span>
            </>,
          )}
      </ul>

      {/* The first field on this screen that is prose, and the last one in the document, because
          it is the part nobody fills in on most meals. A textarea rather than an input: a note is
          a sentence about an occasion, and a single line control that scrolls sideways is how a
          sentence becomes unreadable while it is being typed. */}
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
