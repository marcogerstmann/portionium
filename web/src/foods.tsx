import {
  CATEGORIES,
  foodClassificationResponseSchema,
  foodResponseSchema,
  pageSchema,
  type Category,
  type FoodResponse,
} from '@portionium/schemas';
import { Check, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { refreshFoods } from './db';
import { categoryLabel, Dot, dotOf } from './dot';
import { useT } from './i18n';

const PAGE = pageSchema(foodResponseSchema);

const PAGE_SIZE = 100;

async function ownFoods(): Promise<FoodResponse[]> {
  const found: FoodResponse[] = [];
  let cursor: string | null = null;

  do {
    const page: z.infer<typeof PAGE> = await request(
      `/foods?mine=true&limit=${PAGE_SIZE}${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
      PAGE,
    );

    found.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);

  return found;
}

export function Foods({ active }: { active: boolean }) {
  const t = useT();

  const [foods, setFoods] = useState<FoodResponse[] | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Read when the tab is opened rather than once on mount, so a food added in the composer is here
  // on the way back rather than a reload later.
  useEffect(() => {
    if (!active) {
      return;
    }

    let live = true;

    void ownFoods().then(
      (own) => live && setFoods(own),
      (cause: unknown) =>
        live && setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError')),
    );

    return () => {
      live = false;
    };
  }, [t, active]);

  async function run(change: () => Promise<void>) {
    setBusy(true);
    setError(undefined);

    try {
      await change();
      // The composer searches this cache while offline, so a rename it cannot see is a stale name
      // on the one screen that matters.
      await refreshFoods().catch(() => undefined);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
    } finally {
      setBusy(false);
    }
  }

  function rename(food: FoodResponse) {
    const name = (drafts[food.id] ?? food.name).trim();

    if (name === '' || name === food.name) {
      return;
    }

    return run(async () => {
      const updated = await request(`/foods/${food.id}`, foodResponseSchema, {
        method: 'PATCH',
        body: { name },
      });

      setFoods((current) =>
        current?.map((row) => (row.id === food.id ? { ...updated, category: row.category } : row)),
      );
    });
  }

  function recolour(food: FoodResponse, category: Category) {
    return run(async () => {
      await request(`/foods/${food.id}/classification`, foodClassificationResponseSchema, {
        method: 'PUT',
        body: { category },
      });

      setFoods((current) =>
        current?.map((row) => (row.id === food.id ? { ...row, category } : row)),
      );
    });
  }

  function remove(food: FoodResponse) {
    return run(async () => {
      await request(`/foods/${food.id}`, z.null(), { method: 'DELETE' });

      setFoods((current) => current?.filter((row) => row.id !== food.id));
    });
  }

  return (
    <main>
      <header>
        <h1>{t('foodsTitle')}</h1>
      </header>

      <p className="mt-4 mb-6 text-sm text-muted">{t('foodsIntro')}</p>

      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {foods?.length === 0 && <p className="text-muted">{t('foodsEmpty')}</p>}

      <ul aria-label={t('foodsLabel')}>
        {foods?.map((food) => (
          <li key={food.id} className="mb-4">
            <p className="row justify-start">
              <Dot category={dotOf(food.category)} />
              <label htmlFor={`food-name-${food.id}`} className="sr-only">
                {t('foodsNameLabel', { name: food.name })}
              </label>
              <input
                id={`food-name-${food.id}`}
                className="min-w-0 flex-1"
                value={drafts[food.id] ?? food.name}
                maxLength={100}
                disabled={busy}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [food.id]: event.target.value }))
                }
              />
              <button
                type="button"
                className="shrink-0"
                disabled={busy}
                onClick={() => void rename(food)}
              >
                <Check aria-hidden="true" className="size-4" />
                <span className="sr-only">{t('foodsRename', { name: food.name })}</span>
              </button>
              <button
                type="button"
                className="shrink-0"
                disabled={busy}
                onClick={() => void remove(food)}
              >
                <Trash2 aria-hidden="true" className="size-4 text-danger" />
                <span className="sr-only">{t('foodsDelete', { name: food.name })}</span>
              </button>
            </p>

            <p className="flex gap-2 pl-4">
              {CATEGORIES.map((category) => (
                <button
                  key={category}
                  type="button"
                  aria-pressed={food.category === category}
                  className="flex flex-1 items-center justify-center gap-2 text-sm aria-pressed:border-brand aria-pressed:font-bold"
                  disabled={busy}
                  onClick={() => void recolour(food, category)}
                >
                  <Dot category={category} silent />
                  <span>{categoryLabel(category)}</span>
                  <span className="sr-only">{food.name}</span>
                </button>
              ))}
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
