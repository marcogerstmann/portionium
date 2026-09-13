/*
 * The Background Sync half of the outbox, imported into the generated service worker by
 * `workbox.importScripts` in vite.config.ts.
 *
 * A plain file in public/ rather than a module in src/, because this is the one piece of code
 * that runs in the service worker rather than in the page, and vite-plugin-pwa is in generate
 * mode: Workbox writes the worker, and this is the supported way to add a listener to it
 * without taking over authorship of the whole file.
 *
 * What it does is deliberately small. The browser fires `sync` once it is confident the
 * connection is genuinely back, which on a phone is both earlier and more trustworthy than the
 * `online` event, and this forwards that to the app, which owns the queue and does the sending.
 *
 * The queue is not drained here, and that is the design rather than a shortcut. Draining from
 * the worker would mean a second copy of the outbox, the request layer and the schemas inside
 * the service worker, which is the general sync engine docs/adr/010-pwa-and-offline-outbox.md
 * exists to refuse. So this is an additional trigger and never a load bearing one: every
 * browser, including the ones with no Background Sync at all, still drains on launch, on
 * becoming visible, on `online`, and on the retry timer.
 */

self.addEventListener('sync', (event) => {
  if (event.tag !== 'portionium:outbox') {
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const window of windows) {
        window.postMessage('portionium:drain');
      }
    }),
  );
});
