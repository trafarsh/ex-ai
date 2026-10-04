/* Edit Suite, Export tab (Shot Exporter): renders every V1 clip as its own file. */
(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  var EVENT_TYPE = 'com.trafarsh.shotexporter.encoder';
  var SETTINGS_KEY = 'shotExporter.settings';

  var $ = function (id) { return document.getElementById(id); };
  var state = { info: null, checked: {}, jobs: {}, busy: false };

  // ---------------------------------------------------------------- host calls

  function host(fn, args) {
    var script = 'ShotExporter.' + fn + '(' + JSON.stringify(JSON.stringify(args || {})) + ')';
    return new Promise(function (resolve, reject) {
      if (!cep) return reject(new Error('Not running inside Premiere Pro.'));
      cep.evalScript(script, function (raw) {
        var res;
        try { res = JSON.parse(raw); } catch (e) {
          return reject(new Error(raw === 'EvalScript error.' ? 'The ExtendScript part did not load. Restart Premiere.' : 'Bad reply: ' + raw));
        }
        if (res.ok) resolve(res.data); else reject(new Error(res.error));
      });
    });
  }

  // ------------------------------------------------------------------ helpers

  function log(msg, cls) {
    var line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = msg;
    $('log').appendChild(line);
    $('log').scrollTop = $('log').scrollHeight;
  }

  function pad(n, width) {
    var s = String(n);
    while (s.length < width) s = '0' + s;
    return s;
  }

  function safeName(s) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').replace(/^\s+/, '') || 'shot';
  }

  function stripExt(name) { return String(name).replace(/\.[A-Za-z0-9]{2,5}$/, ''); }

  function fileNameFor(shot, total) {
    var width = Math.max(3, String(total).length);
    var seq = state.info ? state.info.sequenceName : 'sequence';
    return safeName($('pattern').value
      .replace(/\{n\}/g, pad(shot.number, width))
      .replace(/\{seq\}/g, seq)
      .replace(/\{clip\}/g, stripExt(shot.name))
      .replace(/\{in\}/g, String(shot.startTC).replace(/[:;]/g, '-')));
  }

  function selectedMode() { return document.querySelector('input[name=mode]:checked').value; }

  function setBusy(busy) {
    state.busy = busy;
    ['scan', 'export', 'pickFolder', 'pickPreset', 'track'].forEach(function (id) { $(id).disabled = busy; });
    if (!busy) updateExportButton();
  }

  function updateExportButton() {
    var n = checkedShots().length;
    $('export').disabled = state.busy || !n || !$('folder').value || !$('preset').value;
    $('export').textContent = n ? 'Export ' + n + ' shot' + (n === 1 ? '' : 's') : 'Export shots';
  }

  function checkedShots() {
    if (!state.info) return [];
    return state.info.shots.filter(function (s) { return state.checked[s.number]; });
  }

  // ----------------------------------------------------------------- settings

  function saveSettings() {
    var s = {
      folder: $('folder').value,
      preset: $('preset').value,
      pattern: $('pattern').value,
      mode: selectedMode(),
      startBatch: $('startBatch').checked,
      overwrite: $('overwrite').checked,
      outAdjust: $('outAdjust').value,
      skipDisabled: $('skipDisabled').checked
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* not fatal */ }
  }

  function loadSettings() {
    var s = null;
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (e) { s = null; }
    if (!s) return {};
    if (s.folder) $('folder').value = s.folder;
    if (s.pattern) $('pattern').value = s.pattern;
    if (s.mode) document.querySelector('input[name=mode][value=' + s.mode + ']').checked = true;
    $('startBatch').checked = s.startBatch !== false;
    $('overwrite').checked = !!s.overwrite;
    $('outAdjust').value = s.outAdjust || 0;
    $('skipDisabled').checked = s.skipDisabled !== false;
    return s;
  }

  // ------------------------------------------------------------------ presets

  function addPresetOption(select, path, label) {
    var opt = document.createElement('option');
    opt.value = path;
    opt.textContent = label;
    select.appendChild(opt);
    return opt;
  }

  async function loadPresets(remembered) {
    var select = $('preset');
    var presets = [];
    try { presets = await host('listPresets'); } catch (e) { log('Could not list presets: ' + e.message, 'warn'); }
    select.innerHTML = '';
    addPresetOption(select, '', presets.length ? 'Choose a preset…' : 'No presets found, use Browse');

    var groups = {};
    presets.forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
    Object.keys(groups).sort(function (a, b) {
      // Put the usual delivery formats first.
      var rank = function (g) { return g === 'My presets' ? 0 : g === 'H264' ? 1 : /HEVC|H265/i.test(g) ? 2 : /QT|QuickTime/i.test(g) ? 3 : 9; };
      return rank(a) - rank(b) || a.localeCompare(b);
    }).forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].sort(function (a, b) { return a.name.localeCompare(b.name); })
        .forEach(function (p) { addPresetOption(og, p.path, p.name); });
      select.appendChild(og);
    });

    if (remembered && !select.querySelector('option[value="' + CSS.escape(remembered) + '"]')) {
      addPresetOption(select, remembered, remembered.split(/[\\/]/).pop().replace(/\.epr$/i, ''));
    }
    if (remembered) {
      select.value = remembered;
    } else {
      var def = presets.filter(function (p) { return p.group === 'H264' && /Match Source - (Adaptive )?High bitrate/i.test(p.name); })[0];
      if (def) select.value = def.path;
    }
    updateExportButton();
  }

  // -------------------------------------------------------------------- shots

  function renderShots() {
    var tbody = $('shots').querySelector('tbody');
    tbody.innerHTML = '';
    var shots = state.info ? state.info.shots : [];
    shots.forEach(function (s) {
      var tr = document.createElement('tr');
      tr.id = 'shot-' + s.number;
      if (!state.checked[s.number]) tr.className = 'off';

      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.checked[s.number];
      cb.addEventListener('change', function () {
        state.checked[s.number] = cb.checked;
        tr.classList.toggle('off', !cb.checked);
        updateCount();
      });

      var cells = [cb, String(s.number), s.startTC, s.endTC, String(s.frames), s.name];
      cells.forEach(function (c, i) {
        var td = document.createElement('td');
        if (typeof c === 'string') td.textContent = c; else td.appendChild(c);
        if (i === 5) {
          td.className = 'clip';
          td.title = s.name;
          if (s.disabled) td.insertAdjacentHTML('beforeend', '<span class="tag">disabled</span>');
          if (s.adjustment) td.insertAdjacentHTML('beforeend', '<span class="tag">adjustment</span>');
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    updateCount();
  }

  function updateCount() {
    var total = state.info ? state.info.shots.length : 0;
    var n = checkedShots().length;
    $('shotCount').textContent = total + ' shot' + (total === 1 ? '' : 's') + (total ? ' · ' + n + ' ticked' : '');
    updatePreview();
    updateExportButton();
  }

  function updatePreview() {
    var first = checkedShots()[0] || (state.info && state.info.shots[0]) ||
      { number: 1, name: 'A001_C002.mov', startTC: '00:00:00:00' };
    $('preview').textContent = fileNameFor(first, state.info ? state.info.shots.length : 1);
  }

  function setChecked(pred) {
    if (!state.info) return;
    state.info.shots.forEach(function (s) { state.checked[s.number] = pred(s); });
    renderShots();
  }

  async function scan() {
    var trackIndex = Number($('track').value) || 0;
    setBusy(true);
    try {
      var info = await host('getSequenceInfo', { trackIndex: trackIndex });
      var sameSeq = state.info && state.info.sequenceId === info.sequenceId && state.info.trackIndex === info.trackIndex;
      state.info = info;
      var skipDisabled = $('skipDisabled').checked;
      if (!sameSeq) state.checked = {};
      info.shots.forEach(function (s) {
        if (!sameSeq || state.checked[s.number] === undefined) state.checked[s.number] = !(skipDisabled && s.disabled);
      });

      var trackSel = $('track');
      trackSel.innerHTML = '';
      info.tracks.forEach(function (t) {
        var label = 'V' + (t.index + 1) + (t.name && t.name !== 'Video ' + (t.index + 1) ? ' · ' + t.name : '') + ' (' + t.clips + ')';
        addPresetOption(trackSel, String(t.index), label);
      });
      trackSel.value = String(info.trackIndex);

      $('seqInfo').textContent = '“' + info.sequenceName + '” · ' + info.fps + ' fps · cuts read from V' + (info.trackIndex + 1);
      renderShots();
      if (!info.shots.length) log('No clips on V' + (info.trackIndex + 1) + '.', 'warn');
      return info;
    } catch (e) {
      log(e.message, 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------- export

  function markRow(number, cls) {
    var tr = $('shot-' + number);
    if (!tr) return;
    tr.classList.remove('busy', 'done', 'failed');
    if (cls) tr.classList.add(cls);
    if (cls === 'busy') tr.scrollIntoView({ block: 'nearest' });
  }

  async function exportShots() {
    saveSettings();
    var wanted = checkedShots().map(function (s) { return s.number; });
    var before = state.info;

    // Read the timeline again so the ranges match what is there right now.
    var info = await scan();
    if (!info) return;
    if (info.sequenceId !== before.sequenceId || info.shots.length !== before.shots.length) {
      log('The timeline changed since it was read. Check the list and press Export again.', 'warn');
      return;
    }

    var shots = info.shots.filter(function (s) { return wanted.indexOf(s.number) !== -1; });
    var mode = selectedMode();
    var opts = {
      folder: $('folder').value,
      presetPath: $('preset').value,
      overwrite: $('overwrite').checked,
      outAdjustFrames: Number($('outAdjust').value) || 0
    };

    // Shots queued in AME don't exist on disk yet, so make names unique here.
    var used = {};
    shots.forEach(function (s) {
      var base = fileNameFor(s, info.shots.length), name = base, n = 2;
      while (used[name.toLowerCase()]) name = base + '_' + (n++);
      used[name.toLowerCase()] = true;
      s.fileName = name;
    });

    setBusy(true);
    state.jobs = {};
    info.shots.forEach(function (s) { markRow(s.number, null); });
    $('progress').max = shots.length;
    $('progress').value = 0;
    log('Exporting ' + shots.length + ' shot(s) from “' + info.sequenceName + '” via ' +
        (mode === 'ame' ? 'Media Encoder' : 'Premiere Pro') + '…');

    var okCount = 0;
    try {
      await host('beginExport', { sequenceId: info.sequenceId, mode: mode, startBatch: $('startBatch').checked });
      for (var i = 0; i < shots.length; i++) {
        var s = shots[i];
        markRow(s.number, 'busy');
        // Let the panel repaint before a blocking Premiere render.
        await new Promise(function (r) { setTimeout(r, 30); });
        try {
          var res = await host('exportShot', Object.assign({
            sequenceId: info.sequenceId,
            mode: mode,
            startTicks: s.startTicks,
            endTicks: s.endTicks,
            fileName: s.fileName
          }, opts));
          okCount++;
          if (res.jobID) state.jobs[res.jobID] = s.number;
          markRow(s.number, mode === 'ame' ? null : 'done');
          log('#' + s.number + ' ' + s.startTC + '–' + s.endTC + ' → ' + res.path, mode === 'ame' ? null : 'ok');
        } catch (e) {
          markRow(s.number, 'failed');
          log('#' + s.number + ' failed: ' + e.message, 'error');
        }
        $('progress').value = i + 1;
      }
    } catch (e) {
      log(e.message, 'error');
    } finally {
      try {
        var end = await host('endExport', { mode: mode, startBatch: $('startBatch').checked });
        if (!end.restored) log('Could not put your sequence in/out points back exactly; check them.', 'warn');
      } catch (e) { log('Cleanup: ' + e.message, 'warn'); }
      setBusy(false);
    }

    if (mode === 'ame') {
      log(okCount + ' shot(s) queued in Media Encoder' + ($('startBatch').checked ? '; rendering starts there.' : '. Press the green Start button in AME.'), 'ok');
      $('progress').value = 0;
    } else {
      log('Done: ' + okCount + ' of ' + shots.length + ' shot(s) rendered.', okCount === shots.length ? 'ok' : 'warn');
    }
  }

  function onEncoderEvent(ev) {
    var d;
    try { d = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
    var number = state.jobs[d.jobID];
    if (number === undefined) return;
    if (d.type === 'progress') markRow(number, 'busy');
    else if (d.type === 'complete') { markRow(number, 'done'); log('#' + number + ' rendered: ' + d.path, 'ok'); }
    else if (d.type === 'error') { markRow(number, 'failed'); log('#' + number + ' AME error: ' + d.message, 'error'); }
    else if (d.type === 'canceled') { markRow(number, 'failed'); log('#' + number + ' canceled in AME.', 'warn'); }
  }

  // --------------------------------------------------------------------- init

  function init() {
    var s = loadSettings();

    $('scan').addEventListener('click', scan);
    $('track').addEventListener('change', scan);
    $('export').addEventListener('click', exportShots);
    $('selAll').addEventListener('click', function () { setChecked(function () { return true; }); });
    $('selNone').addEventListener('click', function () { setChecked(function () { return false; }); });
    $('selTimeline').addEventListener('click', async function () {
      var info = await scan(); // selection state is read at scan time
      if (!info) return;
      var any = info.shots.some(function (x) { return x.selected; });
      if (!any) { log('Nothing is selected on V' + (info.trackIndex + 1) + ' in the Timeline.', 'warn'); return; }
      setChecked(function (x) { return x.selected; });
    });

    $('pickFolder').addEventListener('click', async function () {
      try {
        var path = await host('pickFolder');
        if (path) { $('folder').value = path; saveSettings(); updateExportButton(); }
      } catch (e) { log(e.message, 'error'); }
    });
    $('pickPreset').addEventListener('click', async function () {
      try {
        var path = await host('pickPreset');
        if (!path) return;
        var sel = $('preset');
        if (!sel.querySelector('option[value="' + CSS.escape(path) + '"]')) {
          addPresetOption(sel, path, path.split(/[\\/]/).pop().replace(/\.epr$/i, ''));
        }
        sel.value = path;
        saveSettings();
        updateExportButton();
      } catch (e) { log(e.message, 'error'); }
    });

    ['folder', 'preset', 'pattern', 'startBatch', 'overwrite', 'outAdjust', 'skipDisabled'].forEach(function (id) {
      $(id).addEventListener('change', function () { saveSettings(); updateExportButton(); });
    });
    document.querySelectorAll('input[name=mode]').forEach(function (r) { r.addEventListener('change', saveSettings); });
    $('pattern').addEventListener('input', updatePreview);
    $('folder').addEventListener('input', updateExportButton);

    if (cep) {
      cep.addEventListener(EVENT_TYPE, onEncoderEvent);
      // Read the timeline and presets the first time the Export tab is opened.
      var started = false;
      window.ExportTab = {
        activate: function () {
          if (started) return;
          started = true;
          loadPresets(s.preset);
          scan();
        }
      };
    }
    updatePreview();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
