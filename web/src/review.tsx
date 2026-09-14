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

/**
 * The review queue: the foods nothing has judged yet, and the three buttons that judge them.
 *
 * This is the screen that closes the gap the composer opens. Adding a food the catalog does not
 * have is one insert and never a wait on a classifier, so it arrives grey, and every entry
 * logged with it stays grey too. A grey entry is one the statistics cannot place, which means
 * the faster the composer gets the more of the diary becomes uncountable. Here is where that is
 * paid back.
 *
 * It is a chore rather than a destination, so it is reached from the Today screen and only while
 * there is something in it, never as a fourth tab. See the queue row in ./today.tsx.
 *
 * Three decisions are worth knowing.
 *
 * A colour button marks a row rather than sending anything, and one button at the bottom sends
 * the lot. The endpoint takes a batch because a queue is something somebody clears in a sitting,
 * and marking before sending is also what makes changing your mind about the third row free.
 *
 * Nothing here goes through the outbox, unlike every write on the Today screen. An outbox entry
 * is shaped around the one day it changes, which is what its drain refreshes, and a batch of
 * verdicts about foods is about no day in particular. This is a screen somebody opens
 * deliberately and waits on, which is exactly the case ./api.ts says to send without an
 * idempotency key: the request runs when it is made, and a failure is shown rather than queued.
 *
 * A confirmation writes a `user` verdict, which outranks everything else for this caller, see
 * resolveClassification in api/src/domain/classification.ts. That decides the colour every
 * future entry of the food gets. What it does to the entries already logged is the server's
 * business and is deliberately narrow: the ones still waiting take the colour in the same
 * transaction and the ones that already carry one are left as history. classifyCachedDays
 * mirrors exactly that on the device and nothing more, see docs/adr/011-an-entry-is-a-colour.md.
 *
 * What is deliberately not here: the `suggestion` each queue entry carries. It is null for
 * everything today, because nothing produces a model verdict yet, and a control for confirming
 * or rejecting one is a screen written against a shape nobody has seen answer. The queue is
 * built now and the source of what fills it changes later.
 */

/**
 * How many rows are asked for. The endpoint's own default, and also the cap on one batch, so
 * everything on screen can always be confirmed in the one request this screen makes. Those two
 * numbers agreeing is what means there is no paging and no chunking here, see
 * unclassifiedFoodsQuerySchema and bulkClassifyRequestSchema.
 *
 * ponytail: one page and no cursor. A queue longer than fifty shows its top fifty, which is the
 * half worth clearing anyway since it is ranked by how often each food is eaten, and clearing it
 * brings the next fifty on the next visit. If that ever stops being enough the endpoint takes a
 * limit up to 100 and the batch would then need splitting, which is the thing not to write yet.
 */
const QUEUE_LIMIT = 50;

const QUEUE = z.array(unclassifiedFoodResponseSchema);

/**
 * How many foods are waiting, for the badge on the Today screen.
 *
 * Its own endpoint rather than the length of the list above, which is the whole reason the API
 * has one: a client that only wants to know whether to show the row should not pay for the
 * ranking query to find out. Cached like a statistic, because it is the same kind of thing, one
 * answer from the server keyed by the question, so a launch with no connection still renders
 * the last count instead of hiding the queue.
 */
export function useUnclassifiedCount(reloadOn?: unknown): number {
  const answer = useStatistic(
    'unclassified',
    '/foods/unclassified/count',
    unclassifiedCountResponseSchema,
    reloadOn,
  );

  return answer?.count ?? 0;
}

export function Review({
  onDone,
  onConfirmed,
}: {
  onDone: () => void;
  /** So the badge and the day behind this screen are asked again, see the Today screen. */
  onConfirmed: () => void;
}) {
  const t = useT();

  const [queue, setQueue] = useState<UnclassifiedFoodResponse[] | undefined>(undefined);
  const [marked, setMarked] = useState<Record<string, Category>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;

    void request(`/foods/unclassified?limit=${QUEUE_LIMIT}`, QUEUE).then(
      (foods) => live && setQueue(foods),
      // Not an empty queue. Answering a failed request with "nothing to review" would be this
      // screen telling somebody their chore is done because it could not ask.
      (cause: unknown) =>
        live && setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError')),
    );

    return () => {
      live = false;
    };
    // Once, on the tap that opened this screen. The queue is what it was when it was asked for,
    // and a row that has since been cleared elsewhere comes back `not_found` on confirm rather
    // than needing this to have been watching for it.
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

      // Only what the server actually confirmed recolours anything here. A food deleted between
      // this queue being fetched and being cleared comes back `not_found` rather than failing
      // the other nine, and nothing on the device should move for it.
      const confirmed = new Set(
        results.filter((result) => result.status === 'confirmed').map((result) => result.foodId),
      );

      await classifyCachedDays(items.filter((item) => confirmed.has(item.foodId)));

      // Every row in the batch leaves the list, confirmed or gone: neither is still a question.
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

      {/* Always in the tree, so a refusal is announced rather than found by looking again. */}
      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {/* Nothing at all while the first request is in flight, rather than the empty sentence: an
          empty queue and an unanswered one look the same for a moment and mean opposite things. */}
      {queue?.length === 0 && <p className="text-muted">{t('reviewEmpty')}</p>}

      <ul aria-label={t('reviewFoodsLabel')}>
        {/* The order the endpoint ranked them in, most eaten first, so the presets behind the
            most grey entries are the ones dealt with first. Not re-sorted here. */}
        {queue?.map((food) => {
          const choice = marked[food.id];

          return (
            <li key={food.id}>
              <p className="row justify-start">
                <Dot category={choice ?? UNCLASSIFIED} />
                <span>{food.name}</span>
              </p>

              {/* The same three buttons the Today screen puts under a grey entry, so giving a
                  colour looks and reads identically wherever it is done. */}
              <p className="mb-2 flex gap-2 pl-4">
                {CATEGORIES.map((category) => (
                  <button
                    key={category}
                    type="button"
                    // Marked rather than sent, and said in the accessibility tree rather than
                    // only in the styling, the same way the composer's meal type is. The fill
                    // it uses would be wrong here: this button already carries a colour and a
                    // green wash over an orange dot is the one thing this screen must not do.
                    // So the border and the weight carry it, beside the row's own dot changing.
                    aria-pressed={choice === category}
                    className="flex flex-1 items-center justify-center gap-2 text-sm aria-pressed:border-brand aria-pressed:font-bold"
                    onClick={() => setMarked((current) => ({ ...current, [food.id]: category }))}
                  >
                    <Dot category={category} silent />
                    <span>{categoryLabel(category)}</span>
                    {/* Which food this button is about. Without it a reader hears "green,
                        yellow, orange" once per row and nothing that says which row. */}
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
