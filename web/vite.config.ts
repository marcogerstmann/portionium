import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),

    // Tailwind v4 reads its theme from the stylesheet's @theme block and finds class names by
    // scanning, so there is no tailwind.config.js and no PostCSS config.
    tailwindcss(),

    VitePWA({
      registerType: 'autoUpdate',

      manifest: {
        name: 'Portionium',
        short_name: 'Portionium',
        description: 'A food diary that answers in colours rather than numbers.',
        start_url: '/',
        display: 'standalone',
        theme_color: '#2f9e44',
        background_color: '#ffffff',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // Opaque and green to every edge: a launcher crops this one, and the crop is what
          // supplies the disc. A transparent maskable icon would be cut against nothing.
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        importScripts: ['/sw-drain.js'],
        // A client route with no network resolves to the shell. The API's own paths are excluded,
        // or a navigation to /api/v1/docs would be answered with this app.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],

  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },

  test: {
    // Unit tests only: e2e/ is Playwright's and names its files the same way.
    include: ['src/**/*.test.ts'],
  },
});
