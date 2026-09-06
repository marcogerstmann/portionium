import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The PWA setup, the API proxy and the test runner config land with the web app story.
export default defineConfig({
  plugins: [react()],
});
