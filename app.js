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

  function romanVal(t) { var m = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }, s = t.toLowerCase(), tot = 0, i, a, b; for (i = 0; i < s.length; i++) { a = m[s.charAt(i)]; b = m[s.charAt(i + 1)] || 0; tot += a < b ? -a : a; } return tot > 0 ? tot : null; }
  function pgVal(str) {
    var t = str.replace(/^\s+|\s+$/g, ''), m;
    if ((m = /^(\d{1,4})$/.exec(t))) return parseInt(m[1], 10);
    if ((m = /^(?:pag\.?|pagina|p\.)\s*(\d{1,4})$/i.exec(t))) return parseInt(m[1], 10);
    if ((m = /^[-\u2013\u2014]\s*(\d{1,4})\s*[-\u2013\u2014]$/.exec(t))) return parseInt(m[1], 10);
    if ((m = /^(\d{1,4})\s*\/\s*\d{1,4}$/.exec(t))) return parseInt(m[1], 10);
    if (/^([ivxlcdm]{1,7}|[IVXLCDM]{1,7})$/.test(t)) return romanVal(t);
    return null;
  }
  function buildPdf(raw) {
    var N = raw.length, r, k, j, q, g, A = 0, groups = [], zones = []; window.__hy = raw; /* v51e diagnostica */
    for (r = 0; r < N; r++) {
      for (k = 0; k < raw[r].it.length; k++) {
        q = raw[r].it[k];
        if (q.x === null || !raw[r].w || !raw[r].h) continue;
        var v = pgVal(q.s);
        if (v === null) continue;
        q.v = v; q.fx = q.x / raw[r].w; q.fy = q.y / raw[r].h; q.c = true;
      }
    }
    for (r = 0; r < N; r++) {
      if (raw[r].n < 3 || raw[r].n > 32) continue;
      A++;
      for (k = 0; k < raw[r].it.length; k++) {
        q = raw[r].it[k];
        if (!q.c) continue;
        g = null;
        for (j = 0; j < groups.length; j++) { if (Math.abs(groups[j].fx - q.fx) <= 0.03 && Math.abs(groups[j].fy - q.fy) <= 0.02) { g = groups[j]; break; } }
        if (!g) { g = { fx: q.fx, fy: q.fy, m: [] }; groups.push(g); }
        g.m.push({ n: raw[r].n, v: q.v });
      }
    }
    if (A >= 3) {
      groups.forEach(function (g) {
        var pc = {}, D = 0, multi = 0, offs = {}, best = 0, bestOff = 0, par = null, same = true, exp = 0, i, key;
        g.m.forEach(function (e) {
          if (!pc[e.n]) { pc[e.n] = 0; D++; }
          pc[e.n]++;
          key = e.v - e.n; offs[key] = (offs[key] || 0) + 1;
          if (par === null) par = e.n % 2; else if (par !== e.n % 2) same = false;
        });
        for (key in pc) { if (pc[key] > 1) multi++; }
        for (key in offs) { if (offs[key] > best) { best = offs[key]; bestOff = parseInt(key, 10); } }
        if (same) { for (i = 0; i < N; i++) { if (raw[i].n >= 3 && raw[i].n <= 32 && raw[i].n % 2 === par) exp++; } } else exp = A;
        if (D >= 3 && D >= 0.6 * exp && multi <= 0.1 * D && best >= 0.8 * g.m.length) { g.d = D; g.off = bestOff; zones.push(g); }
      });
      zones.sort(function (a, b) { return b.d - a.d; });
      zones = zones.slice(0, 2);
    }
    window.__zone = zones.map(function (z) { return 'x=' + Math.round(z.fx * 100) + '% y=' + Math.round(z.fy * 100) + '% pagine=' + z.d + ' offset=' + z.off; });
    var g59 = [], thr59 = 24, a59, b59, y59, d59;
    for (a59 = 0; a59 < N; a59++) { y59 = []; for (b59 = 0; b59 < raw[a59].it.length; b59++) { if (raw[a59].it[b59].e && raw[a59].it[b59].y !== null) y59.push(raw[a59].it[b59].y); } for (b59 = 1; b59 < y59.length; b59++) { d59 = Math.abs(y59[b59 - 1] - y59[b59]); if (d59 > 3 && d59 < 200) g59.push(d59); } }
    if (g59.length > 50) { g59.sort(function (a, b) { return a - b; }); thr59 = 1.7 * g59[Math.floor(g59.length / 2)]; }
    var out = [];
    for (r = 0; r < N; r++) {
      var s = '';
      var ls59 = true, ly59 = null; /* v59 salto verticale */
      for (k = 0; k < raw[r].it.length; k++) {
        q = raw[r].it[k];
        if (ls59 && q.y !== null) { if (ly59 !== null && Math.abs(q.y - ly59) > thr59) s += '\u0002'; ly59 = q.y; ls59 = false; }
        if (q.e) ls59 = true;
        if (q.c) {
          var inz = false;
          for (j = 0; j < zones.length; j++) { if (Math.abs(zones[j].fx - q.fx) <= 0.03 && Math.abs(zones[j].fy - q.fy) <= 0.02) { inz = true; break; } }
          if (inz) continue;
        }
        var pv = k > 0 ? raw[r].it[k - 1] : null, tx = q.s;
        if (pv && !pv.e && /^(ffi|ffl|ff|fi|fl)$/.test(pv.s) && /^\s/.test(tx) && Math.abs((q.y || 0) - (pv.y || 0)) < 2) tx = tx.replace(/^\s+/, ''); /* v48 ligature */
        s += tx + (q.e ? ((/[A-Za-z\u00C0-\u00FF]-\s*$/.test(q.s) || (/^\s*-\s*$/.test(q.s) && /[A-Za-z\u00C0-\u00FF]$/.test(s.replace(/\s+$/, ''))) || (q.s === '' && /[A-Za-z\u00C0-\u00FF]-$/.test(s))) ? '\u0001' : ' ') : '');
      }
      out.push({ label: 'Pagina ' + raw[r].n, p: raw[r].n, text: s.replace(/\s*-\s*\u0001\s*(?=[a-z\u00E0-\u00FF])/g, '').replace(/\u0001/g, '').replace(/\s+/g, ' ').replace(/ ?\u0002 ?/g, '\n').trim() });
    }
    return out;
  }
  function readPdf(file, onProgress) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
    return file.arrayBuffer().then(function (buf) {
      return pdfjsLib.getDocument({ data: buf }).promise;
    }).then(function (pdf) {
      var out = [];
      function page(n) {
        if (n > pdf.numPages) return Promise.resolve(buildPdf(pdf.__raw || []));
        onProgress('PDF: pagina ' + n + ' di ' + pdf.numPages);
        return pdf.getPage(n).then(function (p) { return p.getTextContent().then(function (tc) { tc.__h = p.getViewport({ scale: 1 }).height; tc.__w = p.getViewport({ scale: 1 }).width; return tc; }); })
          .then(function (tc) {
            if (n <= 60) { window.__margini = window.__margini || []; tc.items.forEach(function (it) { if (it.transform && it.str.trim()) { var y = it.transform[5], h = tc.__h; if (/^\s*(\d{1,4}|[ivxlcIVXLC]{1,6})\s*$/.test(it.str) || y < h * 0.08) window.__margini.push(n + ' | x=' + Math.round(it.transform[4]) + ' y=' + Math.round(y) + ' h=' + Math.round(h) + ' | ' + JSON.stringify(it.str.slice(0, 40))); } }); }
            var rw = [];
            for (var i = 0; i < tc.items.length; i++) { var it = tc.items[i]; rw.push({ s: it.str, e: it.hasEOL, x: it.transform ? it.transform[4] : null, y: it.transform ? it.transform[5] : null }); }
            (pdf.__raw = pdf.__raw || []).push({ n: n, h: tc.__h, w: tc.__w, it: rw });
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

  // ---------- Articoli di giornale ----------
  var ARTICLE_PROXY = 'https://lettore-articoli-bbc4.topaus123.workers.dev/';
  var JUNK_TAGS = 'script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,button,select,figure,dialog,[hidden],[aria-hidden="true"]';
  var JUNK_RE = /(^|[\s_-])(comments?|commenti|share|social|related|correlat\w*|newsletter|cookie|consent|banner|advert\w*|ads?|promo\w*|sidebar|breadcrumb\w*|subscribe|outbrain|taboola|widget|popup|modal|tags?|author-box|read-more|more-news)($|[\s_-])/i;
  var BOILER_RE = /^(leggi anche|leggi tutto|continua a leggere|iscriviti|accedi|abbonati|registrati|pubblicit[aà]|advertisement|condividi|seguici|ti potrebbe interessare|potrebbe interessarti|©|copyright|tutti i diritti)/i;

  function linkLen(el) {
    var as = el.querySelectorAll('a'), n = 0, i;
    for (i = 0; i < as.length; i++) n += as[i].textContent.length;
    return n;
  }
  function articleTitle(doc) {
    var m = doc.querySelector('meta[property="og:title"]') || doc.querySelector('meta[name="twitter:title"]');
    var t = (m && m.getAttribute('content')) || '';
    if (!t) { var h = doc.querySelector('h1'); t = h ? h.textContent : ''; }
    if (!t) t = doc.title || '';
    t = t.replace(/\s+/g, ' ').trim();
    var parts = t.split(/\s+[|–—]\s+/);
    if (parts[0].length >= 15) t = parts[0];
    return t.slice(0, 160) || 'Articolo';
  }
  // molti giornali inseriscono il testo intero in un blocco "articleBody" (dati per i motori di ricerca)
  function ldBody(doc) {
    var best = '', nodes = doc.querySelectorAll('script[type="application/ld+json"]'), n;
    function walk(o, depth) {
      if (!o || depth > 6 || typeof o !== 'object') return;
      if (Object.prototype.toString.call(o) === '[object Array]') { for (var i = 0; i < o.length; i++) walk(o[i], depth + 1); return; }
      if (typeof o.articleBody === 'string' && o.articleBody.length > best.length) best = o.articleBody;
      for (var k in o) { if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1); }
    }
    for (n = 0; n < nodes.length; n++) { try { walk(JSON.parse(nodes[n].textContent), 0); } catch (e) {} }
    if (/<\w+[^>]*>/.test(best)) best = readHtmlString('<body>' + best + '</body>');
    return best;
  }
  // cerca il contenitore con più paragrafi "veri" e ne tiene solo il testo
  function domBody(doc) {
    var i, j, el, junk = doc.querySelectorAll(JUNK_TAGS);
    for (i = 0; i < junk.length; i++) if (junk[i].parentNode) junk[i].parentNode.removeChild(junk[i]);
    var all = doc.querySelectorAll('[class],[id]');
    for (i = 0; i < all.length; i++) {
      el = all[i];
      if (!el.parentNode) continue;
      var tg = el.tagName;
      if (tg === 'ARTICLE' || tg === 'MAIN' || tg === 'BODY' || tg === 'HTML') continue;
      var ci = (el.getAttribute('class') || '') + ' ' + (el.id || '');
      if (JUNK_RE.test(ci) && !el.querySelector('article')) el.parentNode.removeChild(el);
    }
    var ps = doc.querySelectorAll('p'), nodes = [], scores = [];
    function add(node, s) { var ix = nodes.indexOf(node); if (ix < 0) { nodes.push(node); scores.push(s); } else scores[ix] += s; }
    for (i = 0; i < ps.length; i++) {
      var tx = ps[i].textContent.replace(/\s+/g, ' ').trim();
      if (tx.length < 40 || linkLen(ps[i]) > tx.length * 0.5) continue;
      var s = 1 + (tx.split(',').length - 1) + Math.min(Math.floor(tx.length / 100), 3);
      var par = ps[i].parentNode;
      if (par) { add(par, s); if (par.parentNode) add(par.parentNode, s / 2); }
    }
    var best = null, bestScore = 0;
    for (i = 0; i < nodes.length; i++) if (scores[i] > bestScore) { bestScore = scores[i]; best = nodes[i]; }
    if (!best) return '';
    var up = true;
    while (up && best.parentNode && best.parentNode.tagName !== 'BODY' && best.parentNode.tagName !== 'HTML') {
      var pix = nodes.indexOf(best.parentNode);
      if (pix >= 0 && scores[pix] >= bestScore * 0.75) { best = best.parentNode; bestScore = scores[pix]; } else up = false;
    }
    while (best.tagName === 'SECTION' && best.parentNode && best.parentNode.tagName !== 'BODY' && best.parentNode.tagName !== 'HTML') {
      var kids = best.parentNode.children, ns = 0, q;
      for (q = 0; q < kids.length; q++) if (kids[q].tagName === 'SECTION') ns++;
      if (best.parentNode.tagName === 'SECTION' || ns >= 2) best = best.parentNode; else break;
    }
    var out = [], seen = {}, els = best.querySelectorAll('p,h2,h3,h4,blockquote,li');
    for (j = 0; j < els.length; j++) {
      el = els[j];
      var t = el.textContent.replace(/\s+/g, ' ').trim(), tag = el.tagName;
      if (!t || seen[t]) continue;
      if (tag === 'BLOCKQUOTE' && el.querySelector('p')) continue;
      if (tag === 'LI' && t.length < 60) continue;
      if (/^H\d$/.test(tag)) { if (t.length < 5 || t.length > 140) continue; }
      else if (t.length < 25) continue;
      if (linkLen(el) > t.length * 0.5 || BOILER_RE.test(t)) continue;
      seen[t] = 1; out.push(t);
    }
    return out.join('\n\n');
  }
  function extractArticle(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var title = articleTitle(doc);
    var ld = cleanText(ldBody(doc)), dom = '';
    try { dom = domBody(doc); } catch (e) {}
    var body = (ld.length >= 600 && ld.length >= dom.length * 0.7) || !dom ? ld : dom;
    if (body.slice(0, title.length) === title) body = body.slice(title.length).trim();
    return { title: title, text: title + '.\n\n' + body, chars: body.length };
  }
  function decodeHtml(buf, ct) {
    var m = /charset=([\w-]+)/i.exec(ct || ''), cs = m ? m[1] : '', i;
    if (!cs) {
      var u8 = new Uint8Array(buf, 0, Math.min(buf.byteLength, 3000)), head = '';
      for (i = 0; i < u8.length; i++) head += String.fromCharCode(u8[i]);
      var m2 = /charset=["']?([\w-]+)/i.exec(head);
      cs = m2 ? m2[1] : 'utf-8';
    }
    try { return new TextDecoder(cs).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
  }
  function fetchArticle(raw) {
    var url = (raw || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      if (/^[\w-]+(\.[\w-]+)+/.test(url)) url = 'https://' + url;
      else return Promise.reject(new Error('Incolla un indirizzo che inizi con https://'));
    }
    url = url.replace(/^http:\/\//i, 'https://');
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 20000);
    return fetch(ARTICLE_PROXY + '?url=' + encodeURIComponent(url), ctl ? { signal: ctl.signal } : {})
      .then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (j) { throw new Error((j && j.error) || ('Errore ' + res.status)); });
        }
        var ct = res.headers.get('Content-Type') || '';
        return res.arrayBuffer().then(function (buf) { return decodeHtml(buf, ct); });
      })
      .then(function (html) { clearTimeout(timer); return extractArticle(html); },
        function (e) {
          clearTimeout(timer);
          if (e && e.name === 'AbortError') throw new Error('Il sito ci mette troppo a rispondere.');
          if (e instanceof TypeError) throw new Error('Non riesco a contattare il servizio. Controlla la connessione.');
          throw e;
        });
  }
  function saveTextBook(title, raw, src) {
    var text = cleanText(raw), total = splitSentences(text).length;
    if (text.length < 20 || !total) return Promise.reject(new Error('Nessun testo trovato.'));
    var id = 'b' + Date.now() + Math.floor(Math.random() * 1000);
    return dbPut('texts', { id: id, text: text }).then(function () {
      return dbPut('books', { id: id, title: title, pos: 0, total: total, kind: 'sez', marks: [],
        added: Date.now(), last: Date.now(), src: src || '' });
    });
  }
  // ---------- fine articoli ----------

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
  var HEAD_END = /(?:[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’]+\s+){1,8}pag\.?$/;
  var HEAD_IN = /(?:[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'’]+\s+){1,8}pag\.\s*\d{1,4}\b\s*/g;
  function markNotes(list) {
    var off = [], pos = 0, i, k, j, m, re;
    for (i = 0; i < list.length; i++) { off.push(pos); pos += list[i].t.length + 1; }
    var J = list.map(function (s) { return s.t; }).join(' ');
    var occ = [];
    for (i = 0; i < list.length; i++) {
      re = /\((\d{1,3})\)/g;
      while ((m = re.exec(list[i].t))) occ.push({ n: +m[1], i: i, p: off[i] + m.index, e: off[i] + m.index + m[0].length });
    }
    var runs = [], chain, last;
    k = 0;
    while (k < occ.length) {
      if (occ[k].n !== 1) { k++; continue; }
      chain = [occ[k]]; j = k + 1;
      while (j < occ.length) {
        last = chain[chain.length - 1];
        if (occ[j].p - last.p > 600) break;
        if (occ[j].n === last.n + 1) chain.push(occ[j]);
        j++;
      }
      if (chain.length >= 3) { runs.push(chain); k = j; } else k++;
    }
    var prevEnd = -1;
    runs.forEach(function (ch) {
      var body = {}, t, q, mm, found, from, to, raw, before, endIdx = ch[0].i, a = ch[0].i;
      var iL = ch[ch.length - 1].i, lastEnd = Math.min(list.length - 1, iL + 2);
      for (t = 0; t < ch.length; t++) {
        from = ch[t].e;
        to = t + 1 < ch.length ? ch[t + 1].p : off[lastEnd] + list[lastEnd].t.length;
        raw = J.substring(from, to).replace(/\s+[A-ZÀ-ÖØ-Þ]{3,}(?:\s+[A-ZÀ-ÖØ-Þ'’]{2,})+[\s\S]*$/, '');
        if (t === ch.length - 1) {
          raw = raw.slice(0, 900);
          for (q = a; q < list.length && off[q] < from + raw.length; q++) endIdx = q;
        }
        body[ch[t].n] = raw.replace(/(\p{Ll})-(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
      }
      before = list[a].t.substr(0, ch[0].p - off[a]).replace(/\s*NOTE\s*$/i, '').trim();
      if (/[\p{L}\p{N}]/u.test(before)) list[a].x = before; else list[a].skip = true;
      for (q = a + 1; q <= endIdx; q++) list[q].skip = true;
      for (q = prevEnd + 1; q < a; q++) {
        if (list[q].skip) continue;
        re = /\((\d{1,3})\)/g; found = false;
        while ((mm = re.exec(list[q].t))) {
          if (body.hasOwnProperty(+mm[1])) {
            found = true;
            if (body[+mm[1]]) { (list[q].nt = list[q].nt || []).push(body[+mm[1]]); (list[q].nn = list[q].nn || []).push(+mm[1]); }
          }
        }
        if (found) list[q].rm = true;
      }
      prevEnd = endIdx;
    });
  }
  function markHeads(list) {
    for (var i = 0; i < list.length - 1; i++) {
      var t = list[i].t, nx = list[i + 1];
      if (HEAD_END.test(t) && /^\d{1,4}(\s|$)/.test(nx.t)) {
        list[i].x = t.replace(HEAD_END, '').trim();
        nx.x = nx.t.replace(/^\d{1,4}\s*/, '');
      }
    }
  }
  var HEAD_START = /^\d{1,4}\s+(?:(?:[«»“”]|[A-ZÀ-ÖØ-Þ0-9][A-ZÀ-ÖØ-Þ0-9'’,\-]*)\s+){3,}(?:\([a-zà-ÿ ]+\)\s*)?/;
  var PAGENUM_RE = /^[\s\-–—·•\[(]*(?:pag(?:ina|\.)?|p\.|page)?\s*\d{1,4}\s*[\])\-–—·•]*$/i;
  var ORE_RE = /^ore\s+\d{1,2}[:.]\d{2}\b/i;  /* v50: orari = testo vero */
  var FIRMA_RE = /^(?:[^,\d]{1,40},\s*\d{1,2}\s+\p{L}+\s+\d{4}.{0,20}|Giorgio Bongiovanni\s*)$/u;  /* v51: firme = testo vero */
  function markNoise(list) {
    var cnt = {}, seen = {}, i, k;
    function key(t) { var l = t.toLowerCase(); if (/^(capitolo|messaggio|parte|lettera|cap\.)/.test(l)) return l.replace(/\s+/g, ' ').trim(); return l.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); }
    for (i = 0; i < list.length; i++) {
      var t = list[i].t;
      if (t.length > 90 || /[.!?…]["'»”’)\]]*$/.test(t)) continue;
      k = key(t); cnt[k] = (cnt[k] || 0) + 1;
    }
    for (i = 0; i < list.length; i++) {
      k = key(list[i].t);
      if (cnt[k] >= 3 && !ORE_RE.test(list[i].t.trim()) && !FIRMA_RE.test(list[i].t.trim())) { if (seen[k]) list[i].skip = true; else seen[k] = 1; }
    }
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

  // ---- selezione multipla (v24) ----
  var selMode = false, sel = {}, rows = {}, selPushed = false, longFired = false;
  function selCount() { var n = 0; for (var k in sel) if (sel[k]) n++; return n; }
  function updateSel() {
    $('v-lib').classList.toggle('sel', selMode);
    $('list').classList.toggle('sel', selMode);
    var n = selCount(), tot = 0, id;
    for (id in rows) {
      tot++;
      rows[id].d.classList.toggle('picked', !!sel[id]);
      rows[id].c.textContent = sel[id] ? '✓' : '';
    }
    $('sel-del').textContent = '🗑 Elimina' + (n ? ' (' + n + ')' : '');
    $('sel-del').disabled = !n;
    $('sel-all').textContent = (tot && n === tot) ? 'Deseleziona tutto' : 'Seleziona tutto';
  }
  function selEnter(id) {
    selMode = true; sel = {}; sel[id] = true;
    if (!selPushed) { try { history.pushState({ s: 1 }, ''); selPushed = true; } catch (e) {} }
    try { if (navigator.vibrate) navigator.vibrate(25); } catch (e) {}
    updateSel();
  }
  function selExit(fromPop) {
    selMode = false; sel = {};
    updateSel();
    if (fromPop) selPushed = false;
    else if (selPushed) { selPushed = false; try { history.back(); } catch (e) {} }
  }
  function selToggle(id) {
    sel[id] = !sel[id];
    updateSel();
  }
  $('sel-cancel').onclick = function () { selExit(false); };
  $('sel-all').onclick = function () {
    var all = selCount() === Object.keys(rows).length;
    sel = {};
    if (!all) for (var id in rows) sel[id] = true;
    updateSel();
  };
  $('sel-del').onclick = function () {
    var ids = [], id;
    for (id in sel) if (sel[id] && rows[id]) ids.push(rows[id].id);
    if (!ids.length) return;
    var msg = ids.length === 1 ? 'Eliminare "' + rows[String(ids[0])].title + '"?' : 'Eliminare ' + ids.length + ' documenti? Non si può annullare.';
    if (!confirm(msg)) return;
    Promise.all(ids.map(function (i) { return Promise.all([dbDel('books', i), dbDel('texts', i)]); }))
      .then(function () { selExit(false); renderList(); });
  };

  function renderList() {
    dbAll('books').then(function (books) {
      books.sort(function (a, b) { return (b.last || 0) - (a.last || 0); });
      var box = $('list');
      box.innerHTML = '';
      rows = {};
      if (!books.length) {
        box.innerHTML = '<div class="empty"><b>Nessun libro ancora.</b><br>Tocca <b>+ Aggiungi</b> per caricare un PDF, EPUB, Word o TXT dall\'app File del tuo iPhone.</div>';
        if (selMode) selExit(false);
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
        var del = document.createElement('button'); del.className = 'del'; del.textContent = '🗑';
        var chk = document.createElement('span'); chk.className = 'chkc';
        d.appendChild(t); d.appendChild(del); d.appendChild(chk);
        rows[String(b.id)] = { id: b.id, title: b.title, d: d, c: chk };
        d.onclick = function (e) {
          if (longFired) { longFired = false; return; }
          if (selMode) { selToggle(String(b.id)); return; }
          if (t.contains(e.target)) openBook(b.id);
        };
        del.onclick = function (e) {
          e.stopPropagation();
          if (confirm('Eliminare "' + b.title + '"?')) {
            Promise.all([dbDel('books', b.id), dbDel('texts', b.id)]).then(renderList);
          }
        };
        // pressione lunga: entra nella selezione
        var timer = null, x0 = 0, y0 = 0;
        function stopT() { if (timer) { clearTimeout(timer); timer = null; } }
        d.addEventListener('pointerdown', function (e) {
          longFired = false;
          if (selMode || e.target === del) return;
          x0 = e.clientX; y0 = e.clientY; stopT();
          timer = setTimeout(function () { timer = null; longFired = true; selEnter(String(b.id)); }, 450);
        });
        d.addEventListener('pointermove', function (e) {
          if (timer && (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10)) stopT();
        });
        d.addEventListener('pointerup', stopT);
        d.addEventListener('pointercancel', stopT);
        d.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        box.appendChild(d);
      });
      // se sparisce un documento mentre si seleziona, lo si toglie dalla selezione
      for (var k in sel) if (!rows[k]) delete sel[k];
      updateSel();
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

  // ---------- Pannello "Aggiungi articolo" ----------
  function artMsg(t, bad) { var m = $('art-msg'); m.textContent = t || ''; m.style.color = bad ? '#e5534b' : 'var(--mut)'; }
  function artDone() {
    $('art-url').value = ''; $('art-text').value = ''; $('art-title').value = '';
    artMsg('');
    closeSheets();
    renderList();
  }
  $('addart').onclick = function () { artMsg(''); openSheet('sheet-art'); };
  $('art-go').onclick = function () {
    var btn = this, url = $('art-url').value;
    if (!url.trim()) { artMsg('Incolla prima l\'indirizzo dell\'articolo.', true); return; }
    btn.disabled = true; artMsg('Scarico l\'articolo…');
    fetchArticle(url).then(function (a) {
      if (a.chars < 50) throw new Error('Non trovo il testo dell\'articolo: il sito potrebbe bloccare il download o essere a pagamento. Copia il testo e incollalo qui sotto.');
      if (a.chars < 400 && !confirm('Ho trovato poco testo (' + a.chars + ' caratteri): forse l\'articolo è a pagamento o il sito lo carica in un secondo momento. Lo aggiungo lo stesso?')) {
        artMsg('Non aggiunto. Prova a copiare il testo e incollarlo qui sotto.', true); return;
      }
      return saveTextBook(a.title, a.text, url).then(artDone);
    }).catch(function (e) { artMsg(e.message, true); }).then(function () { btn.disabled = false; });
  };
  $('art-add').onclick = function () {
    var txt = $('art-text').value, ttl = $('art-title').value.trim();
    if (txt.trim().length < 20) { artMsg('Incolla il testo dell\'articolo nel riquadro.', true); return; }
    if (!ttl) ttl = txt.trim().split(/\n/)[0].slice(0, 70);
    saveTextBook(ttl, ttl + '.\n\n' + txt, '').then(artDone).catch(function (e) { artMsg(e.message, true); });
  };

  // ---------- Condividi verso Lettore (Android) ----------
  function readShare() {
    var q = location.search;
    if (!q || q.length < 2) return null;
    var p = {}, parts = q.slice(1).split('&'), i, kv;
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].split('=');
      try { p[kv[0]] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' ')); } catch (e) {}
    }
    if (!p.url && !p.text && !p.title) return null;
    var m = /https?:\/\/[^\s<>"']+/i.exec((p.url || '') + ' ' + (p.text || '') + ' ' + (p.title || ''));
    return { link: m ? m[0].replace(/[).,;]+$/, '') : '', text: p.text || '', title: p.title || '' };
  }

  // ---------- Lettore ----------
  var book = null, sents = [], cur = 0, playing = false, gen = 0;
  var pageStart = -1, spans = [], curEl = null;
  var voices = [], voice = null;
  var marks = [], mkind = 'sez';
  var sleepTimer = null, wake = null;
  var cfg = { voiceURI: '', rate: 1, pitch: 1, symbols: true, lockText: false, theme: 'dark', fs: 19, pauseMs: 400 };
  try { var sv = JSON.parse(localStorage.getItem('lettore-cfg')); if (sv) for (var k in sv) cfg[k] = sv[k]; } catch (e) {}
  function saveCfg() { try { localStorage.setItem('lettore-cfg', JSON.stringify(cfg)); } catch (e) {} }

  function openBook(id) {
    Promise.all([dbGet('books', id), dbGet('texts', id)]).then(function (r) {
      book = r[0];
      sents = splitSentences(r[1].text); markNoise(sents); markHeads(sents); markNotes(sents); window.__sents = sents;
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
      window.__marks = marks;
      if (mkind === 'pdf') { var mi = 0; for (var kk = 0; kk < sents.length; kk++) { while (mi + 1 < marks.length && marks[mi + 1].i <= kk) mi++; sents[kk].pg = marks[mi] ? marks[mi].p : 0; } }
      try { localStorage.setItem('lettore-open', String(id)); } catch (e) {}
      showView('v-read');
      if (!histPushed) { try { history.pushState({ r: 1 }, ''); histPushed = true; } catch (e) {} }
      updatePlayBtn();
      show(cur, true);
      if (!crashed && voice && voice.piper && piperDone[voice.def.key]) piperEnsure(voice.def).catch(function () {});
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

  function noteDefer(i) {
    var s = sents[i], nx = sents[i + 1];
    if (!s || !s.nt || !nx) return false;
    if (/[.!?…][»”"')\]]*\s*$/.test(s.t)) return false;
    return /^\s*[«“"(]?\s*[a-zà-ÿ]/.test(nx.t);
  }
  function noteFmt(i) {
    var s = sents[i];
    if (!s || !s.nt) return [];
    return s.nt.map(function (n, k) { var N = s.nn ? s.nn[k] : ''; return 'Nota ' + N + ' a piè di pagina: ' + n + ' … Fine nota ' + N + '.'; });
  }
  function notesFor(i) {
    if (noteDefer(i)) return [];
    var r = [], j = i;
    while (j > 0 && noteDefer(j - 1)) j--;
    for (; j <= i; j++) r = r.concat(noteFmt(j));
    return r;
  }
  function docKey(s) { return (s || '').toLowerCase().replace(/[^a-zà-ÿ0-9]/g, ''); }
  function stripDocTitle(t) {
    var f = docKey((book.title || '').replace(/\s*\(\d+\)\s*$/, ''));
    if (f.length < 6) return t;
    var j = 0, k = 0, c;
    while (k < t.length && j < f.length) {
      c = t.charAt(k).toLowerCase();
      if (/[a-zà-ÿ0-9]/.test(c)) { if (c !== f.charAt(j)) return t; j++; }
      k++;
    }
    if (j < f.length) return t;
    return t.slice(k).replace(/^[\s.,;:\-–—]+/, '');
  }

  var IDX_RE = /^\d{1,4}\s+.{1,120}\s+pag\.\s*$/;
  var IDX_HEAD_RE = /^Indice\b.{0,120}\spag\.\s*$/;
  function isIdx(j) { return !!sents[j] && IDX_RE.test(sents[j].t); }
  var IDX_TITLE_RE = /^(indicegenerale|indice|sommario|contenuti|contents|tableofcontents)/;
  function idxTitle(j) {
    var s = sents[j];
    if (!s) return false;
    if (!IDX_TITLE_RE.test(s.t.toLowerCase().replace(/\s+/g, ''))) return false;
    var m = s.t.match(/\b\d{1,3}\b/g) || [];
    if (m.length < 3) return false;
    for (var q = 1; q < m.length; q++) if (+m[q] < +m[q - 1]) return false;
    return true;
  }
  function inIdx(i) {
    for (var k = i; k >= 0 && k > i - 40; k--) {
      if (idxTitle(k)) {
        for (var q = k + 1; q <= i; q++) {
          if (sents[q].br || !/\b\d{1,3}\b/.test(sents[q].t)) return false;
        }
        return true;
      }
    }
    return false;
  }
  /* v49: indice con titoli in una frase + serie di «numero pag.» */
  var IDX2_RUN_RE = /pag\.\s*$|^\d{1,4}\s*$/;
  function idxRunEnd(k) {
    var q = k + 1;
    while (sents[q] && !sents[q].br && q < k + 60 && IDX2_RUN_RE.test(sents[q].t.trim())) q++;
    return q - 1;
  }
  function inIdx2(i) {
    for (var k = i; k >= 0 && k > i - 60; k--) {
      if (sents[k].br && IDX_TITLE_RE.test(sents[k].t.toLowerCase().replace(/\s+/g, '')) && idxRunEnd(k) - k >= 5) {
        return i <= idxRunEnd(k);
      }
    }
    return false;
  }
  /* v55: testatina ripetuta (stessa apertura >=3 volte) muta dalla 3a comparsa */
  var _repS = null, _repN = -1, _repOcc = [], _repK = [], _repKey = [];
  function repBuild() {
    var seen = {}, i, t, re = /\S+/g, m, key, k;
    _repS = sents; _repN = sents.length; _repOcc = []; _repK = []; _repKey = [];
    for (i = 0; i < sents.length; i++) {
      t = sents[i].t || ''; re.lastIndex = 0; key = '';
      for (k = 0; k < 6 && key.length < 12 && (m = re.exec(t)); k++) key += docKey(m[0]);
      _repOcc[i] = 0;
      if (key.length < 12) continue;
      seen[key] = (seen[key] || 0) + 1;
      _repOcc[i] = seen[key]; _repK[i] = k; _repKey[i] = key;
    }
  }
  function repStrip(i, t) {
    if (_repS !== sents || _repN !== sents.length) repBuild();
    if (!(_repOcc[i] >= 3)) return t;
    var re = /\S+/g, key = '', m, k, end = 0;
    for (k = 0; k < _repK[i] && (m = re.exec(t)); k++) { key += docKey(m[0]); end = re.lastIndex; }
    if (k < _repK[i] || key !== _repKey[i]) return t;
    return t.slice(end).replace(/^[\s.,;:\-–—]+/, '');
  }
  var _fzS = null, _fzN = -1, _fzEnd = 8;
  function frontEnd() {   /* v56: fine zona iniziale */
    if (_fzS === sents && _fzN === sents.length) return _fzEnd;
    var j, lim = Math.min(sents.length, 60), e = 8;
    for (j = 0; j < lim; j++) {
      if (isIdx(j) || inIdx(j) || inIdx2(j)) continue;
      if (/^\W*(prefazione|introduzione|premessa|presentazione|prologo)\b/i.test(sents[j].t.trim()) && !/\d\s*$/.test(sents[j].t)) { e = j; break; }
    }
    _fzS = sents; _fzN = sents.length; _fzEnd = e;
    return e;
  }
  var _coS = null, _coN = -1, _coM = [];
  var STRONG58 = /Direzione:|Herausgegeben|Edito da|©|Copyright|\bTel\.|ISBN|Edizione|Titolo originale|https?:|\bVia\s+[A-Z]|\b\d{5}\s+[A-Z][a-zà-ÿ]+|\bStr\./;
  var RIGHTS58 = /riservati tutti i diritti|[Dd]iritti riservati|Tutti i diritti/;
  function colo58(i) {   /* v58: blocco colophon a contesto */
    if (_coS !== sents || _coN !== sents.length) {
      var lim = frontEnd(), open = false, j, t, m, w, pc63 = {};
      for (j = 0; j < sents.length; j++) { t = sents[j].t; if (pc63[sents[j].pg] === undefined) pc63[sents[j].pg] = 0; if (STRONG58.test(t) || RIGHTS58.test(t)) pc63[sents[j].pg]++; }
      _coM = [];
      for (j = 0; j < lim; j++) {
        t = sents[j].t.trim(); _coM[j] = false;
        if (pc63[sents[j].pg] === 0) { open = false; continue; }  /* v63 */
        if (/^[“«"‘]/.test(t)) { open = false; continue; }
        if (RIGHTS58.test(t)) { _coM[j] = true; open = true; continue; }
        m = STRONG58.exec(t);
        if (m) {
          if (open) { w = (t.slice(0, m.index).match(/[A-Za-zÀ-ÿ]{2,}/g) || []).length; _coM[j] = (m.index === 0 || w < 2); }
          open = true; continue;
        }
        if (open && t.length > 120) { open = false; continue; }
        if (open && t.length <= 120) _coM[j] = true;
      }
      _coS = sents; _coN = sents.length;
    }
    return !!_coM[i];
  }
  function spokenText(i) {
    var t = sents[i].x !== undefined ? sents[i].x : sents[i].t;
    if (sents[i].skip || PAGENUM_RE.test(t)) return '';
    if (isIdx(i) && (isIdx(i - 1) || isIdx(i + 1))) return '';
    if (IDX_HEAD_RE.test(sents[i].t.trim()) && isIdx(i + 1)) return '';
    if (inIdx(i)) return '';   /* v47 */
    if (inIdx2(i)) return '';  /* v49 */
    /* v57: taglia solo il pezzo copyright/editore/indirizzo */
    if (book && book.kind === 'pdf' && i < frontEnd() && colo58(i)) return '';  /* v58 */
    var cut57 = false;
    if (book && book.kind === 'pdf' && i < frontEnd()) {
      var m57 = /Direzione:|Copyright by|Edito da|Herausgegeben von|\bTel\.|ISBN|https?:|©|\bVia\s+[A-Z]|\b\d{5}\s+[A-Z][a-zà-ÿ]+|\bStr\./.exec(t);
      if (m57 && m57.index > 0) { t = t.slice(0, m57.index).replace(/[\s,;:–-]+$/, ""); cut57 = true; }
    }
    /* v52: frontespizio PDF, solo prime frasi */
    if (book && book.kind === 'pdf' && i < frontEnd() && !cut57 && (sents[i].t.trim() === 'C.' || /©|copyright|ISBN|diritti riservati|https?:|www\.|Giordano Bruno|Via Molino|Sant.Elpidio|\bTel\b|\bFax\b/i.test(sents[i].t) || /\bVia\s+[A-Z]/.test(sents[i].t))) return '';  /* v56 */
    if (i === 0) t = t.replace(/\s*Edizioni\s+A\.?\s*$/i, '');
    t = t.replace(HEAD_IN, '');
    t = repStrip(i, t);  /* v55 */
    if (sents[i].br && book && book.kind === 'pdf') {
      /* v44: numero pagina tolto in readPdf */
      if (i !== 0) t = stripDocTitle(t);
    }
    if (sents[i].rm) t = t.replace(/\s*\(\d{1,3}\)/g, '');
    t = t.replace(/([a-zà-ÿ]) ?\d{1,4}(?=[a-zà-ÿ])/g, '$1');
    var nl = notesFor(i); if (nl.length) t += ' … ' + nl.join(' … ');;
    try { t = t.normalize('NFKC'); } catch (e) {}              // ligature (ﬁ, ﬂ) e simboli strani -> normali
    t = t.replace(/[­​-‍⁠﻿]/g, '');   // caratteri invisibili
    t = t.replace(/(?:>\s*){2,}|(?:<\s*){2,}/g, ' ');                   // v60: >> e << non letti (restano a schermo)
    t = t.replace(/([\-_=*~#•·.])\1{2,}/g, ', ');              // *** --- ... diventano una pausa
    // PAROLE IN STAMPATELLO: in minuscolo, altrimenti la voce le sillaba lettera per lettera
    t = t.replace(/(^|[^A-Za-zÀ-ÿ])([A-ZÀ-ÖØ-Þ]{4,})(?![A-Za-zÀ-ÿ])/g, function (m, a, b) { return a + b.toLowerCase(); });
    if (cfg.symbols) {
      t = t.replace(/(\d)°(?=\s+[a-zà-ÿ])/g, '$1');
      var lang = (voice && voice.lang ? voice.lang : 'it').toLowerCase().substring(0, 2);
      var map = lang === 'it' ? SYM_IT : (lang === 'en' ? SYM_EN : null);
      if (map) t = t.replace(SYM_RE, function (c) { return map[c] || ' '; });
    }
    t = t.replace(/\s+/g, ' ').trim();
    var nxs = sents[i + 1];
    if (nxs && /[\p{L}\p{N}]$/u.test(t) && /^[«“"(]?[A-ZÀ-ÖØ-Þ]/.test(nxs.t.trim())) t += '.';
    t = t.replace(/([:;])\s+/g, '$1 … ');
    t = t.replace(/\s([«“])/g, ' … $1');
    t = t.replace(/([»”])(?=\s)/g, '$1 …');
    return /[\p{L}\p{N}]/u.test(t) ? t : '';   // frasi di soli simboli muti: saltate
  }

  window.__spoken = spokenText;

  // ---- Lettura fluida: la frase successiva è già in coda prima che finisca la corrente ----
  var finalIdx = -1, lastQ = -1, utts = [];

  var SIGN_RE = /^(?:Giorgio Bongiovanni(?:\s+Porto\b.*)?\s*$|[^,\d]{1,40},\s*\d{1,2}\s+\p{L}+\s+\d{4})/u;  /* v51b: pausa prima della firma */
  function isSign(n) {
    if (n < 1 || !sents[n] || !sents[n - 1]) return false;
    return SIGN_RE.test(sents[n].t.trim()) && sents[n].t.length <= 90 && !SIGN_RE.test(sents[n - 1].t.trim());
  }
  function enqueue(i, g) {
    var txt = '';
    while (i < sents.length) { txt = spokenText(i); if (txt) break; i++; }
    if (i >= sents.length) return false;
    var idx = i;
    var parts = txt.split(/[\s,]*(?=Nota \d* ?a piè di pagina:)/);
    txt = parts.pop();
    parts.forEach(function (p) {
      if (!p) return;
      var q = new SpeechSynthesisUtterance(p);
      if (voice) { q.voice = voice; q.lang = voice.lang; } else { q.lang = 'it-IT'; }
      q.rate = cfg.rate; q.pitch = cfg.pitch;
      utts.push(q); window.speechSynthesis.speak(q);
    });
    var u = new SpeechSynthesisUtterance(txt);
    if (voice) { u.voice = voice; u.lang = voice.lang; } else { u.lang = 'it-IT'; }
    u.rate = cfg.rate; u.pitch = cfg.pitch;
    u.onstart = function () {
      if (g !== gen) return;
      lastSpeechAt = Date.now();
      show(idx);
      var nx = idx + 1;
      // a fine paragrafo non metto in coda la frase dopo: lascio una piccola pausa, come un lettore umano
      if (nx < sents.length && (sents[nx].br || isSign(nx)) && cfg.pauseMs > 0) return;
      if (!enqueue(nx, g)) finalIdx = idx;
    };
    u.onend = function () {
      if (g !== gen || !playing) return;
      if (idx === finalIdx) { pause(); return; }
      if (lastQ > idx) return;
      var nx = idx + 1;
      function go() { if (g === gen && playing && !enqueue(nx, g)) pause(); }
      if (nx < sents.length && (sents[nx].br || isSign(nx)) && cfg.pauseMs > 0) setTimeout(go, cfg.pauseMs); else go();
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

  // ---------- Ascolto a schermo spento / in altre schede ----------
  var IS_ANDROID = /Android/i.test(navigator.userAgent);
  var lastSpeechAt = 0, lastBeat = Date.now(), hiddenAt = 0;
  setInterval(function () { lastBeat = Date.now(); }, 5000);
  var keepAu = null, awayTimer = null, awayStopped = false, AWAY_MIN = 20;
  // 1 secondo di silenzio vero, in loop: fa considerare l'app "in riproduzione" (notifica con i comandi, niente sospensione)
  function makeSilentUrl() {
    var rate = 8000, n = rate, buf = new ArrayBuffer(44 + n), v = new DataView(buf), k;
    function w(o, str) { for (k = 0; k < str.length; k++) v.setUint8(o + k, str.charCodeAt(k)); }
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, n, true);
    var u8 = new Uint8Array(buf); for (k = 44; k < 44 + n; k++) u8[k] = 128;
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  function startKeep() {
    try {
      if (!keepAu) { keepAu = new Audio(makeSilentUrl()); keepAu.loop = true; }
      var pr = keepAu.play(); if (pr && pr.catch) pr.catch(function () {});
    } catch (e) {}
  }
  function stopKeep() { if (keepAu) { try { keepAu.pause(); } catch (e) {} } }
  function setMeta() {
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: book ? book.title : 'Lettura', artist: 'DEMOreader' }); } catch (e) {}
    }
  }
  // controllo "ci sei ancora?": con lo schermo spento (o in un'altra scheda) la lettura si ferma dopo 20 minuti
  function clearAway() { if (awayTimer) { clearTimeout(awayTimer); awayTimer = null; } }
  function armAway() {
    clearAway();
    if (!playing || document.visibilityState !== 'hidden') return;
    awayTimer = setTimeout(function () {
      awayTimer = null;
      if (playing && document.visibilityState === 'hidden') { awayStopped = true; pause(); }
    }, AWAY_MIN * 60000);
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
    startKeep(); setMeta();
  }

  function pause() {
    playing = false; gen++;
    try { localStorage.removeItem('lettore-playing'); } catch (e) {}
    window.speechSynthesis.cancel();
    piperStop(); stopKeep(); clearAway();
    updatePlayBtn();
    releaseWake();
  }

  var ICO_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var ICO_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
  function updatePlayBtn() {
    $('play').innerHTML = (playing ? ICO_PAUSE : ICO_PLAY) + '<span>' + (playing ? 'Pausa' : 'Leggi') + '</span>';
    if ('mediaSession' in navigator) { try { navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'; } catch (e) {} }
  }

  $('play').onclick = function () { if (playing) pause(); else speak(cur); };
  $('next').onclick = function () { var n = Math.min(sents.length - 1, cur + 1); if (playing) speak(n); else show(n); };
  $('prev').onclick = function () { var n = Math.max(0, cur - 1); if (playing) speak(n); else show(n); };
  $('pos').onchange = function () { var n = parseInt(this.value, 10); if (playing) speak(n); else show(n, true); };
  // tasto indietro del telefono (Android): chiude i pannelli, poi torna alla libreria invece di uscire dall'app
  var histPushed = false;
  function goBack() { try { localStorage.removeItem('lettore-open'); } catch (e) {} pause(); clearSleep(); closeSheets(); showView('v-lib'); renderList(); }
  $('back').onclick = function () { if (histPushed) { history.back(); } else { goBack(); } };
  window.addEventListener('popstate', function () {
    if (selMode) { selExit(true); return; }
    selPushed = false;
    histPushed = false;
    if (!$('v-read').classList.contains('on')) return;
    if ($('sheet-pages').classList.contains('open') || $('sheet-set').classList.contains('open')) {
      closeSheets();
      try { history.pushState({ r: 1 }, ''); histPushed = true; } catch (e) {}
      return;
    }
    goBack();
  });

  // ---------- Pannelli che salgono dal basso ----------
  function closeSheets() {
    $('sheet-pages').classList.remove('open');
    $('sheet-set').classList.remove('open');
    $('sheet-art').classList.remove('open');
    $('bk').classList.remove('on');
  }
  function openSheet(id) {
    closeSheets();
    $(id).classList.add('open');
    $('bk').classList.add('on');
  }
  $('bk').onclick = closeSheets;
  $('gear').onclick = function () { openSheet('sheet-set'); };

  // ---------- Torna all'inizio (v24) ----------
  $('totop').onclick = function () {
    if (!sents.length) return;
    if (playing) pause();
    show(0, true);
    $('text').scrollTop = 0;
  };

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
    toast('Preparo la voce… (qualche secondo la prima volta)'); phase('carico la voce');
    var p = PiperEngine.loadVoice(def, function (l, t, ph) {
      if (ph === 'init') toast('Preparo la voce…');
      else if (t) toast('Scarico la voce… ' + Math.min(100, Math.round(100 * l / t)) + '%');
    }).then(function (st) {
      pState = st; pKey = def.key; piperDone[def.key] = true; phase('voce caricata, prova a vuoto');
      var esp = (st.cfg.espeak && st.cfg.espeak.voice) || 'it';
      // un primo giro "a vuoto": la prima frase vera parte poi molto più in fretta
      return PiperEngine.phonemize(['Prova.'], esp).then(function (ids) {
        return ids[0] && ids[0].length ? PiperEngine.run(st, ids[0], 1) : 0;
      }).catch(function () {}).then(function () { toast(''); phase('voce pronta'); return st; });
    });
    pLoading[def.key] = p;
    p.then(function () { delete pLoading[def.key]; }, function () { delete pLoading[def.key]; toast(''); });
    return p;
  }

  // riproduttore: un elemento <audio> (come un lettore musicale) che continua anche a schermo bloccato
  var evlog = [], runCount = 0, crashed = false;
  // il telefono salva i dati con calma: scrivere di continuo li fa perdere se l'app si chiude di colpo, quindi scrivo ogni 4 secondi
  var phPend = null, phTimer = null, lastPend = null;
  function phFlush() {
    phTimer = null;
    try {
      if (phPend) localStorage.setItem('lettore-phase', JSON.stringify(phPend));
      if (lastPend) localStorage.setItem('lettore-last', JSON.stringify(lastPend));
    } catch (e) {}
  }
  function phase(t) { phPend = { t: t, at: Date.now() }; if (!phTimer) phTimer = setTimeout(phFlush, 4000); }
  function logEv(t) {
    var d = new Date();
    evlog.push(('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) + ' ' + t);
    if (evlog.length > 10) evlog.shift();
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
    d.textContent = 'Eventi (v63): ' + (evlog.length ? evlog.join(' | ') : 'nessuno') + '\n' + (diag.gen ? 'Velocità della voce neurale: ×' + (diag.aud / diag.gen).toFixed(1) + ' (sopra 1.0 = scorrevole) · calcolo su ' + (PiperEngine.threads ? PiperEngine.threads() : 1) + ' cuore/i' : '');
  }

  // genera l'audio una frase alla volta, restando sempre un po' avanti rispetto alla voce
  function piperLoop(st, sink, g, start) {
    var esp = (st.cfg.espeak && st.cfg.espeak.voice) || 'it';
    function room() { return (g === gen && sink.ahead() > 45) ? sleepMs(300).then(room) : null; }
    // frasi lunghe: calcolate a pezzi (consumano meno memoria: l'iPhone chiude l'app se ne serve troppa) e riunite
    function pieces(t) {
      var MAXP = 150;
      if (t.length <= MAXP) return [t];
      var res = [], cur = '', parts = t.split(/(?<=[,;:])\s+/);
      for (var a = 0; a < parts.length; a++) {
        var pc = parts[a];
        if (pc.length > MAXP) {
          if (cur) { res.push(cur); cur = ''; }
          var ws = pc.split(' '), w = '';
          for (var k = 0; k < ws.length; k++) {
            if ((w + ' ' + ws[k]).length > MAXP && w) { res.push(w); w = ws[k]; } else w = w ? w + ' ' + ws[k] : ws[k];
          }
          if (w) res.push(w);
        } else if ((cur + ' ' + pc).length > MAXP && cur) { res.push(cur); cur = pc; }
        else cur = cur ? cur + ' ' + pc : pc;
      }
      if (cur) res.push(cur);
      return res;
    }
    function peakOf(pcm) { var m = 0, step = Math.max(1, pcm.length >> 12); for (var q = 0; q < pcm.length; q += step) { var v = Math.abs(pcm[q]); if (v !== v) return 99; if (v > m) m = v; } return m; }
    function runOne(ids) {
      phase('calcolo audio (frase ' + runCount + ')');
      return PiperEngine.run(st, ids, cfg.rate).then(function (r) {
        var pk = peakOf(r.pcm);
        if ((pk < 0.01 || pk > 50) && r.pcm.length > 3000) {   // pezzo muto o rovinato: nuovo calcolo con un motore nuovo
          logEv('pezzo muto (picco ' + pk.toFixed(3) + '): rifaccio');
          PiperEngine.forceRecycle();
          return PiperEngine.run(st, ids, cfg.rate);
        }
        return r;
      });
    }
    function batch(k, size) {
      if (g !== gen) return null;
      var idxs = [], texts = [], owner = [];
      for (var j = k; j < sents.length && idxs.length < size; j++) {
        var t = spokenText(j);
        if (t) { idxs.push(j); pieces(t).forEach(function (pt) { texts.push(pt); owner.push(idxs.length - 1); }); }
      }
      if (!idxs.length) { sink.finish(); return null; }
      phase('fonemi frasi ' + k);
      return PiperEngine.phonemize(texts, esp).then(function (all) {
        var chain = Promise.resolve();
        idxs.forEach(function (si, n) {
          chain = chain.then(function () {
            if (g !== gen) return;
            var mine = []; owner.forEach(function (o, m) { if (o === n && all[m] && all[m].length) mine.push(all[m]); });
            if (!mine.length) return;
            return Promise.resolve(room()).then(function () {
              if (g !== gen) return;
              var t0 = performance.now(), parts = [], rate = 22050, ch = Promise.resolve();
              mine.forEach(function (ids) {
                ch = ch.then(function () { if (g !== gen) return; return runOne(ids).then(function (r) { rate = r.rate; parts.push(r.pcm); }); });
              });
              return ch.then(function () {
                if (g !== gen || !parts.length) return;
                var gap = Math.round(rate * 0.06), tot = 0, x;
                parts.forEach(function (pc) { tot += pc.length + gap; });
                var pcm = new Float32Array(tot - gap), o = 0;
                for (x = 0; x < parts.length; x++) { pcm.set(parts[x], o); o += parts[x].length + gap; }
                diag.gen += (performance.now() - t0) / 1000; diag.aud += pcm.length / rate; showDiag();
                lastPend = { i: si, len: sents[si].t.length, t: Date.now(), n: ++runCount }; if (!phTimer) phTimer = setTimeout(phFlush, 4000);
                sink.add(pcm, rate, si);
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
    try { localStorage.setItem('lettore-playing', String(Date.now())); } catch (e) {}
    updatePlayBtn();
    show(i);
    var g = ++gen;
    window.speechSynthesis.cancel();
    piperStop(); stopKeep();
    diag.gen = 0; diag.aud = 0;
    var sink = makeSink(g);          // va creato subito, dentro il tocco dell'utente
    pSink = sink;
    requestWake();
    if ('mediaSession' in navigator && window.MediaMetadata) {
      try { navigator.mediaSession.metadata = new MediaMetadata({ title: book ? book.title : 'Lettura', artist: 'DEMOreader' }); } catch (e) {}
    }
    piperEnsure(voice.def).then(function (st) { return piperLoop(st, sink, g, i); })
      .catch(function (e) {
        if (g === gen) { pause(); toast('Voce non disponibile: ' + (e && e.message ? e.message : e), 6000); }
      });
  }

  // comandi sulla schermata di blocco dell'iPhone
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { if (!playing) speak(cur); armAway(); });
      navigator.mediaSession.setActionHandler('pause', function () { pause(); });
      navigator.mediaSession.setActionHandler('nexttrack', function () { $('next').onclick(); armAway(); });
      navigator.mediaSession.setActionHandler('previoustrack', function () { $('prev').onclick(); armAway(); });
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

  // blocco del testo: i tocchi sullo schermo non spostano nulla; si sblocca da qui
  function applyLock() {
    var on = !!cfg.lockText;
    if (on) { $('text').classList.add('locked'); $('v-read').classList.add('tl'); }
    else { $('text').classList.remove('locked'); $('v-read').classList.remove('tl'); }
    $('lock').checked = on;
    $('pos').disabled = on;
    $('totop').disabled = on;
  }
  $('lock').onchange = function () { cfg.lockText = this.checked; saveCfg(); applyLock(); };
  applyLock();
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
    if (document.visibilityState === 'visible') {
      if (hiddenAt) {
        var tot = Math.round((Date.now() - hiddenAt) / 1000);
        var alive = Math.max(0, Math.round((lastBeat - hiddenAt) / 1000));
        var spoke = lastSpeechAt > hiddenAt ? Math.round((lastSpeechAt - hiddenAt) / 1000) + 's' : 'mai';
        logEv('riacceso dopo ' + tot + 's; app attiva ~' + alive + 's; ultima frase a ' + spoke);
        hiddenAt = 0;
      }
      clearAway();
      if (playing) requestWake();
      if (awayStopped) { awayStopped = false; toast('Lettura fermata dopo ' + AWAY_MIN + ' minuti a schermo spento. Premi Leggi per continuare.', 7000); }
    } else {
      if (playing) { hiddenAt = Date.now(); lastBeat = hiddenAt; logEv('schermo spento'); }
      armAway();
    }
  });

  // ---------- Avvio ----------
  updatePlayBtn();
  piperInit();
  openDB().then(function () {
    renderList();
    try {
      var pl = localStorage.getItem('lettore-playing');
      if (pl) {
        var ph = {}; try { ph = JSON.parse(localStorage.getItem('lettore-phase') || '{}'); } catch (e) {}
        var ls = {}; try { ls = JSON.parse(localStorage.getItem('lettore-last') || '{}'); } catch (e) {}
        localStorage.removeItem('lettore-playing');
        crashed = true;
        var ok = ls.t && ls.t >= +pl;
        logEv('CHIUSURA IMPROVVISA: ultima fase "' + (ph.t || '?') + '" a ' + (ph.at && ph.at >= +pl ? Math.round((ph.at - +pl) / 1000) + 's dall\'avvio' : 'tempo ignoto') + '; frasi pronte: ' + (ok ? ls.n : 0));
      }
    } catch (e) {}
    var sh = null;
    try { sh = readShare(); } catch (e) {}
    if (sh) {
      try { history.replaceState(null, '', location.pathname); } catch (e) {}
      try { localStorage.removeItem('lettore-open'); } catch (e) {}
      artMsg('');
      openSheet('sheet-art');
      if (sh.link) { $('art-url').value = sh.link; setTimeout(function () { $('art-go').click(); }, 300); }
      else { $('art-title').value = sh.title; $('art-text').value = sh.text; artMsg('Ho ricevuto del testo: controlla e tocca «Aggiungi il testo».'); }
    } else {
      try { var lo = localStorage.getItem('lettore-open'); if (lo) openBook(isNaN(+lo) ? lo : +lo); } catch (e) {}
    }
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  });
  // ---------- Aggiorna l'app senza chiuderla (v25) ----------
  $('refresh').onclick = function () {
    var btn = this;
    if (btn.classList.contains('spin')) return;
    btn.classList.add('spin');
    setStatus('Aggiornamento in corso…');
    var files = ['./', 'index.html', 'app.js', 'sw.js', 'manifest.webmanifest'];
    // cache:'reload' salta la copia temporanea del browser e scarica davvero la versione nuova
    Promise.all(files.map(function (f) { return fetch(f, { cache: 'reload' }).then(function (r) { if (!r.ok) throw new Error('http'); }); }))
      .then(function () {
        if (!('serviceWorker' in navigator)) return;
        return navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.update() : null; }).catch(function () {});
      })
      .then(function () { setTimeout(function () { location.reload(); }, 400); })
      .catch(function () {
        btn.classList.remove('spin');
        setStatus('Impossibile aggiornare: controlla la connessione.');
        setTimeout(function () { setStatus(''); }, 4000);
      });
  };

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }
})();
