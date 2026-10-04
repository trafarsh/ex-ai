/* Edit Suite, Make pack tab: movie -> shots -> characters -> chosen scenes -> exported scenepack. */
(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  var P = window.PackLib;
  var $ = function (id) { return document.getElementById(id); };
  var nodeRequire = window.cep_node ? window.cep_node.require : (typeof require === 'function' ? require : null);
  var fs = nodeRequire ? nodeRequire('fs') : null;
  var path = nodeRequire ? nodeRequire('path') : null;
  var os = nodeRequire ? nodeRequire('os') : null;

  var SETTINGS_KEY = 'editSuite.pack';
  var SAVED = ['pk-sens', 'pk-perShot', 'pk-folder', 'pk-preset', 'pk-perChar', 'pk-ame'];
  var BATCH = 6; // shots per Premiere frame-export call

  var pk = {
    info: null, shots: [], byNumber: {}, signature: '', cacheDir: '',
    faces: [], done: {}, previews: {},
    ui: { names: {}, suggested: {}, merges: [], hidden: {}, deselected: {}, picked: {}, thr: 45, min: 3 },
    chars: [], cast: [], running: false, stop: false, openKey: null, showHidden: false, saveTimer: null, started: false
  };

  // ------------------------------------------------------------------ basics

  function host(ns, fn, args) {
    var script = ns + '.' + fn + '(' + JSON.stringify(JSON.stringify(args || {})) + ')';
    return new Promise(function (resolve, reject) {
      if (!cep) return reject(new Error('Open this panel inside Premiere Pro.'));
      cep.evalScript(script, function (raw) {
        var res;
        try { res = JSON.parse(raw); } catch (e) { return reject(new Error('Premiere did not answer (' + raw + '). Restart Premiere if this repeats.')); }
        if (res.ok) resolve(res.data); else reject(new Error(res.error));
      });
    });
  }

  function log(msg, cls) {
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    $('log').appendChild(line);
    $('log').scrollTop = $('log').scrollHeight;
  }

  function busy(ids, on) { ids.forEach(function (id) { $(id).disabled = on; }); }

  function action(id, fn) {
    $(id).addEventListener('click', function () {
      if ($(id).disabled) return;
      $(id).disabled = true;
      Promise.resolve().then(fn).catch(function (e) { log(e.message, 'error'); }).then(function () { $(id).disabled = false; });
    });
  }

  function fileUrl(p) { return p ? 'file:///' + encodeURI(String(p).replace(/\\/g, '/').replace(/^\/+/, '')).replace(/#/g, '%23') : ''; }
  function pad(n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; }
  function secs(s) { return (Number(s.endTicks) - Number(s.startTicks)) / P.TPS; }

  function saveSettings() {
    var s = {};
    SAVED.forEach(function (id) { s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    SAVED.forEach(function (id) {
      if (!(id in s) || id === 'pk-preset') return;
      if ($(id).type === 'checkbox') $(id).checked = !!s[id]; else $(id).value = s[id];
    });
    return s;
  }

  // ------------------------------------------------------------------ cache

  function cacheFile() { return path.join(pk.cacheDir, 'analysis.json'); }

  function loadCache() {
    pk.faces = []; pk.done = {}; pk.previews = {};
    pk.ui = { names: {}, suggested: {}, merges: [], hidden: {}, deselected: {}, picked: {}, thr: 45, min: 3 };
    if (!fs) return;
    try {
      var data = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
      if (data.ui) pk.ui = Object.assign(pk.ui, data.ui);
      if (data.signature === pk.signature) {
        pk.faces = data.faces || [];
        pk.done = data.done || {};
        pk.previews = data.previews || {};
      }
    } catch (e) { /* first run */ }
    $('pk-thr').value = pk.ui.thr;
    $('pk-min').value = pk.ui.min;
  }

  function saveCache(now) {
    if (!fs || !pk.cacheDir) return;
    clearTimeout(pk.saveTimer);
    var write = function () {
      try {
        fs.mkdirSync(pk.cacheDir, { recursive: true });
        fs.writeFileSync(cacheFile(), JSON.stringify({ signature: pk.signature, faces: pk.faces, done: pk.done, previews: pk.previews, ui: pk.ui }));
      } catch (e) { log('Could not save progress: ' + e.message, 'warn'); }
    };
    if (now) write(); else pk.saveTimer = setTimeout(write, 800);
  }

  // ------------------------------------------------------------- 1-2 movie + shots

  function guessTitle(name) {
    return String(name).replace(/^Scenepack - /, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ')
      .replace(/\b(2160p|1080p|720p|4k|uhd|bluray|blu ray|brrip|webrip|web dl|web|hdr|x264|x265|h264|h265|hevc|aac|dts|remux|proper|extended)\b.*$/i, '')
      .replace(/[\[(]\s*$/, '').trim();
  }

  function readShots() {
    return host('ShotExporter', 'getSequenceInfo', { trackIndex: 0 }).then(function (si) {
      pk.info = si;
      pk.shots = si.shots;
      pk.byNumber = {};
      si.shots.forEach(function (s) { pk.byNumber[s.number] = s; });
      pk.signature = P.shotsSignature(si.shots);
      // Exact ticks per frame, from any shot (its length is a whole number of frames).
      var sample = si.shots.filter(function (x) { return x.frames > 0; })[0];
      pk.frameTicks = sample ? (Number(sample.endTicks) - Number(sample.startTicks)) / sample.frames : P.TPS / si.fps;
      pk.cacheDir = fs ? path.join(os.tmpdir(), 'EditSuite', 'packs', String(si.sequenceId).replace(/[^\w-]/g, '_')) : '';
      loadCache();
      var analysed = Object.keys(pk.done).length;
      $('pk-movie').textContent = '“' + si.sequenceName + '” · ' + si.shots.length + ' shot' + (si.shots.length === 1 ? '' : 's') + ' on V1' +
        (analysed ? ' · ' + analysed + ' analysed' : '');
      if (!$('pk-title').value) $('pk-title').value = guessTitle(si.sequenceName);
      if (si.shots.length === 1) log('The movie is one clip. Run “Find shots” to cut it into shots.', 'warn');
      regroup();
    });
  }

  // ------------------------------------------------------------- 3 analysis

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.faceapi) return resolve();
      var el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(el);
    });
  }

  function loadModels() {
    var ext = window.SUITE_EXT_PATH;
    return loadScript('vendor/face-api/face-api.js').then(function () {
      var wasm = {};
      ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm'].forEach(function (n) {
        var bytes = fs.readFileSync(path.join(ext, 'vendor', 'face-api', n));
        wasm[n] = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
      });
      wasm['tfjs-backend-wasm-threaded-simd.wasm'] = wasm['tfjs-backend-wasm-simd.wasm'];
      return window.Faces.load({ dir: path.join(ext, 'vendor', 'face-api', 'model'), fs: fs, path: path, wasmPaths: wasm });
    });
  }

  function writeDataUrl(file, dataUrl) {
    fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  }

  async function analyseFrame(file, shot, k, faceDir, previewDir) {
    var canvas = await window.Faces.canvasFromBlob(new Blob([fs.readFileSync(file)], { type: 'image/jpeg' }));
    if (k === 0) {
      var pv = path.join(previewDir, 's' + shot + '.jpg');
      writeDataUrl(pv, window.Faces.preview(canvas, 240));
      pk.previews[shot] = pv;
    }
    var found = await window.Faces.detect(canvas);
    found.forEach(function (f, j) {
      var id = shot + '_' + k + '_' + j, thumb = path.join(faceDir, id + '.jpg');
      writeDataUrl(thumb, window.Faces.thumb(canvas, f.box, 112));
      pk.faces.push({ id: id, shot: shot, frame: k, score: f.score, box: f.box, descriptor: f.descriptor, thumb: thumb });
    });
    try { fs.unlinkSync(file); } catch (e) { /* keep going */ }
  }

  async function analyse() {
    if (!fs) throw new Error('Character search needs Premiere 2022 or newer.');
    if (!pk.shots.length) throw new Error('Pick the movie first (step 1).');
    if (pk.shots.length < 2) throw new Error('Find shots first (step 2).');
    var perShot = Number($('pk-perShot').value) || 2;
    var todo = pk.shots.filter(function (s) { return !pk.done[s.number]; });
    if (!todo.length) { log('All shots are already analysed. Adjust “Grouping” to regroup.', 'ok'); return; }

    pk.running = true; pk.stop = false;
    busy(['pk-analyze', 'pk-shots', 'pk-fromProject', 'pk-fromSeq'], true);
    $('pk-stop').disabled = false;
    $('pk-status').textContent = 'Loading face models…';
    try {
      var backend = await loadModels();
      var frameDir = path.join(pk.cacheDir, 'frames'), faceDir = path.join(pk.cacheDir, 'faces'), previewDir = path.join(pk.cacheDir, 'previews');
      [frameDir, faceDir, previewDir].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });

      var batches = [];
      for (var i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
      var exportBatch = function (batch) {
        var items = [];
        batch.forEach(function (s) {
          P.frameTimes(s.startTicks, s.endTicks, perShot, pk.frameTicks).forEach(function (t, k) {
            items.push({ ticks: String(Math.round(t)), name: 's' + s.number + '_' + k, shot: s.number, k: k });
          });
        });
        return host('PackMaker', 'exportFrames', { dir: frameDir, items: items }).then(function (files) {
          return files.map(function (f, n) { return { path: f.path, shot: items[n].shot, k: items[n].k }; });
        });
      };

      var total = pk.shots.length, started = Date.now(), doneNow = 0, missing = 0;
      var next = exportBatch(batches[0]);
      for (var b = 0; b < batches.length && !pk.stop; b++) {
        var files = await next;
        if (b + 1 < batches.length) next = exportBatch(batches[b + 1]); // Premiere exports while we analyse
        for (var f = 0; f < files.length && !pk.stop; f++) {
          if (!files[f].path) { missing++; continue; }
          await analyseFrame(files[f].path, files[f].shot, files[f].k, faceDir, previewDir);
        }
        batches[b].forEach(function (s) { pk.done[s.number] = true; });
        doneNow += batches[b].length;
        var analysed = Object.keys(pk.done).length, per = (Date.now() - started) / doneNow;
        var left = Math.round(per * (total - analysed) / 60000);
        $('pk-progress').max = total;
        $('pk-progress').value = analysed;
        $('pk-status').textContent = analysed + ' / ' + total + ' shots · ' + pk.faces.length + ' faces · ' +
          (left ? 'about ' + left + ' min left' : 'almost done') + ' · ' + backend;
        if (b % 5 === 4) { regroup(); saveCache(); }
      }
      regroup();
      if (missing) log(missing + ' frame(s) could not be exported from Premiere and were skipped.', 'warn');
      log(pk.stop ? 'Stopped. Click “Find characters” to continue where you left off.' : 'Found ' + pk.chars.length + ' characters in ' + total + ' shots.', 'ok');
    } finally {
      pk.running = false;
      busy(['pk-analyze', 'pk-shots', 'pk-fromProject', 'pk-fromSeq'], false);
      $('pk-stop').disabled = true;
      regroup();
      saveCache(true);
    }
  }

  // ------------------------------------------------------------- 4 characters

  function lookup(map, ch) {
    if (map[ch.key] !== undefined) return map[ch.key];
    for (var i = 0; i < ch.faces.length; i++) if (map[ch.faces[i].id] !== undefined) return map[ch.faces[i].id];
    return undefined;
  }

  function nameOf(ch) { return lookup(pk.ui.names, ch) || ch.label; }

  function selectedShots(ch) {
    var off = lookup(pk.ui.deselected, ch) || {};
    return ch.shots.filter(function (n) { return !off[n]; });
  }

  function regroup() {
    pk.ui.thr = Number($('pk-thr').value);
    pk.ui.min = Math.max(1, Number($('pk-min').value) || 3);
    $('pk-thrLabel').textContent = pk.ui.thr <= 42 ? '(strict)' : pk.ui.thr >= 54 ? '(loose)' : '(balanced)';
    var res = P.clusterFaces(pk.faces, pk.ui.thr / 100, pk.ui.min);
    var chars = res.characters;

    // Manual merges are stored as face ids, so they survive regrouping.
    pk.ui.merges.forEach(function (group) {
      var members = chars.filter(function (ch) { return ch.faces.some(function (f) { return group.indexOf(f.id) >= 0; }); });
      if (members.length < 2) return;
      var into = members[0];
      members.slice(1).forEach(function (m) {
        into.faces = into.faces.concat(m.faces);
        m.shots.forEach(function (s) { if (into.shots.indexOf(s) < 0) into.shots.push(s); });
        chars.splice(chars.indexOf(m), 1);
      });
      into.shots.sort(function (a, b) { return a - b; });
    });
    chars.sort(function (a, b) { return b.shots.length - a.shots.length; });
    chars.forEach(function (ch, i) {
      ch.label = 'Character ' + pad(i + 1, 2);
      ch.hidden = !!lookup(pk.ui.hidden, ch);
    });
    pk.chars = chars;
    renderChars();
    saveCache();
  }

  function visibleChars() { return pk.chars.filter(function (c) { return pk.showHidden || !c.hidden; }); }

  function renderChars() {
    var box = $('pk-chars');
    box.innerHTML = '';
    var list = visibleChars();
    $('pk-count').textContent = pk.chars.length ? pk.chars.length + ' characters' + (pk.chars.length - list.length ? ' (' + (pk.chars.length - list.length) + ' hidden)' : '') : '';
    list.forEach(function (ch) {
      var card = document.createElement('div');
      card.className = 'char' + (lookup(pk.ui.picked, ch) ? ' on' : '');
      var pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'pick';
      pick.checked = !!lookup(pk.ui.picked, ch);
      pick.title = 'Tick to export, merge or hide';
      pick.addEventListener('change', function () {
        if (pick.checked) pk.ui.picked[ch.key] = true; else { delete pk.ui.picked[ch.key]; ch.faces.forEach(function (f) { delete pk.ui.picked[f.id]; }); }
        card.classList.toggle('on', pick.checked);
        saveCache();
      });
      var img = document.createElement('img');
      img.src = fileUrl(ch.cover.thumb);
      img.alt = '';
      img.title = 'View scenes';
      img.addEventListener('click', function () { openScenes(ch); });
      var name = document.createElement('input');
      name.type = 'text';
      name.setAttribute('list', 'pk-castList');
      name.placeholder = ch.label;
      name.value = lookup(pk.ui.names, ch) || '';
      name.addEventListener('change', function () {
        var v = name.value.trim();
        if (v) pk.ui.names[ch.key] = v; else delete pk.ui.names[ch.key];
        delete pk.ui.suggested[ch.key];
        sugg.hidden = true;
        saveCache();
      });
      var meta = document.createElement('div');
      meta.className = 'meta';
      var count = document.createElement('a');
      count.href = '#';
      count.textContent = selectedShots(ch).length + '/' + ch.shots.length + ' scenes';
      count.addEventListener('click', function (e) { e.preventDefault(); openScenes(ch); });
      var sugg = document.createElement('span');
      sugg.className = 'sugg';
      sugg.textContent = 'suggested';
      sugg.hidden = !lookup(pk.ui.suggested, ch);
      meta.appendChild(count);
      meta.appendChild(sugg);
      [pick, img, name, meta].forEach(function (el) { card.appendChild(el); });
      if (ch.hidden) card.style.opacity = 0.5;
      box.appendChild(card);
    });
    if (!pk.chars.length && pk.faces.length) {
      box.innerHTML = '<p class="muted small">No character appears in ' + pk.ui.min + '+ scenes yet. Lower “Min. scenes” or loosen “Grouping”.</p>';
    }
  }

  function picked() { return visibleChars().filter(function (ch) { return lookup(pk.ui.picked, ch); }); }

  function mergePicked() {
    var list = picked();
    if (list.length < 2) throw new Error('Tick two or more cards that are the same character.');
    var ids = [];
    list.forEach(function (ch) { ids.push(ch.key); ch.faces.slice(0, 20).forEach(function (f) { ids.push(f.id); }); });
    pk.ui.merges.push(ids);
    var keepName = list.map(nameOf).filter(function (n) { return !/^Character \d+$/.test(n); })[0];
    if (keepName) pk.ui.names[list[0].key] = keepName;
    log('Merged ' + list.length + ' cards.', 'ok');
    regroup();
  }

  function hidePicked() {
    var list = picked();
    if (!list.length) throw new Error('Tick the cards to hide (extras, wrong faces…).');
    list.forEach(function (ch) { pk.ui.hidden[ch.key] = true; delete pk.ui.picked[ch.key]; });
    regroup();
  }

  // ------------------------------------------------------------------ cast

  function setCast(cast, source) {
    pk.cast = cast;
    var dl = $('pk-castList');
    dl.innerHTML = '';
    cast.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.character || c.actor;
      if (c.character && c.actor) o.label = c.actor;
      dl.appendChild(o);
    });
    log(cast.length + ' cast members from ' + source + '. Type in a name box to pick one, or use “Suggest names”.', 'ok');
  }

  function getJson(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  async function getCast() {
    var raw = $('pk-title').value.trim();
    if (!raw) throw new Error('Type the movie or show title first.');
    var year = (/\b(19|20)\d{2}\b/.exec(raw) || [])[0];
    var title = raw.replace(/[(\[]?\b(19|20)\d{2}\b[)\]]?/, '').trim();
    var hit;
    try { hit = P.pickTitle(await getJson(P.wikidataSearchUrl(title)), year); } catch (e) {
      throw new Error('Could not reach Wikidata (' + e.message + '). Paste the cast list instead.');
    }
    if (!hit) throw new Error('No film or show called “' + title + '” on Wikidata. Try adding the year, or paste the cast.');
    var cast = P.castFromEntity(await getJson(P.entityUrl([hit.id], 'claims')), hit.id);
    if (!cast.length) throw new Error('Wikidata has no cast for ' + hit.label + '. Paste the cast list instead.');
    var ids = [];
    cast.forEach(function (c) { ids.push(c.actorId); ids = ids.concat(c.roleIds); });
    var labels = {};
    for (var i = 0; i < ids.length; i += 50) Object.assign(labels, P.labelsFrom(await getJson(P.entityUrl(ids.slice(i, i + 50), 'labels'))));
    setCast(P.namedCast(cast, labels), hit.label + ' (' + (hit.description || 'Wikidata') + ')');
  }

  function suggest() {
    if (!pk.cast.length) throw new Error('Get or paste the cast first.');
    var list = visibleChars().filter(function (ch) { return !ch.hidden; });
    var current = {};
    list.forEach(function (ch) { var n = lookup(pk.ui.names, ch); if (n) current[ch.key] = n; });
    var names = P.suggestNames(list, pk.cast, current), n = 0;
    Object.keys(names).forEach(function (k) {
      if (current[k]) return;
      pk.ui.names[k] = names[k];
      pk.ui.suggested[k] = true;
      n++;
    });
    log('Suggested ' + n + ' name(s) by screen time and billing order. Check them; extras often take a lead\'s slot.', n ? 'warn' : null);
    renderChars();
    saveCache();
  }

  // ------------------------------------------------------------------ scenes

  function openScenes(ch) {
    pk.openKey = ch.key;
    $('pk-scenesBlock').hidden = false;
    var off = lookup(pk.ui.deselected, ch);
    if (!off) { off = {}; pk.ui.deselected[ch.key] = off; }
    var grid = $('pk-scenes');
    grid.innerHTML = '';
    var title = function () { $('pk-scenesTitle').textContent = nameOf(ch) + ' · ' + selectedShots(ch).length + ' of ' + ch.shots.length + ' scenes'; };
    ch.shots.forEach(function (n) {
      var s = pk.byNumber[n];
      if (!s) return;
      var card = document.createElement('div');
      card.className = 'scene' + (off[n] ? '' : ' on');
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = fileUrl(pk.previews[n]);
      var label = document.createElement('span');
      label.textContent = '#' + n + ' · ' + s.startTC + ' · ' + secs(s).toFixed(1) + 's';
      card.appendChild(img);
      card.appendChild(label);
      card.addEventListener('click', function () {
        if (off[n]) delete off[n]; else off[n] = true;
        card.classList.toggle('on', !off[n]);
        title();
        saveCache();
      });
      grid.appendChild(card);
    });
    title();
    $('pk-scenesBlock').scrollIntoView({ block: 'start', behavior: 'smooth' });
    $('pk-sAll').onclick = function () { Object.keys(off).forEach(function (k) { delete off[k]; }); openScenes(ch); renderChars(); saveCache(); };
    $('pk-sNone').onclick = function () { ch.shots.forEach(function (k) { off[k] = true; }); openScenes(ch); renderChars(); saveCache(); };
  }

  // ------------------------------------------------------------------ export

  async function exportScenes() {
    var list = picked();
    if (!list.length) throw new Error('Tick the characters to export.');
    var folder = $('pk-folder').value.trim(), preset = $('pk-preset').value;
    if (!folder) throw new Error('Choose an output folder.');
    if (!preset) throw new Error('Choose an export preset.');
    var mode = $('pk-ame').checked ? 'ame' : 'direct';
    var movie = P.folderName(guessTitle(pk.info.sequenceName) || 'movie');
    var jobs = [];
    list.forEach(function (ch) {
      var name = P.folderName(nameOf(ch));
      selectedShots(ch).forEach(function (n) {
        var s = pk.byNumber[n];
        if (s) jobs.push({ shot: s, folder: $('pk-perChar').checked ? folder.replace(/[\\/]+$/, '') + '/' + name : folder, fileName: movie + '_' + name + '_' + pad(n, 4) });
      });
    });
    if (!jobs.length) throw new Error('No scenes are selected for the ticked characters.');
    var bar = $('pk-exportProgress');
    bar.max = jobs.length;
    bar.value = 0;
    var ok = 0;
    log('Exporting ' + jobs.length + ' scenes for ' + list.length + ' character(s)…');
    await host('ShotExporter', 'beginExport', { sequenceId: pk.info.sequenceId, mode: mode, startBatch: true });
    try {
      for (var i = 0; i < jobs.length; i++) {
        try {
          await host('ShotExporter', 'exportShot', {
            sequenceId: pk.info.sequenceId, mode: mode, startTicks: jobs[i].shot.startTicks, endTicks: jobs[i].shot.endTicks,
            folder: jobs[i].folder, fileName: jobs[i].fileName, presetPath: preset, overwrite: false
          });
          ok++;
        } catch (e) { log(jobs[i].fileName + ': ' + e.message, 'error'); }
        bar.value = i + 1;
      }
    } finally {
      await host('ShotExporter', 'endExport', { mode: mode, startBatch: true }).catch(function () {});
    }
    log(ok + ' of ' + jobs.length + ' scenes ' + (mode === 'ame' ? 'queued in Media Encoder.' : 'rendered.'), ok === jobs.length ? 'ok' : 'warn');
  }

  function nameClips() {
    var labels = {};
    visibleChars().forEach(function (ch) {
      if (ch.hidden) return;
      var name = nameOf(ch);
      selectedShots(ch).forEach(function (n) { (labels[n] = labels[n] || []).push(name); });
    });
    var items = Object.keys(labels).map(function (n) { return { startTicks: pk.byNumber[n].startTicks, label: labels[n].join(' + ') }; });
    if (!items.length) throw new Error('Find characters first.');
    return host('PackMaker', 'nameClips', { items: items }).then(function (r) { log('Named ' + r.named + ' clips on V1 after their characters.', 'ok'); });
  }

  function loadPresets(want) {
    return host('ShotExporter', 'listPresets').then(function (presets) {
      var sel = $('pk-preset');
      sel.innerHTML = '';
      var add = function (parent, value, text) { var o = document.createElement('option'); o.value = value; o.textContent = text; parent.appendChild(o); };
      add(sel, '', presets.length ? 'Choose a preset…' : 'No presets found');
      var groups = {};
      presets.forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
      Object.keys(groups).sort(function (a, b) { return (a === 'H264' ? -1 : b === 'H264' ? 1 : a.localeCompare(b)); }).forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        groups[g].forEach(function (p) { add(og, p.path, p.name); });
        sel.appendChild(og);
      });
      if (want && presets.some(function (p) { return p.path === want; })) sel.value = want;
      else {
        var def = presets.filter(function (p) { return p.group === 'H264' && /Match Source - (Adaptive )?High bitrate/i.test(p.name); })[0];
        if (def) sel.value = def.path;
      }
    }).catch(function (e) { log('Presets: ' + e.message, 'warn'); });
  }

  // ------------------------------------------------------------------- init

  function init() {
    var saved = loadSettings();
    SAVED.forEach(function (id) { $(id).addEventListener('change', saveSettings); });

    action('pk-fromProject', function () {
      return host('PackMaker', 'prepare', {}).then(function (i) { log('Made sequence “' + i.name + '”.', 'ok'); return readShots(); });
    });
    action('pk-fromSeq', function () { return host('PackMaker', 'prepare', { useActive: true }).then(readShots); });
    action('pk-shots', function () {
      if (!pk.info) throw new Error('Pick the movie first (step 1).');
      $('pk-status').textContent = 'Premiere is detecting shots. A full movie can take a few minutes; Premiere looks frozen meanwhile.';
      return host('PackMaker', 'findShots', { sensitivity: $('pk-sens').value }).then(function (r) {
        log('Scene Edit Detection: ' + r.before + ' clip(s) → ' + r.shots + ' shots.', 'ok');
        $('pk-status').textContent = 'Ready to find characters.';
        return readShots();
      });
    });
    action('pk-analyze', analyse);
    $('pk-stop').addEventListener('click', function () { pk.stop = true; $('pk-stop').disabled = true; $('pk-status').textContent = 'Stopping after this frame…'; });

    $('pk-thr').addEventListener('input', function () { regroup(); });
    $('pk-min').addEventListener('change', regroup);
    action('pk-cast', getCast);
    action('pk-castUse', function () {
      var cast = P.castFromText($('pk-castText').value);
      if (!cast.length) throw new Error('Paste one cast member per line.');
      setCast(cast, 'your list');
    });
    action('pk-suggest', suggest);
    action('pk-merge', mergePicked);
    action('pk-hide', hidePicked);
    $('pk-showAll').addEventListener('click', function () { pk.showHidden = !pk.showHidden; $('pk-showAll').textContent = pk.showHidden ? 'Hide hidden' : 'Show hidden'; renderChars(); });
    $('pk-back').addEventListener('click', function () { $('pk-scenesBlock').hidden = true; renderChars(); });

    action('pk-pickFolder', function () {
      return host('ShotExporter', 'pickFolder').then(function (p) { if (p) { $('pk-folder').value = p; saveSettings(); } });
    });
    action('pk-export', exportScenes);
    action('pk-name', nameClips);

    window.PackTab = {
      activate: function () {
        if (pk.started || !cep) return;
        pk.started = true;
        loadPresets(saved['pk-preset']);
        host('PackMaker', 'info').then(function (i) { if (/^Scenepack - /.test(i.name)) return readShots(); }).catch(function () {});
      },
      _state: pk, _regroup: regroup, _readShots: readShots
    };
    regroup();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
