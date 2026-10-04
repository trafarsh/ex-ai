/*
 * Shot Exporter, ExtendScript side (runs inside Premiere Pro).
 *
 * Reads the clips that already sit on a video track (V1 by default) and renders
 * each clip's timeline range as its own file. The cut points come straight from
 * the timeline: clip.start and clip.end, in ticks. No frames are analysed.
 *
 * ExtendScript is ES3: no JSON, no Array.prototype.forEach/indexOf, no String.trim.
 * Every public function takes one JSON string and returns one JSON string:
 *   { "ok": true, "data": ... }  or  { "ok": false, "error": "..." }
 */

var ShotExporter = (function () {
    var TICKS_PER_SECOND = 254016000000;
    var NOT_SET = -400000; // what getInPoint()/getOutPoint() return when no mark is set
    var WORK_AREA_IN_TO_OUT = 1;
    var EVENT_TYPE = 'com.trafarsh.shotexporter.encoder';

    var saved = null;      // the sequence's own in/out marks while an export runs
    var plugPlug = null;   // lets ExtendScript send events to the panel
    var autoStartBatch = false;

    // ---------------------------------------------------------------- helpers

    function quote(s) {
        s = String(s);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i);
            var code = s.charCodeAt(i);
            if (c === '"') out += '\\"';
            else if (c === '\\') out += '\\\\';
            else if (c === '\n') out += '\\n';
            else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t';
            else if (code < 32) out += '\\u' + ('0000' + code.toString(16)).slice(-4);
            else out += c;
        }
        return out + '"';
    }

    function toJSON(v) {
        if (v === null || v === undefined) return 'null';
        var t = typeof v;
        if (t === 'number') return isFinite(v) ? String(v) : 'null';
        if (t === 'boolean') return v ? 'true' : 'false';
        if (t === 'string') return quote(v);
        var parts = [];
        if (Object.prototype.toString.call(v) === '[object Array]') {
            for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return '[' + parts.join(',') + ']';
        }
        for (var k in v) {
            if (v.hasOwnProperty(k) && typeof v[k] !== 'function') parts.push(quote(k) + ':' + toJSON(v[k]));
        }
        return '{' + parts.join(',') + '}';
    }

    function ok(data) { return toJSON({ ok: true, data: data }); }
    function fail(msg) { return toJSON({ ok: false, error: String(msg) }); }

    function parseArgs(json) {
        if (!json) return {};
        return eval('(' + json + ')'); // the panel builds this string with JSON.stringify
    }

    function guard(fn) {
        return function (json) {
            try {
                return fn(parseArgs(json));
            } catch (e) {
                return fail((e && e.message ? e.message : e) + (e && e.line ? ' (line ' + e.line + ')' : ''));
            }
        };
    }

    function timeFromTicks(ticks) {
        var t = new Time();
        t.ticks = String(ticks);
        return t;
    }

    function findSequence(id) {
        if (!app.project) return null;
        if (!id) return app.project.activeSequence;
        var seqs = app.project.sequences;
        for (var i = 0; i < seqs.numSequences; i++) {
            if (seqs[i].sequenceID === id) return seqs[i];
        }
        return null;
    }

    function timeFormatter(seq) {
        var rate = null;
        try { rate = seq.getSettings().videoFrameRate; } catch (e) { rate = null; }
        return function (time) {
            try {
                if (rate) return time.getFormatted(rate, seq.videoDisplayFormat);
            } catch (e) { /* fall through */ }
            return (Math.round(time.seconds * 1000) / 1000) + 's';
        };
    }

    function setMarks(seq, inTicks, outTicks) {
        // Widen the out point first so the new in point can never land after the old out point.
        seq.setOutPoint(timeFromTicks(seq.end));
        seq.setInPoint(timeFromTicks(inTicks));
        seq.setOutPoint(timeFromTicks(outTicks));
        if (String(seq.getInPointAsTime().ticks) === String(inTicks) &&
            String(seq.getOutPointAsTime().ticks) === String(outTicks)) {
            return true;
        }
        // Older builds only take seconds.
        seq.setOutPoint(Number(seq.end) / TICKS_PER_SECOND);
        seq.setInPoint(Number(inTicks) / TICKS_PER_SECOND);
        seq.setOutPoint(Number(outTicks) / TICKS_PER_SECOND);
        return String(seq.getInPointAsTime().ticks) === String(inTicks) &&
               String(seq.getOutPointAsTime().ticks) === String(outTicks);
    }

    function ensureFolder(path) {
        var f = new Folder(path);
        if (!f.exists && !f.create()) throw new Error('Cannot create output folder: ' + path);
        return f;
    }

    function uniqueFile(folder, base, ext, overwrite) {
        var f = new File(folder.fsName + '/' + base + '.' + ext);
        if (overwrite) {
            if (f.exists && !f.remove()) throw new Error('Cannot overwrite ' + f.fsName + ' (is it open somewhere?)');
            return f;
        }
        var n = 2;
        while (f.exists) {
            f = new File(folder.fsName + '/' + base + '_v' + n + '.' + ext);
            n++;
        }
        return f;
    }

    function sendEvent(payload) {
        try {
            if (!plugPlug) plugPlug = new ExternalObject('lib:PlugPlugExternalObject');
            var ev = new CSXSEvent();
            ev.type = EVENT_TYPE;
            ev.data = toJSON(payload);
            ev.dispatch();
        } catch (e) { /* the panel just won't see live AME progress */ }
    }

    function listEprFiles(folder, depth, out) {
        if (!folder.exists || depth < 0) return;
        var items = folder.getFiles();
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it instanceof Folder) listEprFiles(it, depth - 1, out);
            else if (/\.epr$/i.test(it.name)) out.push(it);
        }
    }

    // System preset folders are named after the exporter's four-char code in hex,
    // e.g. 4E49434B_48323634 -> "H264".
    function exporterLabel(folderName) {
        var m = /^[0-9A-F]{8}_([0-9A-F]{8})$/i.exec(folderName);
        if (!m) return folderName;
        var s = '';
        for (var i = 0; i < 8; i += 2) s += String.fromCharCode(parseInt(m[1].substr(i, 2), 16));
        return s.replace(/\s+$/, '');
    }

    // ------------------------------------------------------------- public API

    var api = {};

    /** Reads every clip on the chosen video track of the active sequence. */
    api.getSequenceInfo = guard(function (args) {
        if (!app.project) return fail('No project is open.');
        var seq = app.project.activeSequence;
        if (!seq) return fail('No active sequence. Open the movie sequence in the Timeline panel first.');

        var trackIndex = args.trackIndex || 0;
        var numTracks = seq.videoTracks.numTracks;
        if (trackIndex >= numTracks) return fail('The sequence has only ' + numTracks + ' video track(s).');

        var track = seq.videoTracks[trackIndex];
        var clips = track.clips;
        var tpf = Number(seq.timebase);
        var fmt = timeFormatter(seq);
        var shots = [];

        for (var i = 0; i < clips.numItems; i++) {
            var c = clips[i];
            if (!c) continue;
            var startTicks = String(c.start.ticks);
            var endTicks = String(c.end.ticks);
            var adjustment = false;
            try { adjustment = !!c.isAdjustmentLayer(); } catch (e1) { adjustment = false; }
            var selected = false;
            try { selected = !!c.isSelected(); } catch (e2) { selected = false; }
            shots.push({
                number: shots.length + 1,
                name: c.name,
                startTicks: startTicks,
                endTicks: endTicks,
                startTC: fmt(c.start),
                endTC: fmt(c.end),
                frames: Math.round((Number(endTicks) - Number(startTicks)) / tpf),
                seconds: (Number(endTicks) - Number(startTicks)) / TICKS_PER_SECOND,
                selected: selected,
                disabled: c.disabled === true,
                adjustment: adjustment
            });
        }

        var tracks = [];
        for (var t = 0; t < numTracks; t++) tracks.push({ index: t, name: seq.videoTracks[t].name, clips: seq.videoTracks[t].clips.numItems });

        return ok({
            sequenceId: seq.sequenceID,
            sequenceName: seq.name,
            trackIndex: trackIndex,
            tracks: tracks,
            fps: Math.round(TICKS_PER_SECOND / tpf * 1000) / 1000,
            shots: shots
        });
    });

    api.pickFolder = guard(function () {
        var f = Folder.selectDialog('Choose where to save the shots');
        return ok(f ? f.fsName : '');
    });

    api.pickPreset = guard(function () {
        var filter = (Folder.fs === 'Windows')
            ? 'Export presets:*.epr'
            : function (f) { return (f instanceof Folder) || /\.epr$/i.test(f.name); };
        var f = File.openDialog('Choose an export preset (.epr)', filter, false);
        return ok(f ? f.fsName : '');
    });

    /** Finds Premiere's built-in export presets plus the user's own AME presets. */
    api.listPresets = guard(function () {
        var found = [];
        var app_ = '';
        try { app_ = Folder.appPackage.fsName; } catch (e) { app_ = ''; }
        var roots = [
            { path: app_ + '/Contents/MediaIO/systempresets', user: false },  // macOS .app bundle
            { path: app_ + '/MediaIO/systempresets', user: false },           // Windows install folder
            { path: Folder.myDocuments.fsName + '/Adobe/Adobe Media Encoder', user: true }
        ];
        for (var r = 0; r < roots.length; r++) {
            var files = [];
            listEprFiles(new Folder(roots[r].path), 5, files);
            for (var i = 0; i < files.length; i++) {
                var name = files[i].displayName.replace(/\.epr$/i, '');
                var group = roots[r].user ? 'My presets' : exporterLabel(files[i].parent.displayName);
                found.push({ group: group, name: name, path: files[i].fsName });
            }
        }
        return ok(found);
    });

    /** Remembers the sequence's in/out marks and gets the renderer ready. */
    api.beginExport = guard(function (args) {
        var seq = findSequence(args.sequenceId);
        if (!seq) return fail('The scanned sequence is no longer in the project. Scan again.');
        if (app.project.activeSequence && app.project.activeSequence.sequenceID !== seq.sequenceID) {
            app.project.activeSequence = seq;
        }

        saved = {
            sequenceId: seq.sequenceID,
            inTicks: String(seq.getInPointAsTime().ticks),
            outTicks: String(seq.getOutPointAsTime().ticks),
            inSet: Number(seq.getInPoint()) !== NOT_SET,
            outSet: Number(seq.getOutPoint()) !== NOT_SET
        };

        if (args.mode === 'ame') {
            var status = BridgeTalk.getStatus('ame');
            if (status === 'ISNOTINSTALLED') {
                return fail('Adobe Media Encoder is not installed. Switch the renderer to "Premiere Pro".');
            }
            if (status === 'ISNOTRUNNING') app.encoder.launchEncoder();
            autoStartBatch = !!args.startBatch;
            app.encoder.bind('onEncoderJobQueued', api.onJobQueued);
            app.encoder.bind('onEncoderJobProgress', api.onJobProgress);
            app.encoder.bind('onEncoderJobComplete', api.onJobComplete);
            app.encoder.bind('onEncoderJobError', api.onJobError);
            app.encoder.bind('onEncoderJobCanceled', api.onJobCanceled);
            app.encoder.setSidecarXMPEnabled(0);
        }
        return ok(saved);
    });

    /**
     * Renders one timeline range: in = clip start, out = clip end.
     * args: sequenceId, startTicks, endTicks, folder, fileName, presetPath,
     *       mode ('ame' | 'direct'), overwrite, outAdjustFrames
     */
    api.exportShot = guard(function (args) {
        var seq = findSequence(args.sequenceId);
        if (!seq) return fail('Sequence not found.');

        var presetFile = new File(args.presetPath);
        if (!presetFile.exists) return fail('Preset not found: ' + args.presetPath);

        var tpf = Number(seq.timebase);
        var inTicks = String(args.startTicks);
        var outTicks = String(Number(args.endTicks) + (Number(args.outAdjustFrames) || 0) * tpf);
        if (Number(outTicks) <= Number(inTicks)) return fail('Shot has no duration.');

        if (!setMarks(seq, inTicks, outTicks)) {
            return fail('Premiere would not set the in/out points exactly at ' + inTicks + '-' + outTicks +
                        ' ticks (got ' + seq.getInPointAsTime().ticks + '-' + seq.getOutPointAsTime().ticks + ').');
        }

        var ext = seq.getExportFileExtension(presetFile.fsName);
        if (!ext) return fail('Premiere could not read the preset: ' + presetFile.fsName);

        var folder = ensureFolder(args.folder);
        var outFile = uniqueFile(folder, args.fileName, ext, !!args.overwrite);

        if (args.mode === 'ame') {
            var jobID = app.encoder.encodeSequence(seq, outFile.fsName, presetFile.fsName, WORK_AREA_IN_TO_OUT, 1);
            if (!jobID || String(jobID) === '0') return fail('Adobe Media Encoder refused the job.');
            return ok({ path: outFile.fsName, jobID: String(jobID) });
        }

        var result = seq.exportAsMediaDirect(outFile.fsName, presetFile.fsName, WORK_AREA_IN_TO_OUT);
        if (result === false || !new File(outFile.fsName).exists) {
            return fail('Premiere did not write ' + outFile.fsName + (result && result !== true ? ' (' + result + ')' : ''));
        }
        return ok({ path: outFile.fsName });
    });

    /** Puts the sequence's in/out marks back and, for AME, starts the queue. */
    api.endExport = guard(function (args) {
        var restored = false;
        if (saved) {
            var seq = findSequence(saved.sequenceId);
            if (seq) {
                try {
                    if (saved.inSet || saved.outSet) {
                        restored = setMarks(seq, saved.inSet ? saved.inTicks : '0', saved.outSet ? saved.outTicks : seq.end);
                    } else {
                        // There were no marks before; mark the whole sequence, which renders the same as none.
                        restored = setMarks(seq, '0', seq.end);
                    }
                } catch (e) { restored = false; }
            }
            saved = null;
        }
        if (args.mode === 'ame' && args.startBatch) app.encoder.startBatch();
        return ok({ restored: restored });
    });

    // AME callbacks. These run whenever AME reports back, after the panel's calls have returned.
    api.onJobQueued = function (jobID) {
        sendEvent({ type: 'queued', jobID: String(jobID) });
        if (autoStartBatch) app.encoder.startBatch();
    };
    api.onJobProgress = function (jobID, progress) { sendEvent({ type: 'progress', jobID: String(jobID), progress: progress }); };
    api.onJobComplete = function (jobID, outputPath) { sendEvent({ type: 'complete', jobID: String(jobID), path: String(outputPath) }); };
    api.onJobError = function (jobID, message) { sendEvent({ type: 'error', jobID: String(jobID), message: String(message) }); };
    api.onJobCanceled = function (jobID) { sendEvent({ type: 'canceled', jobID: String(jobID) }); };

    api._toJSON = toJSON; // used by the tests
    return api;
}());
