import {
  bulkClassifyResponseSchema,
  CATEGORIES,
  unclassifiedCountResponseSchema,
  unclassifiedFoodResponseSchema,
  type Category,
  type UnclassifiedFoodResponse,
} from '@portionium/schemas';
import { Check, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { classifyCachedDays } from './db';
import { categoryLabel, Dot, UNCLASSIFIED } from './dot';
import { useT } from './i18n';
import { useStatistic } from './statistics';

const QUEUE_LIMIT = 50;

/**
 * A model verdict is a colour, so a food carrying one is not unjudged and would never reach this
 * screen. This is the line the prompt is calibrated against: at 0.7 the model is saying the
 * preparation decides the answer, which is exactly the question a person should be asked.
 */
const REVIEW_CONFIDENCE = 0.7;

const QUEUE = z.array(unclassifiedFoodResponseSchema);

export function useUnclassifiedCount(reloadOn?: unknown): number {
  const answer = useStatistic(
    'unclassified',
    `/foods/unclassified/count?minConfidence=${REVIEW_CONFIDENCE}`,
    unclassifiedCountResponseSchema,
    reloadOn,
  );

  return answer?.count ?? 0;
}

export function Review({ onDone, onConfirmed }: { onDone: () => void; onConfirmed: () => void }) {
  const t = useT();

  const [queue, setQueue] = useState<UnclassifiedFoodResponse[] | undefined>(undefined);
  const [marked, setMarked] = useState<Record<string, Category>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;

    const url = `/foods/unclassified?limit=${QUEUE_LIMIT}&minConfidence=${REVIEW_CONFIDENCE}`;

    void request(url, QUEUE).then(
      (foods) => {
        if (!live) {
          return;
        }

        setQueue(foods);
        // Pre-marked rather than merely shown: the batch is confirmed as it stands, so a queue of
        // suggestions is one button away from being accepted.
        setMarked(
          Object.fromEntries(
            foods.flatMap((food) =>
              food.suggestion === null ? [] : [[food.id, food.suggestion.category]],
            ),
          ),
        );
      },
      (cause: unknown) =>
        live && setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError')),
    );

    return () => {
      live = false;
    };
  }, [t]);

  const items = Object.entries(marked).map(([foodId, category]) => ({ foodId, category }));

  async function confirm() {
    setBusy(true);
    setError(undefined);

    try {
      const { results } = await request('/foods/unclassified/confirm', bulkClassifyResponseSchema, {
        method: 'POST',
        body: { items },
      });

      const confirmed = new Set(
        results.filter((result) => result.status === 'confirmed').map((result) => result.foodId),
      );

      await classifyCachedDays(items.filter((item) => confirmed.has(item.foodId)));

      setQueue((current) => current?.filter((food) => !(food.id in marked)));
      setMarked({});
      onConfirmed();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <header className="flex items-center justify-between gap-4">
        <h1>{t('reviewTitle')}</h1>
        <button type="button" className="flex shrink-0 items-center gap-2 text-sm" onClick={onDone}>
          <X aria-hidden="true" className="size-4" />
          {t('reviewDone')}
        </button>
      </header>

      <p className="mt-4 mb-6 text-sm text-muted">{t('reviewIntro')}</p>

      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {queue?.length === 0 && <p className="text-muted">{t('reviewEmpty')}</p>}

      <ul aria-label={t('reviewFoodsLabel')}>
        {queue?.map((food) => {
          const choice = marked[food.id];

          return (
            <li key={food.id}>
              <p className="row justify-start">
                <Dot category={choice ?? UNCLASSIFIED} />
                <span>{food.name}</span>
                {food.suggestion !== null && choice === food.suggestion.category && (
                  <span className="ml-auto shrink-0 text-sm text-muted">
                    {t('reviewSuggested')}
                  </span>
                )}
              </p>

              <p className="mb-2 flex gap-2 pl-4">
                {CATEGORIES.map((category) => (
                  <button
                    key={category}
                    type="button"
                    aria-pressed={choice === category}
                    className="flex flex-1 items-center justify-center gap-2 text-sm aria-pressed:border-brand aria-pressed:font-bold"
                    onClick={() => setMarked((current) => ({ ...current, [food.id]: category }))}
                  >
                    <Dot category={category} silent />
                    <span>{categoryLabel(category)}</span>
                    <span className="sr-only">{food.name}</span>
                  </button>
                ))}
              </p>
            </li>
          );
        })}
      </ul>

      {items.length > 0 && (
        <button
          type="button"
          className="primary mt-4 flex items-center justify-center gap-2"
          disabled={busy}
          onClick={() => void confirm()}
        >
          <Check aria-hidden="true" className="size-5" />
          {t('reviewConfirm', { count: items.length })}
        </button>
      )}
    </main>
  );
}
