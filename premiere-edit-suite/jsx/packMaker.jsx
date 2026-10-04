/*
 * Edit Suite, Make pack: the Premiere side of building a scenepack from a movie.
 *   1. put the movie in its own sequence
 *   2. cut it into shots with Premiere's Scene Edit Detection
 *   3. export still frames of each shot for the panel's face grouping
 *   4. name V1 clips after their characters
 * Exporting the chosen shots reuses ShotExporter (jsx/shotExporter.jsx).
 * ES3; every public function takes and returns a JSON string.
 */
var PackMaker = (function () {
    var TPS = 254016000000;

    function quote(s) {
        s = String(s);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === '\\') out += '\\\\';
            else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
            else out += c;
        }
        return out + '"';
    }

    function toJSON(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v, parts = [], k;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return quote(v);
        if (Object.prototype.toString.call(v) === '[object Array]') {
            for (k = 0; k < v.length; k++) parts.push(toJSON(v[k]));
            return '[' + parts.join(',') + ']';
        }
        for (k in v) if (v.hasOwnProperty(k) && typeof v[k] !== 'function') parts.push(quote(k) + ':' + toJSON(v[k]));
        return '{' + parts.join(',') + '}';
    }

    function guard(fn) {
        return function (json) {
            try {
                return toJSON({ ok: true, data: fn(json ? eval('(' + json + ')') : {}) });
            } catch (e) {
                return toJSON({ ok: false, error: String(e && e.message ? e.message : e) });
            }
        };
    }

    function T(ticks) { var t = new Time(); t.ticks = String(Math.round(Number(ticks))); return t; }

    function activeSeq() {
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) throw new Error('Open the movie sequence in the Timeline first.');
        return seq;
    }

    function timecode(seq, ticks) {
        var f = Number(seq.timebase), frame = Math.floor(Number(ticks) / f + 0.000001);
        try {
            var s = T(frame * f).getFormatted(T(f), seq.getSettings().videoDisplayFormat);
            if (s) return s;
        } catch (e) { /* fall back to non-drop */ }
        var fps = Math.round(TPS / f);
        function p(n) { return n < 10 ? '0' + n : String(n); }
        return p(Math.floor(frame / (fps * 3600))) + ':' + p(Math.floor(frame / (fps * 60)) % 60) + ':' + p(Math.floor(frame / fps) % 60) + ':' + p(frame % fps);
    }

    function info(seq) {
        var v1 = seq.videoTracks[0].clips, s = seq.getSettings();
        return { sequenceId: seq.sequenceID, name: seq.name, shots: v1.numItems, width: s.videoFrameWidth, height: s.videoFrameHeight, frameTicks: Number(seq.timebase) };
    }

    var api = {};

    /** Puts the clip selected in the Project panel into a new sequence, or uses the open one. */
    api.prepare = guard(function (args) {
        if (!app.project) throw new Error('Open a project first.');
        if (args.useActive) return info(activeSeq());
        var picked = app.getCurrentProjectViewSelection(), item = null;
        for (var i = 0; picked && i < picked.length; i++) if (picked[i] && picked[i].type === 1) { item = picked[i]; break; }
        if (!item) throw new Error('Select the movie in the Project panel first.');
        var seq = app.project.createNewSequenceFromClips('Scenepack - ' + item.name.replace(/\.[^.]+$/, ''), [item], app.project.rootItem);
        if (!seq) throw new Error('Premiere did not create the sequence.');
        try { app.project.openSequence(seq.sequenceID); } catch (e) { /* usually opens by itself */ }
        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== seq.sequenceID) app.project.activeSequence = seq;
        return info(seq);
    });

    api.info = guard(function () { return info(activeSeq()); });

    /** Premiere's Scene Edit Detection on every clip of V1, cutting it into shots. */
    api.findShots = guard(function (args) {
        var seq = activeSeq(), v1 = seq.videoTracks[0].clips, i, t;
        if (!v1.numItems) throw new Error('V1 is empty. Put the movie on V1 first.');
        var before = v1.numItems;
        for (t = 0; t < seq.videoTracks.numTracks; t++) {
            var clips = seq.videoTracks[t].clips;
            for (i = 0; i < clips.numItems; i++) clips[i].setSelected(t === 0, true);
        }
        for (t = 0; t < seq.audioTracks.numTracks; t++) {
            var aclips = seq.audioTracks[t].clips;
            for (i = 0; i < aclips.numItems; i++) aclips[i].setSelected(false, true);
        }
        var sens = { low: 'LowSensitivity', medium: 'MediumSensitivity', high: 'HighSensitivity' }[args.sensitivity] || 'MediumSensitivity';
        var okRun = seq.performSceneEditDetectionOnSelection('ApplyCuts', true, sens);
        var after = seq.videoTracks[0].clips.numItems;
        if (!okRun && after === before) throw new Error('Premiere did not run Scene Edit Detection. Select the movie clip on V1 and try again.');
        return { before: before, shots: after };
    });

    /** Exports one JPEG per request: [{ticks, name}] into dir. Returns the files that were written. */
    api.exportFrames = guard(function (args) {
        var seq = activeSeq();
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq || typeof qeSeq.exportFrameJPEG !== 'function') throw new Error('This Premiere version cannot export frames from a script.');
        var dir = new Folder(args.dir);
        if (!dir.exists) dir.create();
        var out = [];
        for (var i = 0; i < args.items.length; i++) {
            var it = args.items[i];
            // QE appends ".jpg" itself and cuts the name at the first dot, so names are dot-free.
            var base = dir.fsName + '/' + String(it.name).replace(/\./g, '_');
            var f = new File(base + '.jpg');
            if (f.exists) { out.push({ name: it.name, path: f.fsName }); continue; }
            var tc = timecode(seq, it.ticks), err = '';
            try { qeSeq.exportFrameJPEG(tc, base); } catch (e) { err = String(e && e.message ? e.message : e); }
            f = new File(base + '.jpg');
            out.push({ name: it.name, path: f.exists ? f.fsName : '', error: f.exists ? '' : (err || 'Premiere wrote no file at ' + tc) });
        }
        return out;
    });

    /** Renames V1 clips after their characters: [{startTicks, label}]. */
    api.nameClips = guard(function (args) {
        var seq = activeSeq(), clips = seq.videoTracks[0].clips, byStart = {}, n = 0;
        for (var i = 0; i < args.items.length; i++) byStart[String(args.items[i].startTicks)] = args.items[i].label;
        for (var c = 0; c < clips.numItems; c++) {
            var label = byStart[String(clips[c].start.ticks)];
            if (label) { clips[c].name = label; n++; }
        }
        return { named: n };
    });

    return api;
}());
