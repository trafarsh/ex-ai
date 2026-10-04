/* Edit Suite panel: Setup, Beats, Cut, Effects, Text, Color and Scenepacks tabs. */
(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  var lib = window.SuiteLib;
  var nodeRequire = window.cep_node ? window.cep_node.require : (typeof require === 'function' ? require : null);
  var io = nodeRequire && window.SuiteIO ? window.SuiteIO.create(nodeRequire, lib) : null;

  var SETTINGS_KEY = 'editSuite.settings';
  var FEED_KEY = 'editSuite.feed.';
  var MY_SONGS_KEY = 'editSuite.mySongs';
  var $ = function (id) { return document.getElementById(id); };
  var state = { info: null, fx: 'zoom', look: null, feeds: {}, taps: [], watcher: null, busy: false };

  // ------------------------------------------------------------------ basics

  function host(ns, fn, args) {
    var script = ns + '.' + fn + '(' + JSON.stringify(JSON.stringify(args || {})) + ')';
    return new Promise(function (resolve, reject) {
      if (!cep) return reject(new Error('Open this panel inside Premiere Pro.'));
      cep.evalScript(script, function (raw) {
        var res;
        try { res = JSON.parse(raw); } catch (e) {
          return reject(new Error(raw === 'EvalScript error.' ? 'The panel\'s scripts did not load. Restart Premiere.' : 'Bad reply: ' + raw));
        }
        if (res.ok) resolve(res.data); else reject(new Error(res.error));
      });
    });
  }
  var tk = function (fn, args) { return host('TikTokEditor', fn, args); };

  function log(msg, cls) {
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    $('log').appendChild(line);
    $('log').scrollTop = $('log').scrollHeight;
  }

  function reportNotes(res) {
    (res.errors || []).forEach(function (e) { log(e, 'error'); });
    (res.notes || []).forEach(function (n) { log(n, 'warn'); });
  }

  /** Runs an async action with its button disabled and errors logged. */
  function action(button, fn) {
    $(button).addEventListener('click', function () {
      if (state.busy) return;
      state.busy = true;
      $(button).disabled = true;
      Promise.resolve().then(fn).catch(function (e) { log(e.message, 'error'); }).then(function () {
        state.busy = false;
        $(button).disabled = false;
        refreshInfo();
      });
    });
  }

  function num(id, fallback) { var v = Number($(id).value); return isFinite(v) && $(id).value !== '' ? v : fallback; }

  function openUrl(url) {
    if (window.cep && window.cep.util && window.cep.util.openURLInDefaultBrowser) return window.cep.util.openURLInDefaultBrowser(url);
    window.open(url, '_blank');
  }

  // ---------------------------------------------------------------- settings

  var SAVED = ['bt-bpm', 'bt-every', 'bt-first', 'bt-replace', 'ct-every', 'ct-audio', 'mt-per', 'fx-intensity', 'fx-strength',
    'fx-frames', 'fx-every', 'fx-target', 'fx-blur', 'tx-mode', 'tx-per', 'tx-anim', 'tx-seconds', 'tx-upper', 'tx-template',
    'cc-intensity', 'cc-target', 'sp-auto', 'sp-dir', 'sp-site'];

  function loadSettings() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { s = {}; }
    SAVED.forEach(function (id) {
      if (!(id in s) || !$(id)) return;
      if ($(id).type === 'checkbox') $(id).checked = !!s[id]; else $(id).value = s[id];
    });
    return s;
  }

  function saveSettings() {
    var s = {};
    SAVED.forEach(function (id) { if ($(id)) s[id] = $(id).type === 'checkbox' ? $(id).checked : $(id).value; });
    s.fx = state.fx;
    s.look = state.look && state.look.id;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* not fatal */ }
  }

  // ------------------------------------------------------------- tabs / info

  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === name); });
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('on', t.id === 'tab-' + name); });
    if (name === 'export' && window.ExportTab) window.ExportTab.activate();
    if (name === 'make' && window.PackTab) window.PackTab.activate();
    try { localStorage.setItem('editSuite.tab', name); } catch (e) { /* ignore */ }
    refreshInfo();
  }

  function fillTracks(selector, count, prefix, defaults) {
    document.querySelectorAll(selector).forEach(function (sel) {
      var keep = sel.value !== '' ? sel.value : String(defaults[sel.id] || 0);
      sel.innerHTML = '';
      for (var i = 0; i < Math.max(count, 1); i++) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = prefix + (i + 1);
        sel.appendChild(o);
      }
      sel.value = Number(keep) < count ? keep : String(Math.min(defaults[sel.id] || 0, Math.max(count - 1, 0)));
    });
  }

  function refreshInfo() {
    if (!cep) return Promise.resolve();
    return tk('getInfo').then(function (info) {
      state.info = info;
      if (!info.sequence) { $('seqLine').textContent = 'No sequence open. Open your edit in the Timeline.'; return; }
      $('seqLine').textContent = '“' + info.sequence + '” · ' + info.width + '×' + info.height + ' · ' + info.fps + ' fps · ' +
        info.beats + ' beat marker' + (info.beats === 1 ? '' : 's') + (info.width > info.height ? ' · landscape' : '');
      fillTracks('.vtracks', info.videoTracks, 'V', { 'tx-track': 1 });
      fillTracks('.atracks', info.audioTracks, 'A', { 'mt-audio': 1 });
    }).catch(function () { /* Premiere busy; try again later */ });
  }

  // ------------------------------------------------------------------ feeds

  function readCache(kind) {
    try { return JSON.parse(localStorage.getItem(FEED_KEY + kind) || 'null'); } catch (e) { return null; }
  }

  function fetchJson(url) {
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
    return fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .finally(function () { clearTimeout(timer); });
  }

  /** Shows cached/bundled data right away, then refreshes from GitHub when stale or forced. */
  function loadFeed(kind, render, force) {
    var cached = readCache(kind);
    if (cached) render(cached.feed, 'updated ' + (cached.feed.updated || '?') + ', checked ' + new Date(cached.fetchedAt).toLocaleString());
    else if (io && window.SUITE_EXT_PATH) {
      try { render(lib.validateFeed(kind, io.readLocalFeed(window.SUITE_EXT_PATH, kind)), 'built-in list'); } catch (e) { /* none */ }
    }
    if (!force && cached && Date.now() - cached.fetchedAt < lib.FEED_MAX_AGE_MS) return Promise.resolve();

    var urls = lib.feedUrls(kind), i = 0;
    function next() {
      if (i >= urls.length) throw new Error('offline');
      return fetchJson(urls[i++]).then(function (data) { return lib.validateFeed(kind, data); }).catch(next);
    }
    return next().then(function (feed) {
      try { localStorage.setItem(FEED_KEY + kind, JSON.stringify({ fetchedAt: Date.now(), feed: feed })); } catch (e) { /* ignore */ }
      render(feed, 'updated ' + (feed.updated || '?') + ', checked just now');
      if (force) log('Looks list is up to date (' + feed.items.length + ' looks).', 'ok');
    }).catch(function () {
      if (force) log('Could not reach the online ' + kind + ' list; using the saved copy.', 'warn');
    });
  }

  // ------------------------------------------------------------------ setup

  function initSetup() {
    action('su-vertical', function () {
      return tk('makeVertical', { width: 1080, height: 1920 }).then(function () { log('Sequence is now 1080×1920.', 'ok'); });
    });
    action('su-newSeq', function () {
      return tk('newVerticalFromSelection', { name: 'TikTok 9x16' }).then(function (r) {
        log('Created “' + r.name + '” with ' + r.clips + ' clip(s). Use Fill frame next.', 'ok');
      });
    });
    function fill(mode) {
      return tk('fillFrame', { mode: mode, target: $('su-selOnly').checked ? 'selected' : 'all' }).then(function (r) {
        log('Scaled ' + r.scaled + ' clip(s) to ' + mode + ' the frame.', 'ok');
        if (r.skipped.length) log('Skipped: ' + r.skipped.slice(0, 6).join(', ') + (r.skipped.length > 6 ? '…' : ''), 'warn');
      });
    }
    action('su-fill', function () { return fill('fill'); });
    action('su-fit', function () { return fill('fit'); });
  }

  // ------------------------------------------------------------------ beats

  function mySongs() {
    try { return JSON.parse(localStorage.getItem(MY_SONGS_KEY) || '[]'); } catch (e) { return []; }
  }

  function renderSongs() {
    var q = $('bt-search').value.toLowerCase();
    var feed = state.feeds.trending ? state.feeds.trending.items : [];
    var all = mySongs().map(function (s) { return { title: s.title, bpm: s.bpm, mine: true }; }).concat(feed);
    var list = $('bt-songs');
    list.innerHTML = '';
    var shown = all.filter(function (s) {
      return !q || (String(s.title) + ' ' + (s.artist || '') + ' ' + (s.tags || []).join(' ')).toLowerCase().indexOf(q) >= 0;
    });
    shown.forEach(function (s, idx) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.textContent = (s.mine ? '★ ' : '') + s.title + (s.artist ? ' · ' + s.artist : '');
      var bpm = document.createElement('span');
      bpm.className = 'bpm';
      bpm.textContent = s.bpm + ' BPM';
      li.appendChild(name);
      li.appendChild(bpm);
      li.title = s.mine ? 'Click to use · right-click to remove' : 'Click to use this BPM';
      li.addEventListener('click', function () { $('bt-bpm').value = s.bpm; saveSettings(); log('BPM set to ' + s.bpm + ' (' + s.title + ').'); });
      if (s.mine) li.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        var mine = mySongs();
        mine.splice(idx, 1);
        localStorage.setItem(MY_SONGS_KEY, JSON.stringify(mine));
        renderSongs();
      });
      list.appendChild(li);
    });
    if (!shown.length) {
      var empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = feed.length || mySongs().length ? 'No match.' : 'No trending list published yet. Add your own under “My songs”.';
      list.appendChild(empty);
    }
  }

  function tap() {
    var now = Date.now();
    state.taps.push(now);
    if (state.taps.length > 40) state.taps.shift();
    var bpm = lib.tapTempo(state.taps);
    $('bt-tapBpm').textContent = bpm ? bpm : '…';
    if (bpm) $('bt-bpm').value = Math.round(bpm);
    var b = $('bt-tap');
    b.classList.add('hit');
    setTimeout(function () { b.classList.remove('hit'); }, 90);
  }

  function initBeats() {
    action('bt-playhead', function () {
      return tk('getInfo').then(function (info) {
        if (!info.sequence) throw new Error('Open a sequence first.');
        $('bt-first').value = info.playhead;
        saveSettings();
      });
    });
    action('bt-create', function () {
      return tk('createBeats', {
        bpm: num('bt-bpm', 0), every: num('bt-every', 1), firstSeconds: num('bt-first', 0), replace: $('bt-replace').checked
      }).then(function (r) { log(r.count + ' beat markers, one every ' + r.intervalSeconds.toFixed(3) + ' s.', 'ok'); });
    });
    action('bt-clear', function () {
      return tk('clearBeats').then(function (r) { log('Removed ' + r.removed + ' beat marker(s).', 'ok'); });
    });
    $('bt-tap').addEventListener('click', tap);
    document.addEventListener('keydown', function (e) {
      var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName);
      if (!typing && (e.key === 't' || e.key === 'T') && $('tab-beats').classList.contains('on')) tap();
    });
    $('bt-search').addEventListener('input', renderSongs);
    $('bt-myAdd').addEventListener('click', function () {
      var title = $('bt-myTitle').value.trim(), bpm = Number($('bt-myBpm').value);
      if (!title || !(bpm >= 30 && bpm <= 300)) return log('Enter a song name and a BPM between 30 and 300.', 'warn');
      var mine = mySongs();
      mine.unshift({ title: title, bpm: bpm });
      localStorage.setItem(MY_SONGS_KEY, JSON.stringify(mine.slice(0, 200)));
      $('bt-myTitle').value = '';
      $('bt-myBpm').value = '';
      renderSongs();
    });
    loadFeed('trending', function (feed, status) {
      state.feeds.trending = feed;
      $('bt-feedInfo').textContent = feed.items.length ? feed.items.length + ' songs · ' + status : '';
      renderSongs();
    });
    renderSongs();
  }

  // -------------------------------------------------------------------- cut

  function initCut() {
    action('ct-cut', function () {
      return tk('cutAtBeats', { trackIndex: num('ct-track', 0), everyN: num('ct-every', 1), withAudio: $('ct-audio').checked })
        .then(function (r) { log('Made ' + r.cuts + ' cut(s): ' + r.clipsBefore + ' → ' + r.clipsAfter + ' clips.', 'ok'); });
    });
    action('mt-run', function () {
      return tk('beatMontage', { trackIndex: num('mt-track', 0), audioTrackIndex: num('mt-audio', 1), beatsPerClip: num('mt-per', 1) })
        .then(function (r) { log('Placed ' + r.placed + ' of ' + r.of + ' clip(s) on the beats.', r.placed === r.of ? 'ok' : 'warn'); });
    });
  }

  // ---------------------------------------------------------------- effects

  var FX_INFO = {
    zoom: { defaults: { intensity: 20, frames: 6 }, help: 'Intensity = how far it zooms (%). Length = frames to ease back.' },
    shake: { defaults: { strength: 40, frames: 8 }, help: 'Strength = shake size in pixels. Length = frames it shakes for.' },
    flash: { defaults: { strength: 3, frames: 4 }, help: 'Strength = flash brightness in exposure stops (2–5). Length = fade-out frames.' },
    glitch: { defaults: { strength: 40, frames: 6 }, help: 'Strength = jitter in pixels (RGB split if VR Chromatic Aberrations is installed). Length = glitch frames.' },
    flicker: { defaults: { strength: 50, frames: 2 }, help: 'Strength = how hard the color flicks (50 = medium). Length = frames each flick holds.' },
    velocity: { defaults: { intensity: 20, strength: 40 }, help: 'Intensity = scale rush (%). Strength = directional blur length. Always uses motion blur.' }
  };

  function selectFx(name, keepValues) {
    state.fx = name;
    document.querySelectorAll('#fx-cards .card').forEach(function (c) { c.classList.toggle('on', c.dataset.fx === name); });
    var info = FX_INFO[name];
    if (!keepValues) {
      if (info.defaults.intensity) $('fx-intensity').value = info.defaults.intensity;
      if (info.defaults.strength) $('fx-strength').value = info.defaults.strength;
      if (info.defaults.frames) $('fx-frames').value = info.defaults.frames;
    }
    $('fx-intensity').disabled = !info.defaults.intensity;
    $('fx-strength').disabled = !info.defaults.strength;
    $('fx-frames').disabled = !info.defaults.frames;
    $('fx-blur').disabled = name === 'flash' || name === 'flicker' || name === 'glitch' || name === 'velocity';
    $('fx-help').textContent = info.help;
  }

  function applyFx(effect, target) {
    return tk('applyBeatEffect', {
      effect: effect,
      target: target || $('fx-target').value,
      trackIndex: num('fx-track', 0),
      everyN: num('fx-every', 1),
      intensity: num('fx-intensity', 20),
      strength: effect === 'flicker' && target ? 50 : num('fx-strength', 40),
      frames: effect === 'flicker' && target ? 2 : num('fx-frames', 6),
      blur: $('fx-blur').checked
    }).then(function (r) {
      reportNotes(r);
      if (!r.clips) log('No beat markers fall inside the chosen clips.', 'warn');
      else log(effect + ': ' + r.keyframes + ' keyframes on ' + r.clips + ' clip(s).', 'ok');
    });
  }

  function initFx(saved) {
    document.querySelectorAll('#fx-cards .card').forEach(function (c) {
      c.addEventListener('click', function () { selectFx(c.dataset.fx); saveSettings(); });
    });
    selectFx(FX_INFO[saved.fx] ? saved.fx : 'zoom', true);
    action('fx-apply', function () { return applyFx(state.fx); });
  }

  // ------------------------------------------------------------------- text

  function initText(saved) {
    function addOption(sel, path, label) {
      var o = document.createElement('option');
      o.value = path;
      o.textContent = label;
      sel.appendChild(o);
    }
    tk('listTitles').then(function (titles) {
      var sel = $('tx-template');
      sel.innerHTML = '';
      addOption(sel, '', titles.length ? 'Choose a template…' : 'No templates found, use Browse');
      var groups = {};
      titles.forEach(function (t) { (groups[t.group] = groups[t.group] || []).push(t); });
      Object.keys(groups).sort().forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g;
        groups[g].sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (t) { addOption(og, t.path, t.name); });
        sel.appendChild(og);
      });
      var want = saved['tx-template'];
      if (want && !sel.querySelector('option[value="' + CSS.escape(want) + '"]')) addOption(sel, want, want.split(/[\\/]/).pop().replace(/\.mogrt$/i, ''));
      if (want) sel.value = want;
      else {
        var def = titles.filter(function (t) { return /^(Bold|Basic Title|Title)/i.test(t.name); })[0] || titles[0];
        if (def) sel.value = def.path;
      }
    }).catch(function (e) { log('Title templates: ' + e.message, 'warn'); });

    action('tx-browse', function () {
      return tk('pickMogrt').then(function (p) {
        if (!p) return;
        var sel = $('tx-template');
        if (!sel.querySelector('option[value="' + CSS.escape(p) + '"]')) addOption(sel, p, p.split(/[\\/]/).pop().replace(/\.mogrt$/i, ''));
        sel.value = p;
        saveSettings();
      });
    });
    action('tx-add', function () {
      return tk('addText', {
        text: $('tx-text').value, mode: $('tx-mode').value, beatsPer: num('tx-per', 1), seconds: num('tx-seconds', 2),
        anim: $('tx-anim').value, trackIndex: num('tx-track', 1), mogrtPath: $('tx-template').value, uppercase: $('tx-upper').checked
      }).then(function (r) { reportNotes(r); log('Added ' + r.placed + ' text clip(s).', 'ok'); });
    });
    action('tx-animate', function () {
      if (!$('tx-anim').value) throw new Error('Pick an animation first.');
      return tk('animateSelected', { anim: $('tx-anim').value }).then(function (r) { reportNotes(r); log('Animated ' + r.clips + ' clip(s).', 'ok'); });
    });
  }

  // ------------------------------------------------------------------ color

  function swatch(look) {
    var v = look.lumetri, temp = Number(v.Temperature || 0), tint = Number(v.Tint || 0);
    var sat = v.Saturation === undefined ? 100 : Number(v.Saturation), exp = Number(v.Exposure || 0);
    var hue = temp >= 0 ? 30 - tint * 0.5 : 210 + tint * 0.5;
    var s = Math.max(0, Math.min(100, (Math.abs(temp) + Math.abs(tint)) * 1.4 + (sat - 100) * 0.4));
    var l1 = 22 + exp * 10, l2 = 58 + exp * 10;
    return 'linear-gradient(90deg, hsl(' + hue + ',' + s + '%,' + l1 + '%), hsl(' + (hue + 180) + ',' + s * 0.6 + '%,' + l2 + '%))';
  }

  function renderLooks(feed, status, savedId) {
    state.feeds.looks = feed;
    $('cc-feedInfo').textContent = feed.items.length + ' looks · ' + status;
    var box = $('cc-looks');
    box.innerHTML = '';
    var want = savedId || (state.look && state.look.id);
    feed.items.forEach(function (look) {
      var b = document.createElement('button');
      b.className = 'card';
      var sw = document.createElement('div');
      sw.className = 'swatch';
      sw.style.background = swatch(look);
      var name = document.createElement('b');
      name.textContent = look.name;
      var tag = document.createElement('span');
      tag.textContent = look.tag || '';
      b.appendChild(sw); b.appendChild(name); b.appendChild(tag);
      b.addEventListener('click', function () {
        state.look = look;
        box.querySelectorAll('.card').forEach(function (c) { c.classList.toggle('on', c === b); });
        $('cc-apply').disabled = false;
        saveSettings();
      });
      if (want && look.id === want) { state.look = look; b.classList.add('on'); $('cc-apply').disabled = false; }
      box.appendChild(b);
    });
  }

  function initColor(saved) {
    var render = function (feed, status) { renderLooks(feed, status, saved.look); };
    loadFeed('looks', render);
    setInterval(function () { loadFeed('looks', render); }, lib.FEED_MAX_AGE_MS);
    $('cc-refresh').addEventListener('click', function () { loadFeed('looks', render, true); });
    $('cc-intensity').addEventListener('input', function () { $('cc-intLabel').textContent = $('cc-intensity').value + '%'; });
    $('cc-intLabel').textContent = $('cc-intensity').value + '%';
    action('cc-apply', function () {
      if (!state.look) throw new Error('Pick a look first.');
      return tk('applyLook', {
        look: state.look, intensity: num('cc-intensity', 100), target: $('cc-target').value, trackIndex: num('cc-track', 0)
      }).then(function (r) {
        reportNotes(r);
        if (r.missing.length) log('This Premiere version has no Lumetri control named: ' + r.missing.join(', '), 'warn');
        log('“' + state.look.name + '” applied to ' + r.clips + ' clip(s).', 'ok');
      });
    });
    action('cc-flicker', function () { return applyFx('flicker', 'selected'); });
  }

  // ------------------------------------------------------------- scenepacks

  function importPrepared(prep) {
    if (!prep.videos.length) throw new Error(prep.pack + ' has no video files.');
    return host('SuiteImport', 'importFiles', { paths: prep.videos, pack: prep.pack }).then(function (r) {
      log('Imported ' + r.imported + ' clip(s) into Scenepacks › ' + prep.pack + '.', 'ok');
    });
  }

  function startWatcher() {
    stopWatcher();
    if (!io) { log('Auto-import needs Premiere 2022 or newer (Node is off).', 'error'); $('sp-auto').checked = false; return; }
    var dir = $('sp-dir').value;
    try {
      state.watcher = io.watch(dir, function (file) {
        log('New download: ' + file.split(/[\\/]/).pop());
        io.prepare(file).then(importPrepared).catch(function (e) { log(e.message, 'error'); });
      }, function (e) { log('Watcher stopped: ' + e.message, 'error'); });
      log('Watching ' + dir + ' for scenepacks.', 'ok');
    } catch (e) {
      $('sp-auto').checked = false;
      log(e.message, 'error');
    }
  }

  function stopWatcher() {
    if (state.watcher) { state.watcher.close(); state.watcher = null; }
  }

  function initPacks() {
    if (io && !$('sp-dir').value) $('sp-dir').value = io.defaultDownloads();
    loadFeed('sites', function (feed) {
      state.feeds.sites = feed;
      var sel = $('sp-site'), keep = sel.value || (loadSettings()['sp-site'] || '');
      sel.innerHTML = '';
      feed.items.forEach(function (s, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = s.name;
        sel.appendChild(o);
      });
      if (keep && Number(keep) < feed.items.length) sel.value = keep;
    });
    function site() { return state.feeds.sites && state.feeds.sites.items[Number($('sp-site').value) || 0]; }
    $('sp-search').addEventListener('click', function () {
      var s = site(), q = $('sp-query').value.trim();
      if (!s) return log('Site list is still loading.', 'warn');
      openUrl(q ? lib.searchUrl(s, q) : s.home);
    });
    $('sp-query').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('sp-search').click(); });
    $('sp-home').addEventListener('click', function () { var s = site(); if (s) openUrl(s.home); });
    $('sp-auto').addEventListener('change', function () { if ($('sp-auto').checked) startWatcher(); else { stopWatcher(); log('Auto-import off.'); } saveSettings(); });
    $('sp-dir').addEventListener('change', function () { saveSettings(); if ($('sp-auto').checked) startWatcher(); });
    action('sp-dirPick', function () {
      return host('ShotExporter', 'pickFolder').then(function (p) {
        if (!p) return;
        $('sp-dir').value = p;
        saveSettings();
        if ($('sp-auto').checked) startWatcher();
      });
    });
    action('sp-get', function () {
      if (!io) throw new Error('Downloading needs Premiere 2022 or newer (Node is off).');
      var url = lib.directDownloadUrl($('sp-url').value);
      // A subfolder keeps the Downloads watcher from importing the same file twice.
      var dir = $('sp-dir').value.replace(/[\\/]+$/, '') + '/Edit Suite';
      var bar = $('sp-progress');
      bar.removeAttribute('value');
      log('Downloading ' + url + ' …');
      return io.download(url, dir, function (got, total) {
        if (total) { bar.max = total; bar.value = got; }
      }).then(function (file) {
        bar.max = 1; bar.value = 1;
        log('Saved ' + file.name + '.', 'ok');
        return io.prepare(file.path);
      }).then(importPrepared).then(function () { $('sp-url').value = ''; })
        .catch(function (e) { bar.max = 1; bar.value = 0; throw e; });
    });
    if ($('sp-auto').checked) startWatcher();
  }

  // ------------------------------------------------------------------- init

  function init() {
    var saved = loadSettings();
    document.querySelectorAll('.tabs button').forEach(function (b) { b.addEventListener('click', function () { showTab(b.dataset.tab); }); });
    SAVED.forEach(function (id) { if ($(id)) $(id).addEventListener('change', saveSettings); });
    initSetup();
    initBeats();
    initCut();
    initFx(saved);
    initText(saved);
    initColor(saved);
    initPacks();
    if (!cep) log('Open this panel from Premiere Pro: Window → Extensions → Edit Suite.', 'warn');
    var tab = 'setup';
    try { tab = localStorage.getItem('editSuite.tab') || 'setup'; } catch (e) { /* default */ }
    showTab(document.getElementById('tab-' + tab) ? tab : 'setup');
    window.addEventListener('focus', refreshInfo);
    setInterval(refreshInfo, 5000);
  }

  document.addEventListener('DOMContentLoaded', init);
}());
