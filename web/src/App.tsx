import { loginResponseSchema, userResponseSchema, type UserResponse } from '@portionium/schemas';
import { Apple, ChartLine, House, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, request, session, UNAUTHENTICATED_EVENT } from './api';
import { Foods } from './foods';
import { setLocale, useT } from './i18n';
import { drain } from './outbox';
import { Settings } from './settings';
import { Stats } from './statistics';
import { Today } from './today';

function Loading() {
  const t = useT();

  return <p className="flex min-h-dvh items-center justify-center text-muted">{t('appLoading')}</p>;
}

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
      setError(cause instanceof ApiError ? cause.problem.detail : t('loginNetworkError'));
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col justify-center">
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

        <p role="alert" className="min-h-6 text-danger">
          {error}
        </p>
      </form>
    </main>
  );
}

type Tab = 'today' | 'foods' | 'stats' | 'settings';

const CLEAR_TAB_BAR = 'pb-[calc(5rem+env(safe-area-inset-bottom))]';

function TabBar({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const t = useT();

  const tabs: { key: Tab; label: string; icon: typeof House }[] = [
    { key: 'today', label: t('navToday'), icon: House },
    { key: 'foods', label: t('navFoods'), icon: Apple },
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
  const [composing, setComposing] = useState(false);

  function applyUser(next: UserResponse | undefined): void {
    setUser(next);
    setLocale(next?.locale ?? null);

    if (next === undefined) {
      setTab('today');
    }
  }

  useEffect(() => {
    request('/me', userResponseSchema)
      .then(applyUser, () => applyUser(undefined))
      .finally(() => setReady(true));
  }, []);

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

        void drain();
      }}
    />
  ) : (
    <>
      <div hidden={tab !== 'today'} className={composing ? undefined : CLEAR_TAB_BAR}>
        <Today user={user} active={tab === 'today'} onComposingChange={setComposing} />
      </div>
      <div hidden={tab !== 'foods'} className={CLEAR_TAB_BAR}>
        <Foods active={tab === 'foods'} />
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
