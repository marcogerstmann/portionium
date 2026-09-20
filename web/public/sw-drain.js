/*
 * Forwards the Background Sync event to the page, which owns the request layer and the schemas.
 * Draining in the worker would mean a second copy of both.
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
