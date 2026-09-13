import {
  userResponseSchema,
  LOCALES,
  type Locale,
  type UpdateProfileRequest,
  type UserResponse,
} from '@portionium/schemas';
import { LogOut } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { z } from 'zod';

import { ApiError, request } from './api';
import { invalidateDays } from './db';
import { useT } from './i18n';

/**
 * The account, and everything WEB 12 asks this screen to hold: the language from POR-64, the
 * profile fields `PATCH /me` already accepted, and the password. See POR-65 for why the name and
 * email sit above the sign-out button rather than on it.
 *
 * Every field below saves and reports on its own, deliberately not one form with one submit
 * button: a rejected timezone must not roll back a display name accepted a moment before, and
 * `PATCH /me` already takes one field at a time for the same reason two open tabs must not
 * overwrite each other's edit, see updateProfileRequestSchema.
 */

/** Native names, not translated: a language picker names each option in its own language. */
const LANGUAGE_NAMES: Record<Locale, string> = { 'en-US': 'English (US)', de: 'Deutsch' };

/**
 * `PATCH /me`, reported to whichever field asked. `onSaved` is how the updated account reaches
 * `App`, which is also where the active language is applied, see applyUser.
 */
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

/**
 * Changing the password, the one field on this screen that is not `PATCH /me` and the one that
 * ends the session it runs on. `onChanged` is only ever the sign-out the screen warns about
 * before the form is submitted, see settingsPasswordWarning.
 *
 * A wrong current password needs no special casing here: it is a 403, not the 401 ./api.ts
 * reacts to by signing this app out, so it lands in `error` and is shown as a field error like
 * any other, exactly as POR-67 asks.
 */
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

export function Settings({
  user,
  onUserChange,
  onSignedOut,
}: {
  user: UserResponse;
  /** After any `PATCH /me` succeeds, so App can apply the language and hold the new profile. */
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

  // The runtime's own IANA database rather than a bundled list, the same source timezoneSchema
  // checks a value against server side. Read once: the set of zones a browser knows does not
  // change while this screen is open.
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

      <PasswordForm onChanged={onSignedOut} />

      <button
        type="button"
        className="row mt-6"
        onClick={() => {
          // The row is deleted server side, so the credential is dead whatever this client does
          // next. A failure here is still a sign out locally, for the same reason, see today.tsx.
          void request('/auth/logout', z.null(), { method: 'POST' }).finally(onSignedOut);
        }}
      >
        <LogOut aria-hidden="true" className="size-4 text-danger" />
        <span className="flex-1 text-danger">{t('settingsSignOut')}</span>
      </button>
    </main>
  );
}
