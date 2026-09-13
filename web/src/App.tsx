import { loginResponseSchema, userResponseSchema, type UserResponse } from '@portionium/schemas';
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError, request, session, UNAUTHENTICATED_EVENT } from './api';
import { drain } from './outbox';
import { Today } from './today';

/**
 * The shell: one gate, and the day behind it.
 *
 * There is still no router and no state library. The app is one screen, so a router would be a
 * dependency mapping one path to one component, and the state a screen holds is the day it is
 * showing, which belongs to that screen. Both become worth having when there is a second screen
 * to route to, which is WEB 5. What is here is what every screen after it depends on: who is
 * signed in, how that is found out, and what happens when it stops being true.
 */

/** While `GET /me` is in flight. A cookie may or may not be attached and neither answer is in yet. */
function Loading() {
  return <p className="centred">Loading</p>;
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
      setError(
        cause instanceof ApiError ? cause.problem.detail : 'Could not reach the server. Try again.',
      );
      setBusy(false);
    }
  }

  return (
    <main className="centred">
      <h1>portionium</h1>

      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>

        {/* Rendered into a live region that is always in the tree, so a screen reader announces
            the failure rather than finding out about it only if it happens to look again. */}
        <p role="alert" className="error">
          {error}
        </p>
      </form>
    </main>
  );
}

export function App() {
  const [user, setUser] = useState<UserResponse | undefined>(undefined);
  const [ready, setReady] = useState(false);

  // Whether there is a session is the server's answer, not a flag this app stored. A cookie it
  // cannot read is the only thing it has, so the only way to ask is to make a request.
  useEffect(() => {
    request('/me', userResponseSchema)
      .then(setUser, () => setUser(undefined))
      .finally(() => setReady(true));
  }, []);

  // An expired or revoked session, noticed by whichever request ran into it. Nothing is cleared
  // beyond this state: the outbox in ./outbox.ts belongs to the user and survives to be sent
  // once they sign back in. See UNAUTHENTICATED_EVENT.
  useEffect(() => {
    const signedOut = () => setUser(undefined);
    session.addEventListener(UNAUTHENTICATED_EVENT, signedOut);

    return () => session.removeEventListener(UNAUTHENTICATED_EVENT, signedOut);
  }, []);

  if (!ready) {
    return <Loading />;
  }

  return user === undefined ? (
    <Login
      onSignedIn={(signedIn) => {
        setUser(signedIn);

        // The other half of the outbox's `paused` outcome: a drain that ran into an expired
        // session stopped rather than burning a retry on every queued entry, and this is the
        // moment it becomes worth trying again. See classifyAttempt in ./outbox.ts.
        void drain();
      }}
    />
  ) : (
    <Today user={user} onSignedOut={() => setUser(undefined)} />
  );
}
