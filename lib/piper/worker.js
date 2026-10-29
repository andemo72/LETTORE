/* Processo separato ("Worker") che fa tutto il calcolo pesante della voce neurale,
   così lo schermo, i tasti e l'audio dell'app non restano mai bloccati. */
'use strict';
var BASE = self.location.href.replace(/[?#].*$/, '').replace(/[^\/]*$/, '');
importScripts(BASE + 'ort.wasm.min.js', BASE + 'piper_phonemize.js');
ort.env.wasm.wasmPaths = BASE;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

var session = null, phMod = null, phLines = null;
var chain = Promise.resolve();

function reply(id, data, transfer) { data.id = id; self.postMessage(data, transfer || []); }

// il traduttore testo -> fonemi si crea una volta sola e si riusa (creare una nuova istanza ogni volta costa secondi)
function getPhonemizer() {
  if (phMod) return Promise.resolve(phMod);
  return createPiperPhonemize({
    print: function (l) { if (phLines) phLines.push(l); },
    printErr: function () {},
    noExitRuntime: true,
    locateFile: function (f) {
      if (f.slice(-5) === '.wasm') return BASE + 'piper_phonemize.wasm';
      if (f.slice(-5) === '.data') return BASE + 'piper_phonemize.data';
      return f;
    }
  }).then(function (m) { phMod = m; return m; });
}
function phonemizeOnce(texts, voice) {
  return getPhonemizer().then(function (m) {
    phLines = [];
    var input = JSON.stringify(texts.map(function (t) { return { text: t }; }));
    try { m.callMain(['-l', voice, '--input', input, '--espeak_data', '/espeak-ng-data']); } catch (e) {}
    var lines = phLines; phLines = null;
    return lines.map(function (l) { try { return JSON.parse(l).phoneme_ids || []; } catch (e) { return []; } });
  });
}
function phonemize(texts, voice) {
  return phonemizeOnce(texts, voice).then(function (ids) {
    if (ids.length === texts.length) return ids;
    phMod = null;                                  // qualcosa non torna: riparto con un traduttore nuovo
    return phonemizeOnce(texts, voice);
  });
}

function runModel(m) {
  var feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(m.ids, function (n) { return BigInt(n); }), [1, m.ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(m.ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([m.noise, m.length, m.noiseW]), [3])
  };
  if (m.sid) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([BigInt(0)]), [1]);
  return session.run(feeds).then(function (out) {
    var o = out.output || out[session.outputNames[0]];
    return new Float32Array(o.data);               // copia: così si può "spedire" senza duplicarla
  });
}

function handle(m) {
  if (m.cmd === 'load') {
    if (session && session.release) { try { session.release(); } catch (e) {} }
    session = null;
    return ort.InferenceSession.create(m.buf, { executionProviders: ['wasm'], enableMemPattern: false, enableCpuMemArena: false, graphOptimizationLevel: 'all' }).then(function (s) {
      session = s; reply(m.id, { ok: true });
    });
  }
  if (m.cmd === 'phonemize') {
    return phonemize(m.texts, m.voice).then(function (ids) { reply(m.id, { ids: ids }); });
  }
  if (m.cmd === 'run') {
    if (!session) throw new Error('Voce non caricata');
    return runModel(m).then(function (pcm) { reply(m.id, { pcm: pcm }, [pcm.buffer]); });
  }
  throw new Error('Comando sconosciuto: ' + m.cmd);
}

// i comandi vengono eseguiti uno alla volta, nell'ordine in cui arrivano
self.onmessage = function (e) {
  var m = e.data;
  chain = chain.then(function () { return handle(m); }).catch(function (err) {
    reply(m.id, { error: String(err && err.message ? err.message : err) });
  });
};
