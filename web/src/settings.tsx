import type { UserResponse } from '@portionium/schemas';
import { LogOut } from 'lucide-react';
import { z } from 'zod';

import { request } from './api';
import { useT } from './i18n';

/**
 * The account, and the one destructive thing this app lets somebody do to it from here.
 *
 * POR-65 moves the name off the sign-out button and onto this screen instead, since a name is
 * the worst possible label for a button that signs somebody out: what is read is not what the
 * button does. The name and the email sit above it instead, read once rather than every time the
 * button is.
 *
 * There is more coming here, see WEB 12: this is deliberately the smallest version of the
 * screen the tab bar needs to point at today.
 */
export function Settings({ user, onSignedOut }: { user: UserResponse; onSignedOut: () => void }) {
  const t = useT();

  return (
    <main>
      <header>
        <h1>{t('settingsTitle')}</h1>
      </header>

      <p className="mt-4 mb-6">
        <span className="block font-bold">{user.displayName}</span>
        <span className="block text-sm text-muted">{user.email}</span>
      </p>

      <button
        type="button"
        className="row"
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
