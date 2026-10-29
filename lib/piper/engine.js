/* Motore Piper nel browser: testo -> fonemi (espeak) -> rete neurale (ONNX) -> audio.
   Il calcolo gira in un processo separato (worker.js): l'app non si blocca mai.
   Le voci si scaricano una volta e restano nella memoria dell'app. */
(function (global) {
  'use strict';

  var BASE = (function () {
    var s = document.currentScript;
    return s && s.src ? s.src.replace(/[^\/]*$/, '') : './lib/piper/';
  })();
  var HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
  var CACHE_NAME = 'piper-voci-v1';

  // ---------- memoria permanente delle voci (Cache API) ----------
  function cacheOpen() {
    if (!('caches' in global)) return Promise.reject(new Error('Memoria non disponibile'));
    return caches.open(CACHE_NAME);
  }
  function getCached(url) {
    return cacheOpen().then(function (c) { return c.match(url); }).then(function (r) { return r || null; }, function () { return null; });
  }
  function putCached(url, blob) {
    return cacheOpen().then(function (c) { return c.put(url, new Response(blob)); });
  }
  function download(url, knownTotal, onProgress) {
    return fetch(url).then(function (res) {
      if (!res.ok) throw new Error('Download non riuscito (' + res.status + '): ' + url);
      var total = +res.headers.get('Content-Length') || knownTotal || 0;
      if (!res.body || !res.body.getReader) return res.blob();
      var reader = res.body.getReader(), chunks = [], loaded = 0;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return new Blob(chunks);
          chunks.push(r.value); loaded += r.value.length;
          if (onProgress) onProgress(loaded, total);
          return pump();
        });
      }
      return pump();
    });
  }
  function getFile(url, knownTotal, onProgress) {
    return getCached(url).then(function (hit) {
      if (hit) return hit.blob();
      return download(url, knownTotal, onProgress).then(function (blob) {
        return putCached(url, blob).then(function () { return blob; }, function () { return blob; }); // se la memoria è piena, funziona comunque
      });
    });
  }

  // i programmi di supporto (circa 29 MB) si salvano nella memoria delle voci: così funzionano anche senza internet
  var RUNTIME_FILES = ['worker.js', 'ort.wasm.min.js', 'ort-wasm-simd.wasm', 'piper_phonemize.js', 'piper_phonemize.wasm', 'piper_phonemize.data'];
  var runtimeCaching = null;
  function cacheRuntime() {
    if (runtimeCaching) return runtimeCaching;
    if (!('caches' in global)) return Promise.resolve();
    runtimeCaching = caches.open(CACHE_NAME).then(function (c) {
      return Promise.all(RUNTIME_FILES.map(function (f) {
        var url = BASE + f;
        return c.match(url).then(function (hit) {
          if (hit) return;
          return fetch(url).then(function (r) { if (r.ok) return c.put(url, r); });
        });
      }));
    }).catch(function () {});
    return runtimeCaching;
  }

  // ---------- il processo separato ----------
  var worker = null, seq = 0, pending = {}, cur = null; // cur = voce caricata: { key, cfg, voice }
  function failAll(err) {
    var p = pending; pending = {};
    Object.keys(p).forEach(function (k) { p[k].rej(err); });
  }
  function getWorker() {
    if (!worker) {
      worker = new Worker(BASE + 'worker.js');
      worker.onmessage = function (e) {
        var m = e.data, p = pending[m.id];
        if (!p) return;
        delete pending[m.id];
        if (m.error) p.rej(new Error(m.error)); else p.res(m);
      };
      worker.onerror = function (e) {
        // il worker è caduto (per esempio memoria finita con una voce troppo grande): al prossimo uso riparte da capo
        var w = worker; worker = null; cur = null; try { w.terminate(); } catch (x) {}
        failAll(new Error('Il calcolo della voce si è interrotto' + (e && e.message ? ': ' + e.message : '')));
      };
    }
    return worker;
  }
  function call(msg, transfer) {
    return new Promise(function (res, rej) {
      msg.id = ++seq;
      pending[msg.id] = { res: res, rej: rej };
      try { getWorker().postMessage(msg, transfer || []); } catch (e) { delete pending[msg.id]; rej(e); }
    });
  }

  // ---------- elenco delle voci: solo Paola e Serena (qualità medium) ----------
  var VOICES_URL = HF + 'voices.json';
  var FALLBACK = [
    { key: 'it_IT-paola-medium', quality: 'medium', files: { 'it/it_IT/paola/medium/it_IT-paola-medium.onnx': { size_bytes: 63201294 }, 'it/it_IT/paola/medium/it_IT-paola-medium.onnx.json': {} } },
    { key: 'it_IT-serena-medium', quality: 'medium', files: { 'it/it_IT/serena/medium/it_IT-serena-medium.onnx': { size_bytes: 63201294 }, 'it/it_IT/serena/medium/it_IT-serena-medium.onnx.json': {} } }
  ];
  var WANTED = { 'it_IT-paola-medium': 1, 'it_IT-serena-medium': 1 };

  function makeDef(key, quality, model, size) {
    var name = key.split('-')[1];
    return { key: key, label: name.charAt(0).toUpperCase() + name.slice(1), quality: quality,
      modelUrl: HF + model, configUrl: HF + model + '.json', size: size || 0 };
  }

  function listVoices() {
    return getCached(VOICES_URL).then(function (hit) {
      if (hit) return hit.json();
      return fetch(VOICES_URL).then(function (r) {
        if (!r.ok) throw new Error('voices.json ' + r.status);
        return r.clone().blob().then(function (b) { return putCached(VOICES_URL, b).catch(function () {}); })
          .then(function () { return r.json(); });
      });
    }).then(function (j) { return Object.keys(j).map(function (k) { return j[k]; }); },
            function () { return FALLBACK; })
    .then(function (all) {
      var out = [];
      all.forEach(function (v) {
        if (!WANTED[v.key]) return;
        var model = Object.keys(v.files).filter(function (f) { return /\.onnx$/.test(f); })[0];
        if (model) out.push(makeDef(v.key, v.quality, model, v.files[model] && v.files[model].size_bytes));
      });
      // se una delle due manca nell'elenco online, uso la voce di riserva
      FALLBACK.forEach(function (f) {
        if (out.some(function (o) { return o.key === f.key; })) return;
        var model = Object.keys(f.files).filter(function (x) { return /\.onnx$/.test(x); })[0];
        out.push(makeDef(f.key, f.quality, model, f.files[model].size_bytes));
      });
      out.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
      return out;
    });
  }

  function isDownloaded(voice) { return getCached(voice.modelUrl).then(function (r) { return !!r; }); }
  function removeVoice(voice) {
    return cacheOpen().then(function (c) { return Promise.all([c.delete(voice.modelUrl), c.delete(voice.configUrl)]); });
  }

  // cancella le voci vecchie non più offerte (Serena high, Riccardo...): liberano centinaia di MB
  function cleanup(defs) {
    var keep = {};
    defs.forEach(function (d) { keep[d.modelUrl] = 1; keep[d.configUrl] = 1; });
    return cacheOpen().then(function (c) {
      return c.keys().then(function (reqs) {
        return Promise.all(reqs.map(function (r) {
          var u = r.url;
          if (/\.onnx(\.json)?$/.test(u) && !keep[u] && u.indexOf(BASE) !== 0) return c.delete(r);
        }));
      });
    }).catch(function () {});
  }

  // ---------- caricamento di una voce ----------
  function loadVoice(voice, onProgress) {
    if (cur && cur.key === voice.key) return Promise.resolve(cur);
    cur = null;
    cacheRuntime();
    return getFile(voice.configUrl, 0).then(function (b) { return b.text(); }).then(function (txt) {
      var cfg = JSON.parse(txt);
      return getFile(voice.modelUrl, voice.size, onProgress).then(function (blob) {
        if (onProgress) onProgress(1, 1, 'init');
        return blob.arrayBuffer();
      }).then(function (buf) {
        return call({ cmd: 'load', buf: buf }, [buf]);   // il peso della voce passa al worker, senza copie
      }).then(function () {
        cur = { key: voice.key, cfg: cfg, voice: voice };
        return cur;
      });
    });
  }

  // ---------- testo -> fonemi ----------
  function phonemize(texts, espeakVoice) {
    return call({ cmd: 'phonemize', texts: texts, voice: espeakVoice }).then(function (m) { return m.ids; });
  }

  // ---------- fonemi -> audio ----------
  function run(state, ids, speed) {
    var cfg = state.cfg, v = state.voice, inf = cfg.inference || {};
    var msg = {
      cmd: 'run', ids: ids,
      noise: v.noise != null ? v.noise : (inf.noise_scale != null ? inf.noise_scale : 0.667),
      noiseW: v.noiseW != null ? v.noiseW : (inf.noise_w != null ? inf.noise_w : 0.8),
      length: (v.length != null ? v.length : (inf.length_scale != null ? inf.length_scale : 1)) / (speed || 1),
      sid: !!(cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length)
    };
    var rate = (cfg.audio && cfg.audio.sample_rate) || 22050;
    return call(msg).then(function (m) { return { pcm: m.pcm, rate: rate }; });
  }

  global.PiperEngine = {
    listVoices: listVoices, isDownloaded: isDownloaded, removeVoice: removeVoice, cleanup: cleanup,
    loadVoice: loadVoice, phonemize: phonemize, run: run
  };
})(window);
