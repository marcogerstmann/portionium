import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * The client's build, its dev server and its unit test runner.
 *
 * The dev proxy is the half worth reading. In development this app runs on Vite's own server
 * and the API runs on its own port, which would be two origins and therefore a session cookie
 * the browser refuses to attach and a CSRF check that refuses every write. Proxying /api here
 * makes the browser see one origin in development, which is what production genuinely is: there
 * the API serves this bundle itself, see api/src/http/plugins/static.ts. So there is nothing to
 * configure per environment in the client, and no code path that only exists on one of them.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The browser fetches the new service worker, installs it and takes over. The alternative,
      // prompting, is a dialog asking a person to approve a decision they have no information
      // about, on an app where every version is the version the API expects.
      registerType: 'autoUpdate',

      // Installability, which is the whole of what the manifest is for here. A browser needs a
      // name, a start URL, a display mode that is not `browser` and an icon of at least 192px
      // before it will offer to install anything.
      manifest: {
        name: 'portionium',
        short_name: 'portionium',
        description: 'A food diary that answers in colours rather than numbers.',
        start_url: '/',
        display: 'standalone',
        theme_color: '#2f9e44',
        background_color: '#ffffff',
        icons: [
          // The mark itself: a green disc on nothing, so a tab strip or a title bar of any
          // colour gets the disc and not a square of background it did not ask for.
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // A launcher crops this one to whatever shape the platform draws, so it is opaque and
          // green to the edge: the crop supplies the circle, and a transparent maskable icon
          // would be cut against nothing. The white disc sits inside the middle 80% the
          // specification reserves, so no platform's shape can take a bite out of it.
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },

      workbox: {
        // The app shell and everything it loads, precached on install, so a cold launch with no
        // network still renders. What that shell then shows offline is WEB 2's problem.
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        // A client route asked for with no network resolves to the shell, exactly as the API's
        // not found handler resolves it when there is one. The API's own paths are excluded:
        // answering a navigation to /api/v1/docs with this app would be a worse failure than
        // the offline page the browser shows instead.
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
    // Unit tests only. e2e/ is Playwright's, and it names its files the same way.
    include: ['src/**/*.test.ts'],
  },
});
