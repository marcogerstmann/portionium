import {
  CATEGORIES,
  weeklyBudgetsSchema,
  type Category,
  type UpdateBudgetsRequest,
  type WeeklyBudgets,
} from '@portionium/schemas';
import { Check, X } from 'lucide-react';
import { useState } from 'react';

import { ApiError, request } from './api';
import { categoryLabel, Dot } from './dot';
import { useT } from './i18n';

/**
 * The weekly allowance, as its owner sets it.
 *
 * The whole screen is one sentence of copy and three numbers, and the sentence is the important
 * half: a limit here is never enforced anywhere, in this client or in the API, see the soft lock
 * note on domain/budget.ts. Somebody arriving at a screen headed "limits" reasonably expects to
 * be told off later, and the line under the heading is what stops that expectation forming.
 *
 * One Save for the three, which is deliberately not the per-field rule ./settings.tsx follows.
 * That rule exists because a rejected timezone must not roll back a display name accepted a
 * moment earlier, and these three validate identically and are one decision somebody makes in
 * one sitting. `PUT /me/budgets` takes them as one body for the same reason.
 *
 * Not through the outbox, the same call the review queue makes: this is a screen somebody opened
 * deliberately and is waiting on, and an allowance is about no day in particular, which is what
 * an outbox entry is shaped around. See the note on ./review.tsx.
 */

/**
 * One category's field as it is being edited, which is not quite what the wire carries.
 *
 * `limited` is held apart from `value` rather than derived from it, so unticking "no limit"
 * brings back the number that was there instead of an empty box, and so a field cleared while
 * being retyped does not silently mean unlimited. The two collapse back into one nullable number
 * on save, see toRequest.
 */
interface Draft {
  limited: boolean;
  value: string;
}

function draftOf(limit: number | null): Draft {
  return { limited: limit !== null, value: limit === null ? '' : String(limit) };
}

type Drafts = Record<Category, Draft>;

function draftsOf(budgets: WeeklyBudgets): Drafts {
  return {
    green: draftOf(budgets.green),
    yellow: draftOf(budgets.yellow),
    orange: draftOf(budgets.orange),
  };
}

/**
 * The three drafts as the endpoint takes them. An unticked category is an explicit `null`, which
 * is the choice to go back to unlimited rather than the absence of one, and a ticked category
 * with nothing typed in it is the same: there is no number to mean.
 */
function toRequest(drafts: Drafts): UpdateBudgetsRequest {
  const limitOf = (draft: Draft) =>
    draft.limited && draft.value.trim() !== '' ? Number(draft.value) : null;

  return {
    green: limitOf(drafts.green),
    yellow: limitOf(drafts.yellow),
    orange: limitOf(drafts.orange),
  };
}

/**
 * The fields alone, with no screen around them, so the Today screen can open this over the day
 * and ./settings.tsx can carry it inline among the account's other preferences. Two places
 * because of the one thing the row on the Today screen cannot do: it is hidden while no limit is
 * set, so without an entry point that is always there, a first limit could never be set at all.
 */
export function BudgetFields({
  budgets,
  onSaved,
}: {
  budgets: WeeklyBudgets;
  onSaved: (saved: WeeklyBudgets) => void;
}) {
  const t = useT();
  const [drafts, setDrafts] = useState<Drafts>(() => draftsOf(budgets));
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const edit = (category: Category, change: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [category]: { ...current[category], ...change } }));

  async function save() {
    setBusy(true);
    setError(undefined);

    try {
      onSaved(
        await request('/me/budgets', weeklyBudgetsSchema, {
          method: 'PUT',
          body: toRequest(drafts),
        }),
      );
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p className="mt-4 mb-6 text-sm text-muted">{t('budgetNotEnforced')}</p>

      {/* Always in the tree, so a refusal is announced rather than found by looking again. */}
      <p role="alert" className="min-h-6 text-danger">
        {error}
      </p>

      {CATEGORIES.map((category) => {
        const draft = drafts[category];
        const label = categoryLabel(category);

        return (
          <fieldset key={category} className="mb-4 border-0 p-0">
            <legend className="mb-2 flex items-center gap-2">
              <Dot category={category} silent />
              <span>{label}</span>
            </legend>

            {/* A checkbox rather than an empty field meaning unlimited. Empty would be a state
                somebody reaches by clearing the box mid-edit, and the two must not be the same
                thing. It is also the only way "no limit" is said in words rather than implied. */}
            <label className="mb-2 flex min-h-touch items-center gap-2">
              <input
                type="checkbox"
                className="size-5"
                checked={!draft.limited}
                onChange={(event) => edit(category, { limited: !event.target.checked })}
              />
              {t('budgetNoLimit')}
            </label>

            <span className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={1}
                inputMode="numeric"
                className="w-24"
                aria-label={t('budgetLimitFor', { label })}
                disabled={!draft.limited}
                value={draft.value}
                onChange={(event) => edit(category, { value: event.target.value })}
              />
              <span className="text-sm text-muted">{t('budgetPerWeek')}</span>
            </span>
          </fieldset>
        );
      })}

      <button
        type="button"
        className="primary mt-2 flex items-center justify-center gap-2"
        disabled={busy}
        onClick={() => void save()}
      >
        <Check aria-hidden="true" className="size-5" />
        {busy ? t('budgetSaving') : t('budgetSave')}
      </button>
    </>
  );
}

/** The same fields as a screen, opened from the allowance row on the Today screen. */
export function Budgets({
  budgets,
  onDone,
}: {
  budgets: WeeklyBudgets;
  onDone: (saved?: WeeklyBudgets) => void;
}) {
  const t = useT();

  return (
    <main>
      <header className="flex items-center justify-between gap-4">
        <h1>{t('budgetTitle')}</h1>
        <button
          type="button"
          className="flex shrink-0 items-center gap-2 text-sm"
          onClick={() => onDone()}
        >
          <X aria-hidden="true" className="size-4" />
          {t('budgetDone')}
        </button>
      </header>

      {/* Closes on a successful save rather than leaving somebody to find the Done button: the
          numbers they came to change are on the screen underneath and are what confirms it. */}
      <BudgetFields budgets={budgets} onSaved={(saved) => onDone(saved)} />
    </main>
  );
}
