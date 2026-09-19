import { loginResponseSchema, userResponseSchema, type UserResponse } from '@portionium/schemas';
import { ChartLine, House, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, request, session, UNAUTHENTICATED_EVENT } from './api';
import { setLocale, useT } from './i18n';
import { drain } from './outbox';
import { Settings } from './settings';
import { Stats } from './statistics';
import { Today } from './today';

/**
 * The shell: one gate, and the three destinations behind it.
 *
 * There is still no router and no state library. A router earns its place when a screen is
 * worth a URL, which is when the back gesture has to mean something on this app, and switching
 * tabs is a render rather than a navigation. What is here is what every screen after it depends
 * on: who is signed in, how that is found out, what happens when it stops being true, and, since
 * POR-65, which of the three tabs is the active one.
 */

/** While `GET /me` is in flight. A cookie may or may not be attached and neither answer is in yet. */
function Loading() {
  const t = useT();

  return <p className="flex min-h-dvh items-center justify-center text-muted">{t('appLoading')}</p>;
}

/**
 * Signing in. One request, and the credential never touches this code: the API answers with a
 * `Set-Cookie` the page cannot read, so all that arrives here is the profile.
 *
 * Native form validation rather than a form library: the browser already refuses an empty field
 * and a value that is not an address, announces both to a screen reader, and costs nothing.
 */
function Login({ onSignedIn }: { onSignedIn: (user: UserResponse) => void }) {
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const t = useT();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);

    setBusy(true);
    setError(undefined);

    try {
      const { user } = await request('/auth/login', loginResponseSchema, {
        method: 'POST',
        body: { email: form.get('email'), password: form.get('password') },
      });

      onSignedIn(user);
    } catch (cause) {
      // The API's own sentence, which is deliberately the same one for a wrong password and an
      // address with no account, and is safe to show. Anything else is not: a network failure
      // or a contract mismatch says nothing a person can act on.
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center">
      {/* The mark, above the wordmark. Drawn rather than fetched: it is one element and a border
          radius, so it costs no request, and taking its colour from `--green` is what makes it
          follow the system's light and dark like the rest of the app, where public/icon.svg
          carries one fixed colour because a browser tab cannot be asked. It carries no label
          because the heading under it is already the name, and announcing "Portionium" twice is
          worse than not drawing it at all. `mx-auto` rather than a width, because its parent is
          a flex column: left alone the column would stretch it and the radius would draw a pill
          rather than a circle. */}
      <div className="mx-auto size-16 rounded-full bg-green shadow-sm" />
      <h1 className="mt-4 mb-6 text-center text-4xl">Portionium</h1>

      <form className="flex flex-col gap-1" onSubmit={(event) => void submit(event)}>
        <label htmlFor="email" className="mt-3">
          {t('loginEmail')}
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />

        <label htmlFor="password" className="mt-3">
          {t('loginPassword')}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        <button type="submit" className="primary mt-6" disabled={busy}>
          {busy ? t('loginSigningIn') : t('loginSignIn')}
        </button>

        {/* Rendered into a live region that is always in the tree, so a screen reader announces
            the failure rather than finding out about it only if it happens to look again. */}
        <p role="alert" className="min-h-6 text-danger">
          {error}
        </p>
      </form>
    </main>
  );
}

type Tab = 'today' | 'stats' | 'settings';

/**
 * Room for the tab bar under a screen's own content, so the bar never covers the last row of a
 * scrolled screen. 5rem is the bar's rendered height with a rem or so to spare rather than a
 * measured figure: the bar is three lines of CSS with nothing that changes its height at
 * runtime, so a constant is the whole of the layout problem, not a size worth reading off a ref.
 */
const CLEAR_TAB_BAR = 'pb-[calc(5rem+env(safe-area-inset-bottom))]';

/**
 * The three destinations, always on screen and never over the composer.
 *
 * Plain buttons in a `nav` rather than an ARIA tablist: three static destinations need no
 * roving tabindex or arrow key handling, and a `<button>` is already reachable by Tab and
 * activated by Enter or Space, which is the whole of WEB 10's keyboard requirement. What a tab
 * bar needs beyond that is `aria-current`, and a second channel beside it so the active one is
 * not colour alone, here the label and icon both going bold.
 *
 * `env(safe-area-inset-bottom)` is padding on the bar rather than a margin below it, so the
 * bar's own background reaches the true bottom of the screen, behind the home indicator, rather
 * than leaving a gap of whatever colour sits underneath.
 */
