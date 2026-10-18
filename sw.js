const CACHE = 'prism-v2';
const ASSETS = ['./', './index.html', './style.css', './app.js', './music.mjs', './manifest.json', './icon.svg'];
const APP_URLS = new Set(ASSETS.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});
self.addEventListener('message', event => {
  if (event.data === 'activate') self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(names =>
    Promise.all(names.filter(name => name.startsWith('prism-') && name !== CACHE).map(name => caches.delete(name)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match('./index.html') || fetch(event.request)
    ));
  } else if (APP_URLS.has(event.request.url)) {
    event.respondWith(caches.open(CACHE).then(async cache =>
      await cache.match(event.request) || fetch(event.request)
    ));
  }
});
