import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
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

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
