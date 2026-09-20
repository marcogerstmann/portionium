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
 * Without this the browser may evict this origin's IndexedDB under storage pressure, which here is
 * a queue of meals logged offline.
 */
void navigator.storage?.persist();

startDraining();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