function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const t = useT();

  const tabs: { key: Tab; label: string; icon: typeof House }[] = [
    { key: 'today', label: t('navToday'), icon: House },
    { key: 'stats', label: t('navStatistics'), icon: ChartLine },
    { key: 'settings', label: t('navSettings'), icon: SettingsIcon },
  ];

  return (
    <nav
      className="fixed inset-x-0 bottom-0 flex border-t border-line bg-background pb-[env(safe-area-inset-bottom)]"
      aria-label={t('navLabel')}
    >
      {tabs.map(({ key, label, icon: Icon }) => {
        const active = tab === key;

        return (
          <button
            key={key}
            type="button"
            className="flex min-h-touch flex-1 flex-col items-center justify-center gap-1 rounded-none border-none bg-transparent"
            aria-current={active ? 'page' : undefined}
            onClick={() => onChange(key)}
          >
            <Icon aria-hidden="true" className={`size-5 ${active ? 'text-brand' : 'text-muted'}`} />
            <span className={`text-xs ${active ? 'font-bold text-brand' : 'text-muted'}`}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

export function App() {
  const [user, setUser] = useState<UserResponse | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>('today');
  // Lifted out of today.tsx rather than read from there, because this is the one thing about the
  // composer the tab bar needs to know: it is a full screen view and not a fourth tab, so it and
  // the bar must never be on screen together, see Today's onComposingChange.
  const [composing, setComposing] = useState(false);

  /**
   * `setUser` and the one thing that has to happen alongside every call to it: a stored account
   * locale wins over the browser, see POR-64. `user.locale` is null for an account that has
   * never chosen one, the same `null` that means "follow the browser" wherever it crosses the
   * wire, see updateProfileRequestSchema, and signing out goes back to it too, so the next
   * person at this device is not left on a language the last one picked.
   */
  function applyUser(next: UserResponse | undefined): void {
    setUser(next);
    setLocale(next?.locale ?? null);

    // Today is the screen the app opens on, and signing out is as fresh a start as a reload: the
    // next person at this device, or the same one signing back in, should not land on whichever
    // tab the last session happened to leave open.
    if (next === undefined) {
      setTab('today');
    }
  }

  // Whether there is a session is the server's answer, not a flag this app stored. A cookie it
  // cannot read is the only thing it has, so the only way to ask is to make a request.
  useEffect(() => {
    request('/me', userResponseSchema)
      .then(applyUser, () => applyUser(undefined))
      .finally(() => setReady(true));
  }, []);

  // An expired or revoked session, noticed by whichever request ran into it. Nothing is cleared
  // beyond this state: the outbox in ./outbox.ts belongs to the user and survives to be sent
  // once they sign back in. See UNAUTHENTICATED_EVENT.
  useEffect(() => {
    const signedOut = () => applyUser(undefined);
    session.addEventListener(UNAUTHENTICATED_EVENT, signedOut);

    return () => session.removeEventListener(UNAUTHENTICATED_EVENT, signedOut);
  }, []);

  if (!ready) {
    return <Loading />;
  }

  return user === undefined ? (
    <Login
      onSignedIn={(signedIn) => {
        applyUser(signedIn);

        // The other half of the outbox's `paused` outcome: a drain that ran into an expired
        // session stopped rather than burning a retry on every queued entry, and this is the
        // moment it becomes worth trying again. See classifyAttempt in ./outbox.ts.
        void drain();
      }}
    />
  ) : (
    <>
      {/* All three stay mounted, `hidden` rather than unmounted, so switching tabs never
          discards a day being viewed or a half composed meal: there is nothing to discard, it
          was never taken off the page. `hidden` also takes whichever two are inactive out of the
          accessibility tree and the tab order, so nothing behind the visible screen is reachable
          by finding it first. The padding below each is a floor generous enough to clear the tab
          bar's own height plus the safe area, so the bar never sits over a screen's last row. */}
      <div hidden={tab !== 'today'} className={composing ? undefined : CLEAR_TAB_BAR}>
        <Today user={user} active={tab === 'today'} onComposingChange={setComposing} />
      </div>
      <div hidden={tab !== 'stats'} className={CLEAR_TAB_BAR}>
        <Stats user={user} active={tab === 'stats'} />
      </div>
      <div hidden={tab !== 'settings'} className={CLEAR_TAB_BAR}>
        <Settings user={user} onUserChange={applyUser} onSignedOut={() => applyUser(undefined)} />
      </div>

      {!composing && <TabBar tab={tab} onChange={setTab} />}
    </>
  );
}
