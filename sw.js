// Service worker: salva i file dell'app nel telefono per farla funzionare offline.
// Strategia: prima prova la rete (così gli aggiornamenti arrivano da soli), se è offline usa la copia salvata.
var CACHE = 'lettore-v19';
var FILES = [
  './', 'index.html', 'app.js', 'manifest.webmanifest',
  'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png',
  'lib/jszip.min.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js', 'lib/mammoth.browser.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(FILES).then(function () {
      // il motore delle voci neurali (piccolo): serve già pronto anche senza internet. Se manca, l'app funziona lo stesso.
      return Promise.all([c.add('lib/piper/engine.js'), c.add('lib/piper/worker.js')].map(function (p) { return p.catch(function () {}); }));
    });
  }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    // cancella solo le vecchie copie dell'app: le voci scaricate ("piper-voci-v1") restano intatte
    return Promise.all(keys.filter(function (k) { return k.indexOf('lettore-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

// intestazioni che rendono l'app "isolata": permettono al calcolo della voce di usare più cuori del telefono
function iso(r) {
  if (!r || r.status === 0 || r.type === 'opaque') return r;
  var h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  // le voci scaricate da altri siti (Hugging Face) hanno una loro memoria: qui non le copio
  if (new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(function (resp) {
      // i grossi programmi delle voci neurali se li salva da solo il motore (nella memoria delle voci): qui non li copio
      var big = /\/lib\/piper\/(ort|piper_phonemize)/.test(e.request.url);
      if (resp && resp.ok && !big) {
        var copy = resp.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
      }
      return iso(resp);
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true }).then(iso);
    })
  );
});
