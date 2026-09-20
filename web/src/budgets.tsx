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

function toRequest(drafts: Drafts): UpdateBudgetsRequest {
  const limitOf = (draft: Draft) =>
    draft.limited && draft.value.trim() !== '' ? Number(draft.value) : null;

  return {
    green: limitOf(drafts.green),
    yellow: limitOf(drafts.yellow),
    orange: limitOf(drafts.orange),
  };
}

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

      <BudgetFields budgets={budgets} onSaved={(saved) => onDone(saved)} />
    </main>
  );
}
