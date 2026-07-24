const CACHE_NAME = 'sss-pwa-v20260724-3';

const APP_SHELL = [
  './',
  './app.html',
  './index.html',
  './picks.html',
  './trade.html',
  './members.html',
  './settle.html',
  './admin.html',
  './fees.html',
  './mypage.html',
  './presentations.html',
  './schedule-calendar.html',
  './schedule-order.html',
  './offline.html',
  './manifest.webmanifest',
  './assets/icon-180.png',
  './assets/icon-512.png',
  './assets/icon.svg',
  './css/style.css',
  './js/config.js',
  './js/db.js',
  './js/fees-auto.js',
  './js/modal-pick.js',
  './js/modal-pres.js',
  './js/schedule-shared.js',
  './js/pwa.js',
  './js/services/price-service.js',
  './js/utils/presentation.js',
  './js/utils/returns.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request, { ignoreSearch: true })
          .then((cached) => cached || caches.match('./offline.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || network;
    })
  );
});
