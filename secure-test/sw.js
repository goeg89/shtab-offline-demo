/* OFFLINE-SECURE-0.8-vault-pre. Кэш только неизменяемых статических ресурсов.
 * Никогда не перехватывает, не запрашивает и не кэширует персональные данные.
 */
const CACHE = 'shtab-secure-vault-static-0.8-pre-1';
const URLS = ['./','./index.html','./styles.css','./app.js','./manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const all = await caches.keys();
    await Promise.all(all.filter(k => k.startsWith('shtab-secure-vault-static-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(caches.match(req,{ignoreSearch:true}).then(hit => hit ||
    fetch(req).then(response => {
      // Offline assets are pre-cached; no dynamic/client data is stored.
      return response;
    }).catch(() => req.mode === 'navigate' ? caches.match('./index.html') : Response.error())
  ));
});
