import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { idSchema } from '@portionium/schemas';

// Placeholder shell. The real app, routing and PWA setup arrive with the web app story.
// The schema import is deliberate, it proves the shared package resolves through Vite.
function App() {
  return (
    <main>
      <h1>portionium</h1>
      <p>Shared schemas loaded: {idSchema.constructor.name}</p>
    </main>
  );
}

const container = document.querySelector('#root');
if (!container) {
  throw new Error('index.html is missing the #root container');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
