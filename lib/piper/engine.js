/* Motore Piper nel browser: testo -> fonemi (espeak) -> rete neurale (ONNX) -> audio.
   Tutto gira sul telefono. Le voci si scaricano una volta e restano nella memoria dell'app. */
(function (global) {
  'use strict';

  var BASE = (function () {
    var s = document.currentScript;
    return s && s.src ? s.src.replace(/[^\/]*$/, '') : './piper/';
  })();
  var HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
  var CACHE_NAME = 'piper-voci-v1';

  // ---------- caricamento dei programmi (una volta sola) ----------
  function loadScript(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res;
      s.onerror = function () { rej(new Error('Impossibile caricare ' + src)); };
      document.head.appendChild(s);
    });
  }
  var rt = null;
  function initRuntime() {
    if (!rt) {
      rt = Promise.all([loadScript(BASE + 'ort.wasm.min.js'), loadScript(BASE + 'piper_phonemize.js')]).then(function () {
        global.ort.env.wasm.wasmPaths = BASE;
        global.ort.env.wasm.numThreads = 1;      // i thread richiederebbero intestazioni che GitHub Pages non offre
        global.ort.env.wasm.proxy = false;
      });
    }
    return rt;
  }

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

  // ---------- elenco delle voci italiane ----------
  var VOICES_URL = HF + 'voices.json';
  var FALLBACK = [
    { key: 'it_IT-paola-medium', quality: 'medium', files: { 'it/it_IT/paola/medium/it_IT-paola-medium.onnx': { size_bytes: 63201294 }, 'it/it_IT/paola/medium/it_IT-paola-medium.onnx.json': {} } },
    { key: 'it_IT-riccardo-x_low', quality: 'x_low', files: { 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx': { size_bytes: 28000000 }, 'it/it_IT/riccardo/x_low/it_IT-riccardo-x_low.onnx.json': {} } }
  ];
  // Serena: voce della community (CC-BY-4.0), consigliata con questi parametri dall'autrice
  var SERENA = {
    key: 'it_IT-serena-high', label: 'Serena (high, community)', quality: 'high',
    modelUrl: 'https://huggingface.co/committa/it_IT-serena-high/resolve/main/it_IT-serena-high.onnx',
    configUrl: 'https://huggingface.co/committa/it_IT-serena-high/resolve/main/it_IT-serena-high.onnx.json',
    size: 114000000, noise: 0.6, noiseW: 0.4, length: 1.0
  };

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
        if (v.key.indexOf('it_') !== 0) return;
        var model = Object.keys(v.files).filter(function (f) { return /\.onnx$/.test(f); })[0];
        if (!model) return;
        var name = v.key.split('-')[1];
        out.push({
          key: v.key, label: name.charAt(0).toUpperCase() + name.slice(1) + ' (' + v.quality + ')',
          quality: v.quality, modelUrl: HF + model, configUrl: HF + model + '.json',
          size: (v.files[model] && v.files[model].size_bytes) || 0
        });
      });
      out.push(SERENA);
      return out;
    });
  }

  function isDownloaded(voice) { return getCached(voice.modelUrl).then(function (r) { return !!r; }); }
  function removeVoice(voice) {
    return cacheOpen().then(function (c) { return Promise.all([c.delete(voice.modelUrl), c.delete(voice.configUrl)]); });
  }

  // ---------- caricamento di una voce ----------
  var cur = null; // { key, session, cfg }
  function loadVoice(voice, onProgress) {
    if (cur && cur.key === voice.key) return Promise.resolve(cur);
    cur = null;
    return initRuntime().then(function () {
      return getFile(voice.configUrl, 0).then(function (b) { return b.text(); });
    }).then(function (txt) {
      var cfg = JSON.parse(txt);
      return getFile(voice.modelUrl, voice.size, onProgress).then(function (blob) {
        if (onProgress) onProgress(1, 1, 'init');
        return blob.arrayBuffer();
      }).then(function (buf) {
        return global.ort.InferenceSession.create(buf, { executionProviders: ['wasm'] });
      }).then(function (session) {
        cur = { key: voice.key, session: session, cfg: cfg, voice: voice };
        return cur;
      });
    });
  }

  // ---------- testo -> fonemi (tutte le frasi in una volta sola) ----------
  function phonemize(texts, espeakVoice) {
    return initRuntime().then(function () {
      var lines = [];
      var input = JSON.stringify(texts.map(function (t) { return { text: t }; }));
      return global.createPiperPhonemize({
        print: function (l) { lines.push(l); },
        printErr: function () {},
        locateFile: function (f) {
          if (f.slice(-5) === '.wasm') return BASE + 'piper_phonemize.wasm';
          if (f.slice(-5) === '.data') return BASE + 'piper_phonemize.data';
          return f;
        }
      }).then(function (m) {
        try { m.callMain(['-l', espeakVoice, '--input', input, '--espeak_data', '/espeak-ng-data']); } catch (e) {}
        return lines.map(function (l) {
          try { return JSON.parse(l).phoneme_ids || []; } catch (e) { return []; }
        });
      });
    });
  }

  // ---------- fonemi -> audio ----------
  function run(state, ids, speed) {
    var ort = global.ort, cfg = state.cfg, v = state.voice;
    var inf = cfg.inference || {};
    var noise = v.noise != null ? v.noise : (inf.noise_scale != null ? inf.noise_scale : 0.667);
    var noiseW = v.noiseW != null ? v.noiseW : (inf.noise_w != null ? inf.noise_w : 0.8);
    var length = (v.length != null ? v.length : (inf.length_scale != null ? inf.length_scale : 1)) / (speed || 1);
    var feeds = {
      input: new ort.Tensor('int64', BigInt64Array.from(ids, function (n) { return BigInt(n); }), [1, ids.length]),
      input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor('float32', Float32Array.from([noise, length, noiseW]), [3])
    };
    if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) {
      feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(0)]), [1]);
    }
    return state.session.run(feeds).then(function (out) {
      var o = out.output || out[state.session.outputNames[0]];
      return { pcm: o.data, rate: (cfg.audio && cfg.audio.sample_rate) || 22050 };
    });
  }

  global.PiperEngine = {
    listVoices: listVoices, isDownloaded: isDownloaded, removeVoice: removeVoice,
    loadVoice: loadVoice, phonemize: phonemize, run: run
  };
})(window);
