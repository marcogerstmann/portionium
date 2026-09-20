import {
  userResponseSchema,
  weeklyBudgetsSchema,
  LOCALES,
  type Locale,
  type UpdateProfileRequest,
  type UserResponse,
  type WeeklyBudgets,
} from '@portionium/schemas';
import { LogOut } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { BudgetFields } from './budgets';
import { invalidateDays } from './db';
import { useT } from './i18n';

const LANGUAGE_NAMES: Record<Locale, string> = { 'en-US': 'English (US)', de: 'Deutsch' };

function useProfileField(onSaved: (user: UserResponse) => void) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const t = useT();

  const save = async (patch: UpdateProfileRequest) => {
    setSaving(true);
    setError(undefined);

    try {
      onSaved(await request('/me', userResponseSchema, { method: 'PATCH', body: patch }));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
    } finally {
      setSaving(false);
    }
  };

  return { save, error, saving };
}

function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const t = useT();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setBusy(true);
    setError(undefined);

    try {
      await request('/me/password', z.null(), {
        method: 'POST',
        body: {
          currentPassword: form.get('currentPassword'),
          newPassword: form.get('newPassword'),
        },
      });

      onChanged();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)}>
      <h2>{t('settingsPasswordTitle')}</h2>
      <p className="text-sm text-muted">{t('settingsPasswordWarning')}</p>

      <label htmlFor="currentPassword" className="mt-3">
        {t('settingsCurrentPassword')}
      </label>
      <input
        id="currentPassword"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        required
      />

      <label htmlFor="newPassword" className="mt-3">
        {t('settingsNewPassword')}
      </label>
      <input
        id="newPassword"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        minLength={12}
        required
      />

      <button type="submit" className="mt-6" disabled={busy}>
        {busy ? t('settingsChangingPassword') : t('settingsPasswordTitle')}
      </button>

      <p role="alert" className="min-h-6 text-sm text-danger">
        {error}
      </p>
    </form>
  );
}

function BudgetSection() {
  const t = useT();
  const [budgets, setBudgets] = useState<WeeklyBudgets | undefined>(undefined);

  useEffect(() => {
    void request('/me/budgets', weeklyBudgetsSchema)
      .then(setBudgets)
      .catch(() => undefined);
  }, []);

  if (budgets === undefined) {
    return null;
  }

  return (
    <section className="mt-6">
      <h2>{t('budgetTitle')}</h2>
      <BudgetFields
        budgets={budgets}
        onSaved={(saved) => {
          setBudgets(saved);
          void invalidateDays();
        }}
      />
    </section>
  );
}

export function Settings({
  user,
  onUserChange,
  onSignedOut,
}: {
  user: UserResponse;
  onUserChange: (user: UserResponse) => void;
  onSignedOut: () => void;
}) {
  const t = useT();

  const language = useProfileField(onUserChange);
  const displayName = useProfileField(onUserChange);
  const timezone = useProfileField((updated) => {
    void invalidateDays();
    onUserChange(updated);
  });
  const dayBoundaryHour = useProfileField((updated) => {
    void invalidateDays();
    onUserChange(updated);
  });

  const timezones = useMemo(() => Intl.supportedValuesOf('timeZone'), []);
  const hours = useMemo(() => Array.from({ length: 24 }, (_, hour) => hour), []);

  return (
    <main>
      <header>
        <h1>{t('settingsTitle')}</h1>
      </header>

      <p className="mt-4 mb-6">
        <span className="block font-bold">{user.displayName}</span>
        <span className="block text-sm text-muted">{user.email}</span>
      </p>

      <label className="row">
        <span>{t('settingsLanguage')}</span>
        <select
          value={user.locale ?? ''}
          disabled={language.saving}
          onChange={(event) =>
            void language.save({ locale: (event.target.value || null) as Locale | null })
          }
        >
          <option value="">{t('settingsLanguageAuto')}</option>
          {LOCALES.map((locale) => (
            <option key={locale} value={locale}>
              {LANGUAGE_NAMES[locale]}
            </option>
          ))}
        </select>
      </label>
      {language.error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {language.error}
        </p>
      )}

      <form
        className="row"
        onSubmit={(event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('displayName');
          if (typeof value === 'string' && value.trim().length > 0) {
            void displayName.save({ displayName: value.trim() });
          }
        }}
      >
        <label htmlFor="displayName" className="shrink-0">
          {t('settingsDisplayName')}
        </label>
        <input
          id="displayName"
          name="displayName"
          defaultValue={user.displayName}
          disabled={displayName.saving}
          className="min-w-0 flex-1"
        />
        <button type="submit" className="shrink-0" disabled={displayName.saving}>
          {t('todaySave')}
        </button>
      </form>
      {displayName.error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {displayName.error}
        </p>
      )}

      <label className="row">
        <span>{t('settingsTimezone')}</span>
        <select
          value={user.timezone}
          disabled={timezone.saving}
          onChange={(event) => void timezone.save({ timezone: event.target.value })}
        >
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </label>
      {timezone.error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {timezone.error}
        </p>
      )}

      <label className="row">
        <span>{t('settingsDayBoundaryHour')}</span>
        <select
          value={user.dayBoundaryHour}
          disabled={dayBoundaryHour.saving}
          onChange={(event) =>
            void dayBoundaryHour.save({ dayBoundaryHour: Number(event.target.value) })
          }
        >
          {hours.map((hour) => (
            <option key={hour} value={hour}>
              {String(hour).padStart(2, '0')}:00
            </option>
          ))}
        </select>
      </label>
      <p className="text-sm text-muted">{t('settingsDayBoundaryHelp')}</p>
      {dayBoundaryHour.error !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {dayBoundaryHour.error}
        </p>
      )}

      <BudgetSection />

      <PasswordForm onChanged={onSignedOut} />

      <button
        type="button"
        className="row mt-6"
        onClick={() => {
          void request('/auth/logout', z.null(), { method: 'POST' }).finally(onSignedOut);
        }}
      >
        <LogOut aria-hidden="true" className="size-4 text-danger" />
        <span className="flex-1 text-danger">{t('settingsSignOut')}</span>
      </button>
    </main>
  );
}
