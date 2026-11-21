/* OFFLINE-SECURE-0.9.5-journal-download-pre: только статические ресурсы отдельной PWA.
 * Ни шифротекст пользователя, ни открытые данные, ни URL CRM не кэшируются SW.
 */
const CACHE='shtab-synthetic-sync-static-0.10-1';
const FILES=['./','./index.html','./styles.css','./app.js','./sync-client.js','./manifest.webmanifest'];
self.addEventListener('install', e => e.waitUntil(
  caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())
));
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys=await caches.keys();
  await Promise.all(keys.filter(k=>k.startsWith('shtab-synthetic-sync-static-')&&k!==CACHE).map(k=>caches.delete(k)));
  await self.clients.claim();
})()));
self.addEventListener('fetch', e => {
  const req=e.request;if(req.method!=='GET')return;
  const url=new URL(req.url),scope=new URL(self.registration.scope);
  if(url.origin!==scope.origin||!url.pathname.startsWith(scope.pathname))return;
  e.respondWith(caches.match(req,{ignoreSearch:true}).then(hit => hit ||
    fetch(req).catch(() => req.mode==='navigate' ? caches.match('./index.html') : Response.error())
  ));
});
