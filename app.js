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
        if (n > pdf.numPages) return Promise.resolve(out);
        onProgress('PDF: pagina ' + n + ' di ' + pdf.numPages);
        return pdf.getPage(n).then(function (p) { return p.getTextContent(); })
          .then(function (tc) {
            var s = '';
            for (var i = 0; i < tc.items.length; i++) {
              var it = tc.items[i];
              s += it.str + (it.hasEOL ? (/[A-Za-zÀ-ÿ]-$/.test(it.str) ? '' : ' ') : '');
            }
            out.push({ label: 'Pagina ' + n, p: n, text: s.replace(/\s+/g, ' ').trim() });
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
              if (n >= paths.length) return Promise.resolve(out);
              var f = zip.file(paths[n]);
              if (!f) return next(n + 1);
              return f.async('string').then(function (x) {
                var d = new DOMParser().parseFromString(x, 'text/html');
                out.push({ label: 'c', p: 0, text: htmlDocToText(d) });
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
    var kind = 'sez';
    var p;
    function one(t) { return [{ label: '', p: 0, text: t }]; }
    setStatus('Leggo: ' + name + ' …');
    if (ext === 'pdf') { kind = 'pdf'; p = readPdf(file, setStatus); }
    else if (ext === 'docx') p = readDocx(file).then(one);
    else if (ext === 'epub') { kind = 'epub'; p = readEpub(file, function (t) { title = t; }); }
    else if (ext === 'html' || ext === 'htm') p = file.text().then(readHtmlString).then(one);
    else if (ext === 'doc') return Promise.reject(new Error('Il vecchio formato .doc non è supportato: salvalo come .docx da Word/Pages.'));
    else p = readTxt(file).then(one);
    return p.then(function (secs) {
      var parts = [], marks = [], n = 0, k = 0;
      secs.forEach(function (sc) {
        var c = cleanText(sc.text);
        if (!c) return;
        var cnt = splitSentences(c).length;
        if (!cnt) return;
        if (kind === 'pdf') marks.push({ n: sc.label, p: sc.p, i: n });
        else if (kind === 'epub') { k++; marks.push({ n: 'Capitolo ' + k, p: k, i: n }); }
        parts.push(c); n += cnt;
      });
      var text = parts.join('\n\n');
      if (text.length < 20) throw new Error('Nessun testo trovato (forse è un PDF scansionato, cioè fatto di sole immagini).');
      var id = 'b' + Date.now() + Math.floor(Math.random() * 1000);
      var total = splitSentences(text).length;
      return dbPut('texts', { id: id, text: text }).then(function () {
        return dbPut('books', { id: id, title: title, pos: 0, total: total, kind: kind,
          marks: marks, added: Date.now(), last: Date.now() });
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
  var pageStart = -1, spans = [], curEl = null;
  var voices = [], voice = null;
  var marks = [], mkind = 'sez';
  var sleepTimer = null, wake = null;
  var cfg = { voiceURI: '', rate: 1, pitch: 1, symbols: true, theme: 'dark', fs: 19, pauseMs: 400 };
  try { var sv = JSON.parse(localStorage.getItem('lettore-cfg')); if (sv) for (var k in sv) cfg[k] = sv[k]; } catch (e) {}
  function saveCfg() { try { localStorage.setItem('lettore-cfg', JSON.stringify(cfg)); } catch (e) {} }

  function openBook(id) {
    Promise.all([dbGet('books', id), dbGet('texts', id)]).then(function (r) {
      book = r[0];
      sents = splitSentences(r[1].text);
      if (book.marks && book.marks.length) {
        marks = book.marks.filter(function (m) { return m.i < sents.length; });
        mkind = book.kind || 'sez';
      } else {
        marks = []; mkind = 'sez';
        for (var q = 0, z = 1; q < sents.length; q += 40, z++) marks.push({ n: 'Sezione ' + z, p: z, i: q });
      }
      cur = Math.min(book.pos || 0, Math.max(0, sents.length - 1));
      $('rtitle').textContent = book.title;
      $('pos').max = Math.max(0, sents.length - 1);
      pageStart = -1;
      try { localStorage.setItem('lettore-open', String(id)); } catch (e) {}
      showView('v-read');
      updatePlayBtn();
      show(cur, true);
      if (voice && voice.piper && piperDone[voice.def.key]) piperEnsure(voice.def).catch(function () {});
    });
  }

  var pageEnd = 0, lastRender = 0;
  function buildSpans(from, to, into, joinLast) {
    var p = joinLast ? into.lastChild : null, arr = [];
    for (var i = from; i < to; i++) {
      if (!p || sents[i].br) {
        p = document.createElement('p');
        p.style.margin = '0 0 1em';
        into.appendChild(p);
      }
      var sp = document.createElement('span');
      sp.className = 's';
      sp.setAttribute('data-i', i);
      sp.textContent = sents[i].t + ' ';
      p.appendChild(sp);
      arr.push(sp);
    }
    return arr;
  }
  function renderPage(start) {
    pageStart = start;
    pageEnd = Math.min(sents.length, start + PAGE);
    var box = $('text');
    box.innerHTML = '';
    spans = buildSpans(start, pageEnd, box, false);
    box.scrollTop = 0;
    lastRender = Date.now();
  }
  // scorrendo, il testo si allunga da solo in alto e in basso: si può girare tutto il documento
  $('text').addEventListener('scroll', function () {
    if (!sents.length || Date.now() - lastRender < 500) return;
    var box = this;
    if (pageEnd < sents.length && box.scrollTop + box.clientHeight > box.scrollHeight - 900) {
      var to = Math.min(sents.length, pageEnd + PAGE);
      var add = buildSpans(pageEnd, to, box, !sents[pageEnd].br);
      spans = spans.concat(add); pageEnd = to;
    } else if (pageStart > 0 && box.scrollTop < 700) {
      var from = Math.max(0, pageStart - PAGE), h0 = box.scrollHeight, t0 = box.scrollTop;
      var tmp = document.createElement('div');
      var add2 = buildSpans(from, pageStart, tmp, false);
      var fr = document.createDocumentFragment();
      while (tmp.firstChild) fr.appendChild(tmp.firstChild);
      box.insertBefore(fr, box.firstChild);
      spans = add2.concat(spans); pageStart = from;
      box.scrollTop = t0 + (box.scrollHeight - h0);
    }
  });

  function markAt(i) {
    var lo = 0, hi = marks.length - 1, r = -1;
    while (lo <= hi) {
      var m = (lo + hi) >> 1;
      if (marks[m].i <= i) { r = m; lo = m + 1; } else hi = m - 1;
    }
    return r;
  }

  function show(i, instant) {
    cur = i;
    if (pageStart < 0 || i < pageStart || i >= pageEnd) { renderPage(Math.floor(i / PAGE) * PAGE); instant = true; }
    if (curEl) curEl.classList.remove('cur');
    var el = spans[i - pageStart];
    curEl = el || null;
    if (el) {
      el.classList.add('cur');
      el.scrollIntoView({ block: 'center', behavior: instant ? 'auto' : 'smooth' });
    }
    $('pos').value = i;
    var pct = sents.length ? Math.round(100 * i / sents.length) : 0;
    var mk = markAt(i), where = '';
    if (mk >= 0) {
      where = marks[mk].n;
      if (mkind === 'pdf') where += ' di ' + marks[marks.length - 1].p;
      where += ' · ';
    }
    $('pg').textContent = where + pct + '%';
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
      var nx = idx + 1;
      // a fine paragrafo non metto in coda la frase dopo: lascio una piccola pausa, come un lettore umano
      if (nx < sents.length && sents[nx].br && cfg.pauseMs > 0) return;
      if (!enqueue(nx, g)) finalIdx = idx;
    };
    u.onend = function () {
      if (g !== gen || !playing) return;
      if (idx === finalIdx) { pause(); return; }
      if (lastQ > idx) return;
      var nx = idx + 1;
      function go() { if (g === gen && playing && !enqueue(nx, g)) pause(); }
      if (nx < sents.length && sents[nx].br && cfg.pauseMs > 0) setTimeout(go, cfg.pauseMs); else go();
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
    if (voice && voice.piper) { piperSpeak(i); return; }
    piperStop();
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
    piperStop();
    updatePlayBtn();
    releaseWake();
  }

  var ICO_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var ICO_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  function updatePlayBtn() {
    $('play').innerHTML = (playing ? ICO_PAUSE : ICO_PLAY) + '<span>' + (playing ? 'Pausa' : 'Leggi') + '</span>';
  }

  $('play').onclick = function () { if (playing) pause(); else speak(cur); };
  $('next').onclick = function () { var n = Math.min(sents.length - 1, cur + 1); if (playing) speak(n); else show(n); };
  $('prev').onclick = function () { var n = Math.max(0, cur - 1); if (playing) speak(n); else show(n); };
  $('pos').onchange = function () { var n = parseInt(this.value, 10); if (playing) speak(n); else show(n, true); };
  $('back').onclick = function () { try { localStorage.removeItem('lettore-open'); } catch (e) {} pause(); clearSleep(); closeSheets(); showView('v-lib'); renderList(); };

  // ---------- Pannelli che salgono dal basso ----------
  function closeSheets() {
    $('sheet-pages').classList.remove('open');
    $('sheet-set').classList.remove('open');
    $('bk').classList.remove('on');
  }
  function openSheet(id) {
    closeSheets();
    $(id).classList.add('open');
    $('bk').classList.add('on');
  }
  $('bk').onclick = closeSheets;
  $('gear').onclick = function () { openSheet('sheet-set'); };

  // ---------- Pagine ----------
  function goMark(k) {
    closeSheets();
    var i = marks[k].i;
    if (playing) speak(i); else show(i, true);
  }
  $('pages').onclick = function () {
    if (!marks.length) return;
    var grid = $('pgrid');
    grid.innerHTML = '';
    $('ph').textContent = mkind === 'pdf' ? 'Pagine' : (mkind === 'epub' ? 'Capitoli' : 'Sezioni');
    $('gp').value = '';
    $('gp').placeholder = 'Numero (1-' + marks[marks.length - 1].p + ')';
    grid.className = mkind === 'epub' ? 'list' : '';
    var cm = markAt(cur);
    marks.forEach(function (m, k) {
      var b = document.createElement('button');
      b.textContent = mkind === 'epub' ? m.n : m.p;
      if (k === cm) b.className = 'on';
      b.onclick = function () { goMark(k); };
      grid.appendChild(b);
    });
    openSheet('sheet-pages');
    setTimeout(function () { var on = grid.querySelector('.on'); if (on) on.scrollIntoView({ block: 'center' }); }, 60);
  };
  function gotoNumber() {
    var n = parseInt($('gp').value, 10);
    if (!n || n < 1) return;
    var k = marks.length - 1;
    for (var j = 0; j < marks.length; j++) if (marks[j].p >= n) { k = j; break; }
    goMark(k);
  }
  $('gogo').onclick = gotoNumber;
  $('gp').onkeydown = function (e) { if (e.key === 'Enter') gotoNumber(); };

  // ---------- Sfondo e dimensione del testo ----------
  var THEMES = { dark: '#14161a', white: '#ffffff', gray: '#e3e3df', sepia: '#f4ecd8' };
  function applyTheme(t) {
    if (!THEMES[t]) t = 'dark';
    cfg.theme = t;
    document.documentElement.setAttribute('data-theme', t);
    $('tc').setAttribute('content', THEMES[t]);
    var sw = document.querySelectorAll('#sws .sw');
    for (var i = 0; i < sw.length; i++) sw[i].classList.toggle('on', sw[i].getAttribute('data-t') === t);
  }
  (function () {
    var sw = document.querySelectorAll('#sws .sw');
    for (var i = 0; i < sw.length; i++) sw[i].onclick = function () { applyTheme(this.getAttribute('data-t')); saveCfg(); };
    applyTheme(cfg.theme);
    // fascia scura sotto l'orologio dell'iPhone: con gli sfondi chiari l'orologio bianco resterebbe illeggibile
    var sb = document.createElement('div');
    sb.style.cssText = 'position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top);background:#14161a;z-index:30;pointer-events:none';
    document.body.appendChild(sb);
  })();
  function applyFs() { $('text').style.fontSize = cfg.fs + 'px'; $('fsv').textContent = cfg.fs + ' px'; $('fs').value = cfg.fs; }
  applyFs();
  $('fs').oninput = function () { cfg.fs = parseInt(this.value, 10); applyFs(); };
  $('fs').onchange = function () { saveCfg(); var el = spans[cur - pageStart]; if (el) el.scrollIntoView({ block: 'center' }); };

  // ---------- Stili di voce (Naturale, Calda, ...) ----------
  function syncChips() {
    var cs = document.querySelectorAll('#chips .chip');
    for (var i = 0; i < cs.length; i++) {
      var on = Math.abs(parseFloat(cs[i].getAttribute('data-r')) - cfg.rate) < 0.001 &&
               Math.abs(parseFloat(cs[i].getAttribute('data-p')) - cfg.pitch) < 0.001;
      cs[i].classList.toggle('on', on);
    }
  }
  (function () {
    var cs = document.querySelectorAll('#chips .chip');
    for (var i = 0; i < cs.length; i++) cs[i].onclick = function () {
      cfg.rate = parseFloat(this.getAttribute('data-r'));
      cfg.pitch = parseFloat(this.getAttribute('data-p'));
      $('rate').value = cfg.rate; $('rv').textContent = cfg.rate + '×';
      $('pitch').value = cfg.pitch; $('pv').textContent = cfg.pitch;
      saveCfg(); syncChips();
      if (playing) speak(cur);
    };
  })();

  // ---------- Voci neurali Piper (naturali, gratuite, funzionano offline) ----------
  var piperDefs = [], piperDone = {}, pState = null, pKey = '', pLoading = {}, pAudio = null, pSink = null;
  var toastT = null;

  function toast(msg, ms) {
    var t = $('toast');
    if (!t) {
      t = document.createElement('div'); t.id = 'toast';
      t.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(170px + env(safe-area-inset-bottom));z-index:40;' +
        'background:var(--card);color:var(--txt);border:1px solid var(--bd);border-radius:12px;padding:12px 14px;' +
        'text-align:center;font-size:14px;box-shadow:0 6px 20px rgba(0,0,0,.3);display:none';
      document.body.appendChild(t);
    }
    clearTimeout(toastT);
    t.textContent = msg || '';
    t.style.display = msg ? 'block' : 'none';
    if (msg && ms) toastT = setTimeout(function () { t.style.display = 'none'; }, ms);
  }
  function mbText(n) { return n ? Math.round(n / 1e6) + ' MB' : ''; }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // audio grezzo -> file WAV (con una piccola pausa di silenzio in coda)
  function wavBlob(pcm, rate, padSec) {
    var pad = Math.round(rate * padSec), n = pcm.length + pad;
    var dv = new DataView(new ArrayBuffer(44 + n * 2)), o = 0;
    function w(t) { for (var i = 0; i < t.length; i++) dv.setUint8(o++, t.charCodeAt(i)); }
    w('RIFF'); dv.setUint32(o, 36 + n * 2, true); o += 4; w('WAVEfmt '); dv.setUint32(o, 16, true); o += 4;
    dv.setUint16(o, 1, true); o += 2; dv.setUint16(o, 1, true); o += 2; dv.setUint32(o, rate, true); o += 4;
    dv.setUint32(o, rate * 2, true); o += 4; dv.setUint16(o, 2, true); o += 2; dv.setUint16(o, 16, true); o += 2;
    w('data'); dv.setUint32(o, n * 2, true); o += 4;
    for (var i = 0; i < pcm.length; i++) {
      var x = Math.max(-1, Math.min(1, pcm[i]));
      dv.setInt16(o, x < 0 ? x * 32768 : x * 32767, true); o += 2;
    }
    return new Blob([dv.buffer], { type: 'audio/wav' });
  }

  function piperInit() {
    if (!window.PiperEngine) return;
    PiperEngine.listVoices().then(function (defs) {
      piperDefs = defs;
      PiperEngine.cleanup(defs);   // libera lo spazio delle voci pesanti scaricate in precedenza
      return Promise.all(defs.map(function (d) {
        return PiperEngine.isDownloaded(d).then(function (x) { piperDone[d.key] = x; });
      }));
    }).then(function () { buildVoiceList(); }).catch(function () {});
  }

  // scarica (se serve) e prepara la voce in memoria: la prima volta richiede qualche secondo
  function piperEnsure(def) {
    if (pState && pKey === def.key) return Promise.resolve(pState);
    if (pLoading[def.key]) return pLoading[def.key];
    toast('Preparo la voce… (qualche secondo la prima volta)');
    var p = PiperEngine.loadVoice(def, function (l, t, ph) {
      if (ph === 'init') toast('Preparo la voce…');
      else if (t) toast('Scarico la voce… ' + Math.min(100, Math.round(100 * l / t)) + '%');
    }).then(function (st) {
      pState = st; pKey = def.key; piperDone[def.key] = true;
      var esp = (st.cfg.espeak && st.cfg.espeak.voice) || 'it';
      // un primo giro "a vuoto": la prima frase vera parte poi molto più in fretta
      return PiperEngine.phonemize(['Prova.'], esp).then(function (ids) {
        return ids[0] && ids[0].length ? PiperEngine.run(st, ids[0], 1) : 0;
      }).catch(function () {}).then(function () { toast(''); return st; });
    });
    pLoading[def.key] = p;
    p.then(function () { delete pLoading[def.key]; }, function () { delete pLoading[def.key]; toast(''); });
    return p;
  }

  // riproduttore: un elemento <audio> (come un lettore musicale) che continua anche a schermo bloccato
  var evlog = [];
  function logEv(t) {
    var d = new Date();
    evlog.push(('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) + ' ' + t);
    if (evlog.length > 8) evlog.shift();
    try { showDiag(); } catch (e) {}
  }
  function makeSink(g) {
    if (!pAudio) {
      pAudio = document.createElement('audio');
      pAudio.setAttribute('playsinline', ''); pAudio.preload = 'auto';
      document.body.appendChild(pAudio);
    }
    var au = pAudio, q = [], curItem = null, buffered = 0, stopped = false, done = false, underruns = 0, waiting = false;
    var lastT = Date.now();
    ['pause', 'error', 'stalled', 'waiting', 'emptied', 'suspend'].forEach(function (n) {
      au['on' + n] = function () { if (!stopped && g === gen) logEv('audio: ' + n + (n === 'error' && au.error ? ' ' + au.error.code : '')); };
    });
    au.ontimeupdate = function () { lastT = Date.now(); };
    // guardiano: se l'iPhone ferma l'audio senza avvisare, lo fa ripartire
    var wd = setInterval(function () {
      if (stopped) { clearInterval(wd); return; }
      if (g !== gen) return;
      if (curItem && au.paused && !au.ended) { logEv('riprendo audio'); var r = au.play(); if (r && r.catch) r.catch(function () {}); }
      if (!curItem && q.length && !waiting) { logEv('coda ferma: riparto'); next(); }
      if (curItem && Date.now() - lastT > 12000) {
        var i = curItem.i; lastT = Date.now(); logEv('audio fermo: ripartenza dalla frase ' + i);
        setTimeout(function () { if (g === gen && playing) speak(i); }, 0);
      }
    }, 2000);
    // suono muto partito dal tocco dell'utente: iOS permette poi di continuare da solo
    au.src = URL.createObjectURL(wavBlob(new Float32Array(2205), 22050, 0));
    var p0 = au.play(); if (p0 && p0.catch) p0.catch(function () {});
    // se la voce non riesce a stare al passo, invece di fermarsi a ogni frase accumula un po' di audio e riparte
    function target() { return Math.min(6 + 4 * underruns, 20); }
    function maybeStart() {
      if (stopped || curItem || !q.length) return;
      if (waiting && !done && buffered < target()) return;
      if (waiting) { waiting = false; toast(''); }
      next();
    }
    function next() {
      if (stopped) return;
      if (!q.length) {
        curItem = null;
        if (done && g === gen) { pause(); return; }
        if (!done) { underruns++; waiting = true; toast('Accumulo un po’ di audio per una lettura più fluida…'); }
        return;
      }
      curItem = q.shift(); lastT = Date.now();
      au.src = curItem.url;
      var pp = au.play();
      if (pp && pp.catch) pp.catch(function (e) { if (e.name !== 'AbortError') toast('Audio bloccato: tocca Leggi di nuovo', 4000); });
      if (g === gen) show(curItem.i);
    }
    au.onended = function () {
      if (stopped || !curItem) return;     // la fine del suono muto iniziale non conta
      URL.revokeObjectURL(curItem.url); buffered -= curItem.dur; curItem = null;
      next();
    };
    return {
      add: function (pcm, rate, i) {
        var pad = (sents[i + 1] && sents[i + 1].br && cfg.pauseMs > 0) ? 0.10 + cfg.pauseMs / 1000 : 0.10;
        var dur = pcm.length / rate + pad;
        q.push({ url: URL.createObjectURL(wavBlob(pcm, rate, pad)), dur: dur, i: i });
        buffered += dur;
        maybeStart();
      },
      ahead: function () { return buffered; },
      finish: function () {
        done = true;
        if (!curItem && !q.length) { if (g === gen) pause(); } else maybeStart();
      },
      stop: function () {
        stopped = true; clearInterval(wd); au.onended = null; au.pause();
        if (waiting) toast('');
        q.forEach(function (it) { URL.revokeObjectURL(it.url); }); q = [];
        if (curItem) { URL.revokeObjectURL(curItem.url); curItem = null; }
      }
    };
  }

  function piperStop() { if (pSink) { pSink.stop(); pSink = null; } }

  // misura di quanto è veloce la voce rispetto al parlato (mostrata in fondo alle impostazioni)
  var diag = { gen: 0, aud: 0 };
  function showDiag() {
    var d = $('diag');
    if (!d) {
      d = document.createElement('div'); d.id = 'diag';
      d.style.cssText = 'white-space:pre-wrap;margin-top:18px;font-size:12px;color:var(--mut);text-align:center';
      $('sheet-set').appendChild(d);
    }
    d.textContent = 'Eventi (v10): ' + (evlog.length ? evlog.join(' | ') : 'nessuno') + '\n' + (diag.gen ? 'Velocità della voce neurale: ×' + (diag.aud / diag.gen).toFixed(1) + ' (sopra 1.0 = scorrevole) · calcolo su ' + (PiperEngine.threads ? PiperEngine.threads() : 1) + ' cuore/i' : '');
  }

  // genera l'audio una frase alla volta, restando sempre un po' avanti rispetto alla voce
  function piperLoop(st, sink, g, start) {
    var esp = (st.cfg.espeak && st.cfg.espeak.voice) || 'it';
    function room() { return (g === gen && sink.ahead() > 45) ? sleepMs(300).then(room) : null; }
    function batch(k, size) {
      if (g !== gen) return null;
      var idxs = [], texts = [];
      for (var j = k; j < sents.length && idxs.length < size; j++) {
        var t = spokenText(j);
        if (t) { idxs.push(j); texts.push(t); }
      }
      if (!idxs.length) { sink.finish(); return null; }
      return PiperEngine.phonemize(texts, esp).then(function (all) {
        var chain = Promise.resolve();
        idxs.forEach(function (si, n) {
          chain = chain.then(function () {
            if (g !== gen || !all[n] || !all[n].length) return;
            return Promise.resolve(room()).then(function () {
              if (g !== gen) return;
              var t0 = performance.now();
              function peakOf(pcm) { var m = 0, step = Math.max(1, pcm.length >> 12); for (var q = 0; q < pcm.length; q += step) { var v = Math.abs(pcm[q]); if (v > m || v !== v) m = v !== v ? 99 : v; } return m; }
              return PiperEngine.run(st, all[n], cfg.rate).then(function (r) {
                var pk = peakOf(r.pcm);
                if ((pk < 0.01 || pk > 50) && r.pcm.length > 3000) {   // frase muta o rovinata: nuovo calcolo con un motore nuovo
                  logEv('frase ' + si + ' muta (picco ' + pk.toFixed(3) + '): rifaccio');
                  PiperEngine.forceRecycle();
                  return PiperEngine.run(st, all[n], cfg.rate);
                }
                return r;
              }).then(function (r) {
                if (g !== gen) return;
                diag.gen += (performance.now() - t0) / 1000; diag.aud += r.pcm.length / r.rate; showDiag();
                sink.add(r.pcm, r.rate, si);
              });
            });
          });
        });
        return chain.then(function () { return batch(idxs[idxs.length - 1] + 1, 8); });
      });
    }
    return Promise.resolve(batch(start, 1));   // la prima volta una frase sola, per partire subito
  }

  function piperSpeak(i) {
    playing = true;
    updatePlayBtn();
    show(i);
    var g = ++gen;
    window.speechSynthesis.cancel();
    piperStop();
    diag.gen = 0; diag.aud = 0;
    var sink = makeSink(g);          // va creato subito, dentro il tocco dell'utente
    pSink = sink;
    requestWake();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: book ? book.title : 'Lettura', artist: 'Lettore' }); } catch (e) {}
    }
    piperEnsure(voice.def).then(function (st) { return piperLoop(st, sink, g, i); })
      .catch(function (e) {
        if (g === gen) { pause(); toast('Voce non disponibile: ' + (e && e.message ? e.message : e), 6000); }
      });
  }

  // comandi sulla schermata di blocco dell'iPhone
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { if (!playing) speak(cur); });
      navigator.mediaSession.setActionHandler('pause', function () { pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { $('next').onclick(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { $('prev').onclick(); });
    } catch (e) {}
  }

  // ---------- Voci e impostazioni ----------
  function langName(code) {
    try {
      var n = new Intl.DisplayNames(['it'], { type: 'language' }).of(code);
      if (n && n !== code) return n.charAt(0).toUpperCase() + n.slice(1);
    } catch (e) {}
    return code;
  }
  var sysAll = [], lastCount = -1;
  function loadVoices() {
    var all = window.speechSynthesis.getVoices();
    if (!all.length || all.length === lastCount) return;
    lastCount = all.length; sysAll = all;
    buildVoiceList();
  }
  function buildVoiceList() {
    var sel = $('voice');
    sel.innerHTML = '';
    voices = [];
    if (piperDefs.length) {
      var pg = document.createElement('optgroup');
      pg.label = 'Voci neurali · naturali e offline';
      piperDefs.forEach(function (d) {
        var o = document.createElement('option');
        o.value = voices.length;
        o.textContent = d.label + (piperDone[d.key] ? ' ✓' : ' · da scaricare ' + mbText(d.size));
        pg.appendChild(o);
        voices.push({ piper: true, def: d, name: d.label, lang: 'it-IT', voiceURI: 'piper:' + d.key });
      });
      sel.appendChild(pg);
    }
    var seen = {}, groups = {};
    sysAll.forEach(function (v) {
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
    if (!voices.length) return;
    var idx = -1;
    for (var i = 0; i < voices.length; i++) if (voices[i].voiceURI === cfg.voiceURI) idx = i;
    if (idx < 0) {
      // predefinita: la prima voce del telefono in italiano (meglio se Migliorata/Premium)
      for (var f = 0; f < voices.length; f++) if (!voices[f].piper) { idx = f; break; }
      if (idx < 0) idx = 0;
      for (var q = 0; q < voices.length; q++) {
        if (!voices[q].piper && voices[q].lang.toLowerCase().indexOf('it') === 0 && /premium|enhanced|migliorat/i.test(voices[q].name)) { idx = q; break; }
      }
    }
    sel.value = idx; voice = voices[idx];
    var nSys = voices.filter(function (v) { return !v.piper; }).length;
    $('vlabel').textContent = 'Voce (' + nSys + ' sul telefono' + (piperDefs.length ? ' + ' + piperDefs.length + ' neurali' : '') + ')';
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
    if (voice && voice.piper) { speak(cur); return; }
    var u = new SpeechSynthesisUtterance((spokenText(cur) || 'Prova della voce').substring(0, 200));
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    u.rate = cfg.rate; u.pitch = cfg.pitch;
    window._d = u;
    window.speechSynthesis.speak(u);
  };

  function selectVoice(v) {
    voice = v; cfg.voiceURI = v.voiceURI; saveCfg();
    $('voice').value = voices.indexOf(v);
    if (v.piper) piperEnsure(v.def).catch(function () {});   // la preparo subito: all'avvio della lettura sarà già pronta
    if (playing) speak(cur);
  }
  $('voice').onchange = function () {
    var v = voices[parseInt(this.value, 10)], sel = this;
    if (!v) return;
    if (v.piper && !piperDone[v.def.key]) {
      if (!confirm('Scaricare la voce "' + v.def.label + '"?\n\nCirca ' + mbText(v.def.size) +
          ': meglio con il Wi-Fi. Si scarica una volta sola, poi funziona anche senza internet.')) {
        sel.value = voices.indexOf(voice); return;
      }
      pause();
      piperEnsure(v.def).then(function () {
        buildVoiceList();
        for (var i = 0; i < voices.length; i++) if (voices[i].voiceURI === v.voiceURI) { selectVoice(voices[i]); break; }
        toast('Voce pronta ✓', 2500);
      }).catch(function (e) {
        toast('Download non riuscito: ' + (e && e.message ? e.message : e), 6000);
        sel.value = voices.indexOf(voice);
      });
      return;
    }
    selectVoice(v);
  };
  $('rate').step = '0.01'; $('pitch').step = '0.01';   // passo fine: gli stili di voce usano valori come 0.92
  $('rate').value = cfg.rate; $('rv').textContent = cfg.rate + '×';
  $('pitch').value = cfg.pitch; $('pv').textContent = cfg.pitch;
  $('rate').onchange = function () {
    cfg.rate = parseFloat(this.value); saveCfg(); $('rv').textContent = cfg.rate + '×'; syncChips();
    if (playing) speak(cur);
  };
  $('rate').oninput = function () { $('rv').textContent = this.value + '×'; };
  $('pitch').onchange = function () {
    cfg.pitch = parseFloat(this.value); saveCfg(); $('pv').textContent = cfg.pitch; syncChips();
    if (playing) speak(cur);
  };
  $('pitch').oninput = function () { $('pv').textContent = this.value; };
  syncChips();

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
  updatePlayBtn();
  piperInit();
  openDB().then(function () {
    renderList();
    try { var lo = localStorage.getItem('lettore-open'); if (lo) openBook(isNaN(+lo) ? lo : +lo); } catch (e) {}
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
