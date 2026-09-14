import {
  CATEGORIES,
  foodResponseSchema,
  MEAL_TYPES,
  type FoodResponse,
  type LocalDate,
  type MealType,
  type UserResponse,
} from '@portionium/schemas';
import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { mealTypeAt, mealTypeLabel } from './day';
import { cachedFoods } from './db';
import { categoryLabel, Dot, dotOf } from './dot';
import { isNewName, matchFoods } from './food-search';
import { useLocale, useT } from './i18n';
import { logMeal, type ComposedEntry } from './outbox';

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
 * What is deliberately not here: favourites and meal suggestions. The API has both, at GET
 * /meals/favourites and GET /meals/suggestions, and neither is renderable yet. A favourite's
 * entries carry a `foodId` and no name, so a preview needs a lookup per food that no endpoint
 * offers, and nothing in this client can pin a favourite in the first place, so the list would
 * be empty for everybody. Both are a screen of their own once the API answers with names.
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

export function Compose({
  user,
  date,
  onDone,
}: {
  user: UserResponse;
  /** The day this meal is logged for, whichever day was on screen when this opened. */
  date: LocalDate;
  /** Back to the day. Called whether the meal was saved or abandoned. */
  onDone: () => void;
}) {
  const [type, setType] = useState<MealType>(() => mealTypeAt(new Date(), user.timezone));
  const [chosen, setChosen] = useState<ComposedEntry[]>([]);
  const [query, setQuery] = useState('');
  const [cached, setCached] = useState<FoodResponse[]>([]);
  const [results, setResults] = useState<FoodResponse[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const t = useT();
  const locale = useLocale();

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
        <h1>{t('composeTitle')}</h1>
        <button type="button" className="flex shrink-0 items-center gap-2 text-sm" onClick={onDone}>
          <X aria-hidden="true" className="size-4" />
          {t('composeCancel')}
        </button>
      </header>

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

      <button
        type="button"
        className="primary mt-4 flex items-center justify-center gap-2 disabled:border-line disabled:bg-transparent disabled:text-muted disabled:shadow-none"
        // An empty meal is refused by the server as a domain invariant, see createMeal. Refusing
        // it here means nobody finds that out from a queue entry that could never be sent.
        disabled={chosen.length === 0}
        onClick={() => {
          // Not awaited, and that is the contract: the meal is durable once ./outbox.ts has it
          // in IndexedDB, and the day behind this screen already shows it.
          void logMeal(user, { type, entries: chosen }, date);
          onDone();
        }}
      >
        <Check aria-hidden="true" className="size-5" />
        {t('composeLog', { mealType: mealTypeLabel(type, locale) })}
        {chosen.length > 0 && ` · ${chosen.length}`}
      </button>
    </main>
  );
}
