// Service worker: salva i file dell'app nel telefono per farla funzionare offline
var CACHE = 'lettore-v1';
var FILES = [
  './', 'index.html', 'app.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png',
  'lib/jszip.min.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/mammoth.browser.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      return hit || fetch(e.request);
    })
  );
});
