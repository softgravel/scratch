// v48: stored starts are switched off (Ian, Nov 21 ~9 PM ET: v47 'basically nonfunctional'; videos that had loaded lost
// their progress when scrolled back to). This worker only removes itself and the starts v47 stored. No fetch handler,
// so it never touches a request. (v47's worker: git show v47:sw.js)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  try { await caches.delete('starts-v1'); } catch (err) {}
  await self.registration.unregister();
})()));
