import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { startDraining } from './outbox';
import './styles.css';

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html is missing the #root container');
}

/**
 * Ask the browser to keep this origin's storage.
 *
 * Without it, IndexedDB here is "best effort" and a browser under storage pressure may evict it
 * without asking, which for this app means a queue of meals somebody logged on a train quietly
 * disappearing. Granted silently on an installed PWA in every browser that implements it, so
 * this is a request rather than a prompt, and a browser that has no opinion about it simply has
 * no `storage` to ask. Calling it again on a later launch resolves immediately, so there is
 * nothing to remember about having asked.
 */
void navigator.storage?.persist();

/**
 * Start replaying whatever is queued, and listen for the moments worth trying again.
 *
 * Outside React on purpose. The queue belongs to the device rather than to a screen, it may
 * hold meals logged before the last time this app was closed, and nothing that renders needs to
 * have mounted for them to be sent. An empty queue makes no requests, so this costs nothing on
 * a launch with nothing to do, signed in or not.
 */
startDraining();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
