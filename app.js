/* Lettore - app di lettura vocale offline (PWA) */
(function () {
  'use strict';

  // ---------- Piccole utilità ----------
  function $(id) { return document.getElementById(id); }
  var PAGE = 60; // frasi mostrate per "pagina" sullo schermo

  // ---------- Database (IndexedDB = armadietto interno dell'app) ----------
  var db;
  function openDB() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('lettore', 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('texts', { keyPath: 'id' });
      };
      r.onsuccess = function () { db = r.result; res(); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function dbPut(store, obj) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readwrite');
      t.objectStore(store).put(obj);
      t.oncomplete = res; t.onerror = function () { rej(t.error); };
    });
  }
  function dbGet(store, id) {
    return new Promise(function (res, rej) {
      var q = db.transaction(store).objectStore(store).get(id);
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function dbAll(store) {
    return new Promise(function (res, rej) {
      var q = db.transaction(store).objectStore(store).getAll();
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
  }
  function dbDel(store, id) {
    return new Promise(function (res, rej) {
      var t = db.transaction(store, 'readwrite');
      t.objectStore(store).delete(id);
      t.oncomplete = res; t.onerror = function () { rej(t.error); };
    });
  }

  // ---------- Estrazione del testo dai file ----------
  function cleanText(t) {
    try { t = t.normalize('NFKC'); } catch (e) {}
    return t.replace(/\r/g, '')
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function readTxt(file) { return file.text(); }

  function readHtmlString(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    return htmlDocToText(doc);
  }
  function htmlDocToText(doc) {
    var bad = doc.querySelectorAll('script,style,nav');
    for (var i = 0; i < bad.length; i++) bad[i].remove();
    var els = doc.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li,div,br,tr');
    for (var j = 0; j < els.length; j++) els[j].appendChild(doc.createTextNode('\n'));
    return (doc.body ? doc.body.textContent : doc.textContent) || '';
  }

  function readDocx(file) {
    return file.arrayBuffer().then(function (buf) {
      return mammoth.extractRawText({ arrayBuffer: buf });
    }).then(function (r) { return r.value; });
  }

  function readPdf(file, onProgress) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    return file.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var out = [];
      function page(n) {
        if (n > pdf.numPages) return Promise.resolve(out.join('\n\n'));
        onProgress('PDF: pagina ' + n + ' di ' + pdf.numPages);
        return pdf.getPage(n).then(function (p) { return p.getTextContent(); })
          .then(function (tc) {
            var s = '';
            for (var i = 0; i < tc.items.length; i++) {
              var it = tc.items[i];
              s += it.str + (it.hasEOL ? (/[A-Za-zÀ-ÿ]-$/.test(it.str) ? '' : ' ') : '');
            }
            out.push(s.replace(/\s+/g, ' ').trim());
            return page(n + 1);
          });
      }
      return page(1);
    });
  }

  function readEpub(file, setTitle) {
    return file.arrayBuffer().then(function (buf) { return JSZip.loadAsync(buf); })
      .then(function (zip) {
        return zip.file('META-INF/container.xml').async('string').then(function (c) {
          var cdoc = new DOMParser().parseFromString(c, 'application/xml');
          var rf = cdoc.querySelector('rootfile');
          var opfPath = rf.getAttribute('full-path');
          return zip.file(opfPath).async('string').then(function (opf) {
            var odoc = new DOMParser().parseFromString(opf, 'application/xml');
            var tEl = odoc.getElementsByTagName('dc:title')[0];
            if (tEl && tEl.textContent.trim()) setTitle(tEl.textContent.trim());
            var base = opfPath.indexOf('/') >= 0 ? opfPath.substring(0, opfPath.lastIndexOf('/') + 1) : '';
            var man = {};
            var items = odoc.querySelectorAll('manifest > item, manifest item');
            for (var i = 0; i < items.length; i++) man[items[i].getAttribute('id')] = items[i].getAttribute('href');
            var refs = odoc.querySelectorAll('spine > itemref, spine itemref');
            var paths = [];
            for (var k = 0; k < refs.length; k++) {
              var h = man[refs[k].getAttribute('idref')];
              if (h) paths.push(base + decodeURIComponent(h.split('#')[0]));
            }
            var out = [];
            function next(n) {
              if (n >= paths.length) return Promise.resolve(out.join('\n\n'));
              var f = zip.file(paths[n]);
              if (!f) return next(n + 1);
              return f.async('string').then(function (x) {
                var d = new DOMParser().parseFromString(x, 'text/html');
                out.push(htmlDocToText(d));
                return next(n + 1);
              });
            }
            return next(0);
          });
        });
      });
  }

  // ---------- Importazione ----------
  function setStatus(msg) {
    var s = $('status');
    s.textContent = msg || '';
    s.style.display = msg ? 'block' : 'none';
  }

  function importFile(file) {
    var name = file.name || 'Senza titolo';
    var ext = (name.split('.').pop() || '').toLowerCase();
    var title = name.replace(/\.[^.]+$/, '');
    var p;
    setStatus('Leggo: ' + name + ' …');
    if (ext === 'pdf') p = readPdf(file, setStatus);
    else if (ext === 'docx') p = readDocx(file);
    else if (ext === 'epub') p = readEpub(file, function (t) { title = t; });
    else if (ext === 'html' || ext === 'htm') p = file.text().then(readHtmlString);
    else if (ext === 'doc') return Promise.reject(new Error('Il vecchio formato .doc non è supportato: salvalo come .docx da Word/Pages.'));
    else p = readTxt(file);
    return p.then(function (raw) {
      var text = cleanText(raw);
      if (text.length < 20) throw new Error('Nessun testo trovato (forse è un PDF scansionato, cioè fatto di sole immagini).');
      var id = 'b' + Date.now() + Math.floor(Math.random() * 1000);
      var total = splitSentences(text).length;
      return dbPut('texts', { id: id, text: text }).then(function () {
        return dbPut('books', { id: id, title: title, pos: 0, total: total, added: Date.now(), last: Date.now() });
      });
    });
  }

  // ---------- Divisione in frasi ----------
  function splitSentences(text) {
    var out = [];
    var paras = text.split(/\n+/);
    for (var p = 0; p < paras.length; p++) {
      var para = paras[p].trim();
      if (!para) continue;
      var parts = para.match(/[\s\S]+?(?:[.!?…]+["'»”’)\]]*(?=\s|$)|$)/g) || [para];
      var first = true;
      for (var i = 0; i < parts.length; i++) {
        var s = parts[i].trim();
        if (!s) continue;
        var chunks = chunkLong(s);
        for (var c = 0; c < chunks.length; c++) {
          out.push({ t: chunks[c], br: first });
          first = false;
        }
      }
    }
    return out;
  }
  function chunkLong(s) {
    var MAX = 280;
    if (s.length <= MAX) return [s];
    var res = [], cur = '';
    var pieces = s.split(/(?<=[,;:])\s+/);
    for (var i = 0; i < pieces.length; i++) {
      var pc = pieces[i];
      if (pc.length > MAX) {
        if (cur) { res.push(cur); cur = ''; }
        var words = pc.split(' '), w = '';
        for (var k = 0; k < words.length; k++) {
          if ((w + ' ' + words[k]).length > MAX && w) { res.push(w); w = words[k]; }
          else w = w ? w + ' ' + words[k] : words[k];
        }
        if (w) res.push(w);
      } else if ((cur + ' ' + pc).length > MAX && cur) {
        res.push(cur); cur = pc;
      } else {
        cur = cur ? cur + ' ' + pc : pc;
      }
    }
    if (cur) res.push(cur);
    return res;
  }

  // ---------- Libreria ----------
  function showView(id) {
    $('v-lib').className = 'view' + (id === 'v-lib' ? ' on' : '');
    $('v-read').className = 'view' + (id === 'v-read' ? ' on' : '');
  }

  function renderList() {
    dbAll('books').then(function (books) {
      books.sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
      var box = $('list');
      box.innerHTML = '';
      if (!books.length) {
        box.innerHTML = '<div class="empty"><b>Nessun libro ancora.</b><br>Tocca <b>+ Aggiungi</b> per caricare un PDF, EPUB, Word o TXT dall\'app File del tuo iPhone.</div>';
        return;
      }
      books.forEach(function (b) {
        var pct = b.total ? Math.round(100 * b.pos / b.total) : 0;
        var d = document.createElement('div');
        d.className = 'book';
        var t = document.createElement('div');
        t.className = 't';
        var bt = document.createElement('b'); bt.textContent = b.title;
        var sm = document.createElement('small'); sm.textContent = pct + '% letto';
        var bar = document.createElement('div'); bar.className = 'bar';
        bar.innerHTML = '<i style="width:' + pct + '%"></i>';
        t.appendChild(bt); t.appendChild(sm); t.appendChild(bar);
        var del = document.createElement('button'); del.textContent = '🗑';
        d.appendChild(t); d.appendChild(del);
        t.onclick = function () { openBook(b.id); };
        del.onclick = function () {
          if (confirm('Eliminare "' + b.title + '"?')) {
            Promise.all([dbDel('books', b.id), dbDel('texts', b.id)]).then(renderList);
          }
        };
        box.appendChild(d);
      });
    });
  }

  $('add').onclick = function () { $('file').click(); };
  $('file').onchange = function () {
    var files = Array.prototype.slice.call(this.files);
    var input = this;
    if (!files.length) return;
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return importFile(f).catch(function (e) { alert(f.name + ':\n' + e.message); });
      });
    });
    chain.then(function () { setStatus(''); input.value = ''; renderList(); });
  };

  // ---------- Lettore ----------
  var book = null, sents = [], cur = 0, playing = false, gen = 0;
  var pageStart = -1, spans = [];
  var voices = [], voice = null;
  var sleepTimer = null, wake = null;
  var cfg = { voiceURI: '', rate: 1, pitch: 1, symbols: true };
  try { var sv = JSON.parse(localStorage.getItem('lettore-cfg')); if (sv) for (var k in sv) cfg[k] = sv[k]; } catch (e) {}
  function saveCfg() { try { localStorage.setItem('lettore-cfg', JSON.stringify(cfg)); } catch (e) {} }

  function openBook(id) {
    Promise.all([dbGet('books', id), dbGet('texts', id)]).then(function (r) {
      book = r[0];
      sents = splitSentences(r[1].text);
      cur = Math.min(book.pos || 0, Math.max(0, sents.length - 1));
      $('rtitle').textContent = book.title;
      $('pos').max = Math.max(0, sents.length - 1);
      pageStart = -1;
      showView('v-read');
      show(cur, true);
    });
  }

  function renderPage(start) {
    pageStart = start;
    var box = $('text');
    box.innerHTML = '';
    spans = [];
    var p = null;
    var end = Math.min(sents.length, start + PAGE);
    for (var i = start; i < end; i++) {
      if (!p || sents[i].br) {
        p = document.createElement('p');
        p.style.margin = '0 0 1em';
        box.appendChild(p);
      }
      var sp = document.createElement('span');
      sp.className = 's';
      sp.setAttribute('data-i', i);
      sp.textContent = sents[i].t + ' ';
      p.appendChild(sp);
      spans.push(sp);
    }
    box.scrollTop = 0;
  }

  function show(i, instant) {
    cur = i;
    var start = Math.floor(i / PAGE) * PAGE;
    if (start !== pageStart) renderPage(start);
    for (var k = 0; k < spans.length; k++) spans[k].classList.remove('cur');
    var el = spans[i - pageStart];
    if (el) {
      el.classList.add('cur');
      el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    }
    $('pos').value = i;
    var pct = sents.length ? Math.round(100 * i / sents.length) : 0;
    $('pg').textContent = 'Frase ' + (i + 1) + ' di ' + sents.length + ' · ' + pct + '%';
    if (book) {
      book.pos = i; book.total = sents.length; book.last = Date.now();
      dbPut('books', book);
    }
  }

  $('text').addEventListener('click', function (e) {
    var t = e.target;
    if (t.classList && t.classList.contains('s')) {
      var i = parseInt(t.getAttribute('data-i'), 10);
      if (playing) speak(i); else show(i);
    }
  });

  // ---- Trasformazione del testo per la voce (solo per l'audio, lo schermo resta uguale) ----
  var SYM_IT = { '%': ' per cento ', '&': ' e ', '€': ' euro ', '$': ' dollari ', '£': ' sterline ',
    '@': ' chiocciola ', '#': ' cancelletto ', '+': ' più ', '=': ' uguale ', '<': ' minore di ',
    '>': ' maggiore di ', '/': ' barra ', '\\': ' barra rovesciata ', '*': ' asterisco ',
    '_': ' trattino basso ', '^': ' accento circonflesso ', '~': ' tilde ', '|': ' barra verticale ',
    '°': ' gradi ', '§': ' paragrafo ', '©': ' copyright ', '®': ' marchio registrato ',
    '™': ' marchio ', '×': ' per ', '÷': ' diviso ', '±': ' più o meno ', '≤': ' minore o uguale a ',
    '≥': ' maggiore o uguale a ', '≠': ' diverso da ', '∞': ' infinito ', '→': ' freccia ',
    '←': ' freccia ', '•': ' ', '⁄': ' su ' };
  var SYM_EN = { '%': ' percent ', '&': ' and ', '€': ' euro ', '$': ' dollars ', '£': ' pounds ',
    '@': ' at ', '#': ' hash ', '+': ' plus ', '=': ' equals ', '<': ' less than ',
    '>': ' greater than ', '/': ' slash ', '\\': ' backslash ', '*': ' asterisk ',
    '_': ' underscore ', '^': ' caret ', '~': ' tilde ', '|': ' bar ', '°': ' degrees ',
    '§': ' section ', '©': ' copyright ', '®': ' registered ', '™': ' trademark ', '×': ' times ',
    '÷': ' divided by ', '±': ' plus or minus ', '≤': ' less than or equal to ',
    '≥': ' greater than or equal to ', '≠': ' not equal to ', '∞': ' infinity ', '→': ' arrow ',
    '←': ' arrow ', '•': ' ', '⁄': ' over ' };
  var SYM_RE = /[%&€$£@#+=<>\/\\*_^~|°§©®™×÷±≤≥≠∞→←•⁄]/g;

  function spokenText(i) {
    var t = sents[i].t;
    try { t = t.normalize('NFKC'); } catch (e) {}              // ligature (ﬁ, ﬂ) e simboli strani -> normali
    t = t.replace(/[­​-‍⁠﻿]/g, '');   // caratteri invisibili
    t = t.replace(/([\-_=*~#•·.])\1{2,}/g, ', ');              // *** --- ... diventano una pausa
    // PAROLE IN STAMPATELLO: in minuscolo, altrimenti la voce le sillaba lettera per lettera
    t = t.replace(/(^|[^A-Za-zÀ-ÿ])([A-ZÀ-ÖØ-Þ]{4,})(?![A-Za-zÀ-ÿ])/g, function (m, a, b) { return a + b.toLowerCase(); });
    if (cfg.symbols) {
      var lang = (voice && voice.lang ? voice.lang : 'it').toLowerCase().substring(0, 2);
      var map = lang === 'it' ? SYM_IT : (lang === 'en' ? SYM_EN : null);
      if (map) t = t.replace(SYM_RE, function (c) { return map[c] || ' '; });
    }
    t = t.replace(/\s+/g, ' ').trim();
    return /[\p{L}\p{N}]/u.test(t) ? t : '';   // frasi di soli simboli muti: saltate
  }

  // ---- Lettura fluida: la frase successiva è già in coda prima che finisca la corrente ----
  var finalIdx = -1, lastQ = -1, utts = [];

  function enqueue(i, g) {
    var txt = '';
    while (i < sents.length) { txt = spokenText(i); if (txt) break; i++; }
    if (i >= sents.length) return false;
    var idx = i;
    var u = new SpeechSynthesisUtterance(txt);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'it-IT'; }
    u.rate = cfg.rate; u.pitch = cfg.pitch;
    u.onstart = function () {
      if (g !== gen) return;
      show(idx);
      if (!enqueue(idx + 1, g)) finalIdx = idx;
    };
    u.onend = function () {
      if (g !== gen || !playing) return;
      if (idx === finalIdx || (lastQ <= idx && !enqueue(idx + 1, g))) pause();
    };
    u.onerror = function (e) {
      if (g !== gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      setTimeout(function () { if (g === gen && playing) speak(idx + 1); }, 200);
    };
    lastQ = idx;
    utts.push(u); if (utts.length > 6) utts.shift();   // tiene le frasi "vive" in memoria
    window.speechSynthesis.speak(u);
    return true;
  }

  function speak(i) {
    if (i < 0 || i >= sents.length) { pause(); return; }
    playing = true;
    updatePlayBtn();
    show(i);
    var g = ++gen;
    finalIdx = -1; lastQ = -1;
    window.speechSynthesis.cancel();
    setTimeout(function () { if (g === gen) enqueue(i, g); }, 80);
    requestWake();
  }

  function pause() {
    playing = false; gen++;
    window.speechSynthesis.cancel();
    updatePlayBtn();
    releaseWake();
  }

  function updatePlayBtn() { $('play').textContent = playing ? '⏸ Pausa' : '▶ Leggi'; }

  $('play').onclick = function () { if (playing) pause(); else speak(cur); };
  $('next').onclick = function () { var n = Math.min(sents.length - 1, cur + 1); if (playing) speak(n); else show(n); };
  $('prev').onclick = function () { var n = Math.max(0, cur - 1); if (playing) speak(n); else show(n); };
  $('pos').onchange = function () { var n = parseInt(this.value, 10); if (playing) speak(n); else show(n, true); };
  $('back').onclick = function () { pause(); clearSleep(); showView('v-lib'); renderList(); };
  $('gear').onclick = function () { $('set').classList.toggle('on'); };

  // ---------- Voci e impostazioni ----------
  function langName(code) {
    try {
      var n = new Intl.DisplayNames(['it'], { type: 'language' }).of(code);
      if (n && n !== code) return n.charAt(0).toUpperCase() + n.slice(1);
    } catch (e) {}
    return code;
  }
  var lastCount = -1;
  function loadVoices() {
    var all = window.speechSynthesis.getVoices();
    if (!all.length || all.length === lastCount) return;
    lastCount = all.length;
    var seen = {}, groups = {};
    all.forEach(function (v) {
      if (seen[v.voiceURI]) return;
      seen[v.voiceURI] = 1;
      var lg = (v.lang || 'und').replace('_', '-');
      (groups[lg] = groups[lg] || []).push(v);
    });
    var langs = Object.keys(groups).sort(function (a, b) {
      var ai = a.toLowerCase().indexOf('it') === 0 ? 0 : 1;
      var bi = b.toLowerCase().indexOf('it') === 0 ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return langName(a).localeCompare(langName(b), 'it');
    });
    var sel = $('voice');
    sel.innerHTML = '';
    voices = [];
    langs.forEach(function (lg) {
      var og = document.createElement('optgroup');
      og.label = langName(lg) + ' · ' + lg;
      groups[lg].sort(function (a, b) { return a.name.localeCompare(b.name); });
      groups[lg].forEach(function (v) {
        var o = document.createElement('option');
        o.value = voices.length; o.textContent = v.name;
        og.appendChild(o); voices.push(v);
      });
      sel.appendChild(og);
    });
    var idx = -1;
    for (var i = 0; i < voices.length; i++) if (voices[i].voiceURI === cfg.voiceURI) idx = i;
    if (idx < 0) idx = 0; // la prima è nel gruppo italiano
    sel.value = idx; voice = voices[idx];
    $('vlabel').textContent = 'Voce (' + voices.length + ' sul telefono)';
  }
  if ('speechSynthesis' in window) {
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
    var vTries = 0;
    var vTimer = setInterval(function () { loadVoices(); if (++vTries > 20) clearInterval(vTimer); }, 500);
  } else {
    alert('Questo browser non supporta la sintesi vocale.');
  }

  $('sym').checked = cfg.symbols;
  $('sym').onchange = function () {
    cfg.symbols = this.checked; saveCfg();
    if (playing) speak(cur);
  };
  $('demo').onclick = function () {
    pause();
    var u = new SpeechSynthesisUtterance((spokenText(cur) || 'Prova della voce').substring(0, 200));
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = cfg.rate; u.pitch = cfg.pitch;
    window._d = u;
    window.speechSynthesis.speak(u);
  };

  $('voice').onchange = function () {
    voice = voices[parseInt(this.value, 10)];
    cfg.voiceURI = voice.voiceURI; saveCfg();
    if (playing) speak(cur);
  };
  $('rate').value = cfg.rate; $('rv').textContent = cfg.rate + '×';
  $('pitch').value = cfg.pitch; $('pv').textContent = cfg.pitch;
  $('rate').onchange = function () {
    cfg.rate = parseFloat(this.value); saveCfg(); $('rv').textContent = cfg.rate + '×';
    if (playing) speak(cur);
  };
  $('rate').oninput = function () { $('rv').textContent = this.value + '×'; };
  $('pitch').onchange = function () {
    cfg.pitch = parseFloat(this.value); saveCfg(); $('pv').textContent = cfg.pitch;
    if (playing) speak(cur);
  };
  $('pitch').oninput = function () { $('pv').textContent = this.value; };

  // ---------- Timer di spegnimento ----------
  function clearSleep() { if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; } $('sleep').value = '0'; }
  $('sleep').onchange = function () {
    if (sleepTimer) clearTimeout(sleepTimer);
    var m = parseInt(this.value, 10);
    if (m > 0) sleepTimer = setTimeout(function () { pause(); $('sleep').value = '0'; }, m * 60000);
  };

  // ---------- Schermo sempre acceso durante la lettura ----------
  function requestWake() {
    if (!('wakeLock' in navigator) || wake) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wake = l; l.addEventListener('release', function () { wake = null; });
    }).catch(function () {});
  }
  function releaseWake() { if (wake) { wake.release(); wake = null; } }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && playing) requestWake();
  });

  // ---------- Avvio ----------
  openDB().then(function () {
    renderList();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
