/*
 * TikTok Editor, ExtendScript side (runs inside Premiere Pro 2025/2026).
 *
 * Beat markers from BPM, beat-synced effects (zoom punch, shake, flash, glitch,
 * velocity punch, CC flicker), cutting to the beat, animated text from Premiere's
 * own title templates, Lumetri looks and 9:16 setup.
 *
 * Effects are keyframes on the clip: Motion/Opacity, plus Transform, Lumetri Color,
 * Directional Blur and Basic 3D added through Premiere's QE DOM. Clip speed and
 * time remapping cannot be set from any Premiere script, so there is no real
 * speed ramp here; "velocity punch" is the closest look.
 *
 * ExtendScript is ES3. Every public function takes one JSON string and returns
 *   { "ok": true, "data": ... }  or  { "ok": false, "error": "..." }
 */

var TikTokEditor = (function () {
    var TPS = 254016000000;            // ticks per second
    var INTERP_LINEAR = 0, INTERP_HOLD = 4, INTERP_BEZIER = 5;
    var BEAT_NAME = /^Beat \d+$/;

    // ---------------------------------------------------------------- JSON

    function quote(s) {
        s = String(s);
        var out = '"';
        for (var i = 0; i < s.length; i++) {
            var c = s.charAt(i), code = s.charCodeAt(i);
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

    function guard(fn) {
        return function (json) {
            try {
                return fn(json ? eval('(' + json + ')') : {}); // built by the panel with JSON.stringify
            } catch (e) {
                return fail((e && e.message ? e.message : e) + (e && e.line ? ' (line ' + e.line + ')' : ''));
            }
        };
    }

    // ---------------------------------------------------------------- time

    function T(ticks) {
        var t = new Time();
        t.ticks = String(Math.round(Number(ticks)));
        return t;
    }

    function activeSeq() {
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) throw new Error('Open your edit sequence in the Timeline first.');
        return seq;
    }

    function context(seq) {
        var w = 1080, h = 1920;
        try { var s = seq.getSettings(); w = s.videoFrameWidth; h = s.videoFrameHeight; } catch (e) { /* defaults */ }
        return { seq: seq, f: Number(seq.timebase), w: w, h: h, notes: [] };
    }

    function snap(ctx, ticks) { return Math.round(ticks / ctx.f) * ctx.f; }

    function ticksToTimecode(ctx, ticks) {
        // QE razor() wants a timecode string; a tick count is silently ignored.
        var fps = Math.round(TPS / ctx.f) || 30;
        var fr = Math.round(ticks / ctx.f);
        function p(n) { return n < 10 ? '0' + n : String(n); }
        return p(Math.floor(fr / (fps * 3600))) + ':' + p(Math.floor((fr % (fps * 3600)) / (fps * 60))) + ':' +
               p(Math.floor((fr % (fps * 60)) / fps)) + ':' + p(fr % fps);
    }

    // Small seeded random so shakes look organic but repeat the same way each run.
    function rng(seed) {
        var s = (seed % 2147483647 + 2147483647) % 2147483647 || 1;
        return function () { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    // ---------------------------------------------------------------- beats

    function beatList(ctx, onlyBeatMarkers) {
        var out = [], markers = ctx.seq.markers;
        if (!markers || !markers.numMarkers) return out;
        var m = markers.getFirstMarker();
        for (var i = 0; i < markers.numMarkers && m; i++) {
            if (!onlyBeatMarkers || BEAT_NAME.test(m.name)) out.push(snap(ctx, Number(m.start.ticks)));
            m = markers.getNextMarker(m);
        }
        out.sort(function (a, b) { return a - b; });
        return out;
    }

    function pickBeats(beats, everyN, offset) {
        everyN = Math.max(1, Math.round(everyN || 1));
        offset = Math.max(0, Math.round(offset || 0));
        var out = [];
        for (var i = 0; i < beats.length; i++) if (i % everyN === offset % everyN) out.push(beats[i]);
        return out;
    }

    // ---------------------------------------------------------------- clips

    function sameClip(a, b) {
        try { if (a.nodeId && b.nodeId) return a.nodeId === b.nodeId; } catch (e) { /* older builds */ }
        return String(a.start.ticks) === String(b.start.ticks) && a.name === b.name;
    }

    /** [{clip, track}] for the selected video clips, or every clip on one video track. */
    function targetClips(ctx, target, trackIndex) {
        var seq = ctx.seq, out = [], t, i;
        if (target === 'selected') {
            var sel = seq.getSelection();
            for (var s = 0; sel && s < sel.length; s++) {
                var item = sel[s];
                if (!item || (item.mediaType && item.mediaType !== 'Video')) continue;
                for (t = 0; t < seq.videoTracks.numTracks; t++) {
                    var clips = seq.videoTracks[t].clips;
                    for (i = 0; i < clips.numItems; i++) {
                        if (sameClip(clips[i], item)) { out.push({ clip: clips[i], track: t }); t = 1e9; break; }
                    }
                }
            }
            if (!out.length) throw new Error('Select one or more clips in the Timeline first.');
        } else {
            trackIndex = trackIndex || 0;
            if (trackIndex >= seq.videoTracks.numTracks) throw new Error('V' + (trackIndex + 1) + ' does not exist.');
            var list = seq.videoTracks[trackIndex].clips;
            for (i = 0; i < list.numItems; i++) out.push({ clip: list[i], track: trackIndex });
            if (!out.length) throw new Error('There are no clips on V' + (trackIndex + 1) + '.');
        }
        return out;
    }

    function speedOf(clip) {
        var s = 1;
        try { s = clip.getSpeed(); } catch (e) { s = 1; }
        if (!s || !isFinite(s)) s = 1;
        if (s > 10) s = s / 100; // older builds report percent
        var reversed = false;
        try { reversed = clip.isSpeedReversed() === true || clip.isSpeedReversed() === 1; } catch (e2) { reversed = false; }
        if (reversed) throw new Error('"' + clip.name + '" is reversed; keyframes on reversed clips are not supported.');
        return s;
    }

    // Keyframe times are stored in the clip's media time, not sequence time.
    function keyTime(clip, seqTicks) {
        return T(Number(clip.inPoint.ticks) + (seqTicks - Number(clip.start.ticks)) * speedOf(clip));
    }

    // ---------------------------------------------------------------- components

    function findComponent(clip, matchRe, last, filter) {
        var found = null, comps = clip.components;
        for (var i = 0; i < comps.numItems; i++) {
            var c = comps[i];
            if (matchRe.test(c.matchName) || matchRe.test(c.displayName)) {
                if (filter && !filter(c)) continue;
                found = c;
                if (!last) return c;
            }
        }
        return found;
    }

    function findProp(comp, nameRe, fallbackIndex) {
        if (!comp) return null;
        var props = comp.properties;
        for (var i = 0; i < props.numItems; i++) if (nameRe.test(props[i].displayName)) return props[i];
        if (fallbackIndex !== undefined && fallbackIndex < props.numItems) return props[fallbackIndex];
        return null;
    }

    function motion(clip) {
        var m = findComponent(clip, /^AE\.ADBE Motion$|^Motion$/);
        if (!m) throw new Error('"' + clip.name + '" has no Motion settings (is it an audio clip?).');
        return {
            comp: m,
            position: findProp(m, /^Position$/, 0),
            scale: findProp(m, /^Scale$/, 1),
            rotation: findProp(m, /^Rotation$/, 4)
        };
    }

    function opacity(clip) {
        var o = findComponent(clip, /^AE\.ADBE Opacity$|^Opacity$/);
        return o ? findProp(o, /^Opacity$/, 0) : null;
    }

    function qeClipFor(ctx, clip, trackIndex) {
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) throw new Error('Premiere did not expose the active sequence to QE.');
        var qeTrack = qeSeq.getVideoTrackAt(trackIndex);
        var wanted = Number(clip.start.ticks);
        for (var i = 0; i < qeTrack.numItems; i++) {
            var it = qeTrack.getItemAt(i);
            if (it && String(it.type) === 'Clip' && Math.abs(Number(it.start.ticks) - wanted) < 1) return it;
        }
        throw new Error('Could not find "' + clip.name + '" for adding effects.');
    }

    /** Adds a video effect through QE and returns the new component. */
    function addEffect(ctx, clip, trackIndex, effectName, matchRe) {
        var before = 0, i;
        for (i = 0; i < clip.components.numItems; i++) if (matchRe.test(clip.components[i].matchName) || matchRe.test(clip.components[i].displayName)) before++;
        var qc = qeClipFor(ctx, clip, trackIndex);
        var effect = qe.project.getVideoEffectByName(effectName);
        if (!effect) throw new Error('Premiere has no "' + effectName + '" effect.');
        qc.addVideoEffect(effect);
        var after = 0, last = null;
        for (i = 0; i < clip.components.numItems; i++) {
            var c = clip.components[i];
            if (matchRe.test(c.matchName) || matchRe.test(c.displayName)) { after++; last = c; }
        }
        if (after <= before || !last) throw new Error('Premiere did not add "' + effectName + '" to "' + clip.name + '".');
        return last;
    }

    function findOrAddEffect(ctx, clip, trackIndex, effectName, matchRe, filter) {
        return findComponent(clip, matchRe, false, filter) || addEffect(ctx, clip, trackIndex, effectName, matchRe);
    }

    var TRANSFORM_RE = /^AE\.ADBE Geometry2$|^Transform$/;
    var LUMETRI_RE = /^AE\.ADBE Lumetri$|^Lumetri Color$/;

    function transform(ctx, clip, trackIndex, shutter) {
        var c = findOrAddEffect(ctx, clip, trackIndex, 'Transform', TRANSFORM_RE);
        if (shutter) {
            var useComp = findProp(c, /Use Composition/i);
            var angle = findProp(c, /^Shutter Angle$/i);
            try { if (useComp) useComp.setValue(false, 1); } catch (e) { ctx.notes.push('Could not turn off "Use Composition\'s Shutter Angle".'); }
            try { if (angle && !angle.isTimeVarying()) angle.setValue(shutter, 1); } catch (e2) { /* keep default */ }
        }
        return {
            comp: c,
            position: findProp(c, /^Position$/),
            scale: findProp(c, /^Scale( Height)?$/),
            rotation: findProp(c, /^Rotation$/),
            skew: findProp(c, /^Skew$/)
        };
    }

    // ---------------------------------------------------------------- keyframes

    function baseValue(prop, clip, fallback) {
        try {
            if (!prop.isTimeVarying()) return prop.getValue();
            return prop.getValueAtTime(keyTime(clip, Number(clip.start.ticks)));
        } catch (e) { return fallback; }
    }

    /** keys: [{t: sequence ticks, v: value, i?: interpolation}]; keys outside the clip are skipped. */
    function setKeys(prop, clip, keys, interp) {
        if (!prop) return 0;
        var start = Number(clip.start.ticks), end = Number(clip.end.ticks), n = 0;
        if (!prop.isTimeVarying()) prop.setTimeVarying(true);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            if (key.t < start || key.t >= end) continue;
            var tm = keyTime(clip, key.t);
            prop.addKey(tm);
            prop.setValueAtKey(tm, key.v, 1);
            try { prop.setInterpolationTypeAtKey(tm, key.i !== undefined ? key.i : interp, true); } catch (e) { /* default interpolation */ }
            n++;
        }
        return n;
    }

    // Position values are usually normalized (0-1); convert a pixel offset to the prop's unit.
    function offsetPoint(ctx, base, dx, dy) {
        var normalized = Math.abs(base[0]) <= 2 && Math.abs(base[1]) <= 2;
        return normalized ? [base[0] + dx / ctx.w, base[1] + dy / ctx.h] : [base[0] + dx, base[1] + dy];
    }

    // ---------------------------------------------------------------- beat effects

    var FX = {};

    FX.zoom = function (ctx, item, beats, o) {
        var tgt = o.blur ? transform(ctx, item.clip, item.track, 180) : motion(item.clip);
        var base = Number(baseValue(tgt.scale, item.clip, 100)) || 100;
        var peak = base * (1 + (o.intensity || 20) / 100), len = (o.frames || 6) * ctx.f, keys = [];
        for (var i = 0; i < beats.length; i++) {
            keys.push({ t: beats[i] - ctx.f, v: base }, { t: beats[i], v: peak }, { t: beats[i] + len, v: base });
        }
        return setKeys(tgt.scale, item.clip, keys, INTERP_BEZIER);
    };

    FX.shake = function (ctx, item, beats, o) {
        var tgt = o.blur ? transform(ctx, item.clip, item.track, 180) : motion(item.clip);
        var basePos = baseValue(tgt.position, item.clip, [0.5, 0.5]);
        var baseRot = Number(baseValue(tgt.rotation, item.clip, 0)) || 0;
        var strength = o.strength || 40, frames = o.frames || 8, rand = rng(beats.length * 7919 + strength);
        var pos = [], rot = [];
        for (var i = 0; i < beats.length; i++) {
            var b = beats[i];
            pos.push({ t: b - ctx.f, v: basePos });
            rot.push({ t: b - ctx.f, v: baseRot });
            for (var k = 0; k < frames; k++) {
                var amp = strength * (1 - k / frames);
                pos.push({ t: b + k * ctx.f, v: offsetPoint(ctx, basePos, (rand() * 2 - 1) * amp, (rand() * 2 - 1) * amp) });
                rot.push({ t: b + k * ctx.f, v: baseRot + (rand() * 2 - 1) * amp * 0.05 });
            }
            pos.push({ t: b + frames * ctx.f, v: basePos });
            rot.push({ t: b + frames * ctx.f, v: baseRot });
        }
        return setKeys(tgt.position, item.clip, pos, INTERP_LINEAR) + setKeys(tgt.rotation, item.clip, rot, INTERP_LINEAR);
    };

    FX.flash = function (ctx, item, beats, o) {
        var lum = addEffect(ctx, item.clip, item.track, 'Lumetri Color', LUMETRI_RE);
        var exposure = findProp(lum, /^Exposure$/);
        var len = (o.frames || 4) * ctx.f, peak = o.strength || 3, keys = [];
        for (var i = 0; i < beats.length; i++) {
            keys.push({ t: beats[i] - ctx.f, v: 0 }, { t: beats[i], v: peak }, { t: beats[i] + len, v: 0 });
        }
        return setKeys(exposure, item.clip, keys, INTERP_LINEAR);
    };

    FX.flicker = function (ctx, item, beats, o) {
        var lum = addEffect(ctx, item.clip, item.track, 'Lumetri Color', LUMETRI_RE);
        var p = {
            exposure: findProp(lum, /^Exposure$/),
            contrast: findProp(lum, /^Contrast$/),
            saturation: findProp(lum, /^Saturation$/),
            temperature: findProp(lum, /^Temperature$/)
        };
        var s = (o.strength || 50) / 50, len = (o.frames || 2) * ctx.f, start = Number(item.clip.start.ticks);
        var k = { exposure: [], contrast: [], saturation: [], temperature: [] };
        function at(t, e, c, sat, temp) {
            k.exposure.push({ t: t, v: e }); k.contrast.push({ t: t, v: c });
            k.saturation.push({ t: t, v: sat }); k.temperature.push({ t: t, v: temp });
        }
        at(start, 0, 0, 100, 0);
        for (var i = 0; i < beats.length; i++) {
            at(beats[i], 0.6 * s, 40 * s, 100 + 60 * s, (i % 2 ? 35 : -35) * s);
            at(beats[i] + len, 0, 0, 100, 0);
        }
        var n = 0;
        for (var key in p) if (p.hasOwnProperty(key)) n += setKeys(p[key], item.clip, k[key], INTERP_HOLD);
        return n;
    };

    FX.glitch = function (ctx, item, beats, o) {
        var tgt = transform(ctx, item.clip, item.track, 0);
        var basePos = baseValue(tgt.position, item.clip, [0.5, 0.5]);
        var strength = o.strength || 40, frames = o.frames || 6, rand = rng(beats.length * 104729 + strength);
        var pos = [], skew = [];
        for (var i = 0; i < beats.length; i++) {
            var b = beats[i];
            pos.push({ t: b - ctx.f, v: basePos });
            skew.push({ t: b - ctx.f, v: 0 });
            for (var k = 0; k < frames; k++) {
                pos.push({ t: b + k * ctx.f, v: offsetPoint(ctx, basePos, (rand() * 2 - 1) * strength, 0) });
                skew.push({ t: b + k * ctx.f, v: (rand() * 2 - 1) * strength * 0.4 });
            }
            pos.push({ t: b + frames * ctx.f, v: basePos });
            skew.push({ t: b + frames * ctx.f, v: 0 });
        }
        var n = setKeys(tgt.position, item.clip, pos, INTERP_HOLD) + setKeys(tgt.skew, item.clip, skew, INTERP_HOLD);
        // RGB split, when the Immersive Video effects are installed.
        try {
            var ca = addEffect(ctx, item.clip, item.track, 'VR Chromatic Aberrations', /Chromatic Aberration/i);
            var red = findProp(ca, /Red/i), blue = findProp(ca, /Blue/i), rk = [], bk = [];
            for (var j = 0; j < beats.length; j++) {
                rk.push({ t: beats[j] - ctx.f, v: 0 }, { t: beats[j], v: strength / 4 }, { t: beats[j] + frames * ctx.f, v: 0 });
                bk.push({ t: beats[j] - ctx.f, v: 0 }, { t: beats[j], v: -strength / 4 }, { t: beats[j] + frames * ctx.f, v: 0 });
            }
            n += setKeys(red, item.clip, rk, INTERP_LINEAR) + setKeys(blue, item.clip, bk, INTERP_LINEAR);
        } catch (e) {
            ctx.notes.push('RGB split skipped: ' + e.message);
        }
        return n;
    };

    // The look of a speed ramp: a scale rush with motion blur and directional blur into each beat.
    FX.velocity = function (ctx, item, beats, o) {
        var tgt = transform(ctx, item.clip, item.track, 360);
        var base = Number(baseValue(tgt.scale, item.clip, 100)) || 100;
        var peak = base * (1 + (o.intensity || 20) / 100), f = ctx.f, scale = [], blurKeys = [];
        var blurLen = o.strength || 40;
        for (var i = 0; i < beats.length; i++) {
            var b = beats[i];
            scale.push({ t: b - 4 * f, v: base }, { t: b, v: peak }, { t: b + 6 * f, v: base });
            blurKeys.push({ t: b - 4 * f, v: 0 }, { t: b - f, v: blurLen }, { t: b + f, v: blurLen }, { t: b + 5 * f, v: 0 });
        }
        var n = setKeys(tgt.scale, item.clip, scale, INTERP_BEZIER);
        try {
            var db = addEffect(ctx, item.clip, item.track, 'Directional Blur', /^AE\.ADBE Motion Blur$|^Directional Blur$/);
            n += setKeys(findProp(db, /Blur Length/i), item.clip, blurKeys, INTERP_BEZIER);
        } catch (e) {
            ctx.notes.push('Directional blur skipped: ' + e.message);
        }
        return n;
    };

    // ---------------------------------------------------------------- text animations

    var TEXT = {};

    TEXT.pop = function (ctx, item) {
        var m = motion(item.clip), s = Number(item.clip.start.ticks), f = ctx.f;
        var base = Number(baseValue(m.scale, item.clip, 100)) || 100;
        return setKeys(m.scale, item.clip, [
            { t: s, v: 0 }, { t: s + 3 * f, v: base * 1.15 }, { t: s + 6 * f, v: base * 0.95 }, { t: s + 8 * f, v: base }
        ], INTERP_BEZIER);
    };

    TEXT.fade = function (ctx, item) {
        var op = opacity(item.clip), s = Number(item.clip.start.ticks), e = Number(item.clip.end.ticks), f = ctx.f;
        var keys = [{ t: s, v: 0 }, { t: s + 6 * f, v: 100 }];
        if (e - s > 20 * f) keys.push({ t: e - 6 * f, v: 100 }, { t: e - f, v: 0 });
        return setKeys(op, item.clip, keys, INTERP_LINEAR);
    };

    TEXT.slide = function (ctx, item) {
        var m = motion(item.clip), s = Number(item.clip.start.ticks), f = ctx.f;
        var base = baseValue(m.position, item.clip, [0.5, 0.5]);
        return setKeys(m.position, item.clip, [{ t: s, v: offsetPoint(ctx, base, 0, ctx.h * 0.06) }, { t: s + 7 * f, v: base }], INTERP_BEZIER) +
               setKeys(opacity(item.clip), item.clip, [{ t: s, v: 0 }, { t: s + 4 * f, v: 100 }], INTERP_LINEAR);
    };

    TEXT.shake = function (ctx, item) {
        return FX.shake(ctx, item, [Number(item.clip.start.ticks)], { strength: 18, frames: 10 });
    };

    TEXT.glitch = function (ctx, item) {
        return FX.glitch(ctx, item, [Number(item.clip.start.ticks)], { strength: 30, frames: 6 });
    };

    TEXT['3d'] = function (ctx, item) {
        var s = Number(item.clip.start.ticks), f = ctx.f;
        var b3d = addEffect(ctx, item.clip, item.track, 'Basic 3D', /^AE\.ADBE Basic 3D$|^Basic 3D$/);
        return setKeys(findProp(b3d, /^Swivel$/), item.clip, [{ t: s, v: 90 }, { t: s + 8 * f, v: 0 }], INTERP_BEZIER) +
               setKeys(findProp(b3d, /^Tilt$/), item.clip, [{ t: s, v: -25 }, { t: s + 8 * f, v: 0 }], INTERP_BEZIER) +
               setKeys(opacity(item.clip), item.clip, [{ t: s, v: 0 }, { t: s + 3 * f, v: 100 }], INTERP_LINEAR);
    };

    // ---------------------------------------------------------------- MOGRT text

    function setMogrtText(clip, text) {
        var comp = null;
        try { comp = clip.getMGTComponent(); } catch (e) { comp = null; }
        var comps = comp ? [comp] : [];
        if (!comp) for (var c = 0; c < clip.components.numItems; c++) comps.push(clip.components[c]);
        for (var ci = 0; ci < comps.length; ci++) {
            var props = comps[ci].properties;
            for (var i = 0; i < props.numItems; i++) {
                var v = null;
                try { v = props[i].getValue(); } catch (e2) { continue; }
                if (typeof v === 'string' && /"textEditValue"\s*:/.test(v)) {
                    var encoded = quote(text);
                    props[i].setValue(v.replace(/"textEditValue"\s*:\s*"(?:[^"\\]|\\.)*"/, function () { return '"textEditValue":' + encoded; }), 1);
                    return true;
                }
            }
        }
        return false;
    }

    function setClipEnd(clip, ticks) {
        try { clip.end = T(ticks); } catch (e) { clip.end = String(Math.round(ticks)); }
    }

    // ---------------------------------------------------------------- Lumetri looks

    var LOOK_DEFAULTS = {
        'Temperature': 0, 'Tint': 0, 'Exposure': 0, 'Contrast': 0, 'Highlights': 0, 'Shadows': 0,
        'Whites': 0, 'Blacks': 0, 'Saturation': 100, 'Faded Film': 0, 'Sharpen': 0, 'Vibrance': 0,
        'Vignette/Amount': 0
    };

    // "Name" matches the first property with that name; "Section/Name" the one after that
    // section's header, or the last one with that name when headers are not exposed.
    function lumetriProp(lum, key) {
        var props = lum.properties, slash = key.indexOf('/'), i;
        if (slash < 0) {
            for (i = 0; i < props.numItems; i++) if (props[i].displayName === key) return props[i];
            return null;
        }
        var section = key.substr(0, slash), name = key.substr(slash + 1), inSection = false, last = null;
        for (i = 0; i < props.numItems; i++) {
            var dn = props[i].displayName;
            if (dn === section) inSection = true;
            if (dn === name) {
                if (inSection) return props[i];
                last = props[i];
            }
        }
        return last;
    }

    function exposureNotKeyed(c) {
        var e = findProp(c, /^Exposure$/);
        try { return !e || !e.isTimeVarying(); } catch (err) { return true; }
    }

    // ---------------------------------------------------------------- presets on disk

    function listFiles(folder, re, depth, out) {
        if (!folder.exists || depth < 0) return;
        var items = folder.getFiles();
        for (var i = 0; i < items.length; i++) {
            if (items[i] instanceof Folder) listFiles(items[i], re, depth - 1, out);
            else if (re.test(items[i].name)) out.push(items[i]);
        }
    }

    function appFolder() {
        try { return Folder.appPackage.fsName; } catch (e) { return ''; }
    }

    function projectItemSize(item) {
        try {
            var md = item.getProjectMetadata();
            var m = /VideoInfo>\s*(\d+)\s*x\s*(\d+)/.exec(md);
            if (m) return { w: Number(m[1]), h: Number(m[2]) };
        } catch (e) { /* fall through */ }
        return null;
    }

    // ================================================================ public API

    var api = {};

    api.getInfo = guard(function () {
        var seq = app.project ? app.project.activeSequence : null;
        if (!seq) return ok({ sequence: null });
        var ctx = context(seq);
        return ok({
            sequence: seq.name,
            width: ctx.w,
            height: ctx.h,
            fps: Math.round(TPS / ctx.f * 1000) / 1000,
            videoTracks: seq.videoTracks.numTracks,
            audioTracks: seq.audioTracks.numTracks,
            beats: beatList(ctx, true).length,
            markers: seq.markers ? seq.markers.numMarkers : 0,
            playhead: Math.round(seq.getPlayerPosition().seconds * 1000) / 1000
        });
    });

    // -------- 9:16 setup

    api.makeVertical = guard(function (args) {
        var seq = activeSeq(), w = args.width || 1080, h = args.height || 1920;
        var s = seq.getSettings();
        s.videoFrameWidth = w;
        s.videoFrameHeight = h;
        seq.setSettings(s);
        var after = seq.getSettings();
        if (after.videoFrameWidth !== w || after.videoFrameHeight !== h) {
            return fail('Premiere kept the frame at ' + after.videoFrameWidth + 'x' + after.videoFrameHeight + '. Change it in Sequence > Sequence Settings.');
        }
        return ok({ width: w, height: h });
    });

    api.newVerticalFromSelection = guard(function (args) {
        var picked = app.getCurrentProjectViewSelection(), items = [];
        for (var i = 0; picked && i < picked.length; i++) if (picked[i] && picked[i].type === 1) items.push(picked[i]);
        if (!items.length) return fail('Select your clips in the Project panel first.');
        var seq = app.project.createNewSequenceFromClips(args.name || 'TikTok 9x16', items, app.project.rootItem);
        if (!seq) return fail('Premiere did not create the sequence.');
        try { app.project.openSequence(seq.sequenceID); } catch (e) { /* it usually opens itself */ }
        var s = seq.getSettings();
        s.videoFrameWidth = 1080;
        s.videoFrameHeight = 1920;
        seq.setSettings(s);
        return ok({ name: seq.name, clips: items.length });
    });

    api.fillFrame = guard(function (args) {
        var seq = activeSeq(), ctx = context(seq), done = 0, skipped = [];
        var list = [];
        if (args.target === 'selected') list = targetClips(ctx, 'selected');
        else for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var clips = seq.videoTracks[t].clips;
            for (var i = 0; i < clips.numItems; i++) list.push({ clip: clips[i], track: t });
        }
        for (var k = 0; k < list.length; k++) {
            var clip = list[k].clip, size = clip.projectItem ? projectItemSize(clip.projectItem) : null;
            if (!size) { skipped.push(clip.name); continue; }
            var fit = args.mode === 'fit';
            var ratio = fit ? Math.min(ctx.w / size.w, ctx.h / size.h) : Math.max(ctx.w / size.w, ctx.h / size.h);
            var sc = motion(clip).scale;
            if (sc.isTimeVarying()) { skipped.push(clip.name + ' (scale is keyframed)'); continue; }
            sc.setValue(Math.round(ratio * 10000) / 100, 1);
            done++;
        }
        return ok({ scaled: done, skipped: skipped });
    });

    // -------- beats

    api.createBeats = guard(function (args) {
        var seq = activeSeq(), ctx = context(seq);
        var bpm = Number(args.bpm);
        if (!(bpm >= 30 && bpm <= 300)) return fail('Enter a BPM between 30 and 300.');
        var interval = TPS * 60 / bpm * (Number(args.every) || 1);
        var start = Math.round((Number(args.firstSeconds) || 0) * TPS);
        var end = args.endSeconds ? Math.round(Number(args.endSeconds) * TPS) : Number(seq.end);
        if (args.replace) removeBeatMarkers(seq);
        var count = 0;
        for (var n = 0; n < 5000; n++) {
            var tk = snap(ctx, start + n * interval);
            if (tk >= end) break;
            var m = seq.markers.createMarker(tk / TPS);
            m.name = 'Beat ' + (n + 1);
            try { m.setColorByIndex(n % 4 === 0 ? 1 : 0); } catch (e) { /* color is cosmetic */ }
            count++;
        }
        return ok({ count: count, intervalSeconds: interval / TPS });
    });

    function removeBeatMarkers(seq) {
        var markers = seq.markers, doomed = [], m = markers.getFirstMarker();
        for (var i = 0; i < markers.numMarkers && m; i++) {
            if (BEAT_NAME.test(m.name)) doomed.push(m);
            m = markers.getNextMarker(m);
        }
        for (var d = 0; d < doomed.length; d++) markers.deleteMarker(doomed[d]);
        return doomed.length;
    }

    api.clearBeats = guard(function () { return ok({ removed: removeBeatMarkers(activeSeq()) }); });

    // -------- cut to the beat

    api.cutAtBeats = guard(function (args) {
        var seq = activeSeq(), ctx = context(seq), trackIndex = args.trackIndex || 0;
        if (trackIndex >= seq.videoTracks.numTracks) return fail('V' + (trackIndex + 1) + ' does not exist.');
        var beats = pickBeats(beatList(ctx, !args.allMarkers), args.everyN, 0);
        if (!beats.length) return fail('No beat markers yet. Create them in the Beats tab.');
        var track = seq.videoTracks[trackIndex];
        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        var qeTracks = [qeSeq.getVideoTrackAt(trackIndex)];
        if (args.withAudio && trackIndex < seq.audioTracks.numTracks) qeTracks.push(qeSeq.getAudioTrackAt(trackIndex));
        var before = track.clips.numItems, cuts = 0;
        for (var b = 0; b < beats.length; b++) {
            var inside = false;
            for (var i = 0; i < track.clips.numItems; i++) {
                var c = track.clips[i];
                if (beats[b] > Number(c.start.ticks) + ctx.f / 2 && beats[b] < Number(c.end.ticks) - ctx.f / 2) { inside = true; break; }
            }
            if (!inside) continue;
            var tc = ticksToTimecode(ctx, beats[b]);
            for (var q = 0; q < qeTracks.length; q++) qeTracks[q].razor(tc);
            cuts++;
        }
        var after = track.clips.numItems;
        if (cuts && after === before) return fail('Premiere ignored the cuts. Check that V' + (trackIndex + 1) + ' is not locked.');
        return ok({ cuts: cuts, clipsBefore: before, clipsAfter: after });
    });

    api.beatMontage = guard(function (args) {
        var seq = activeSeq(), ctx = context(seq);
        var v = args.trackIndex || 0, a = args.audioTrackIndex === undefined ? 1 : args.audioTrackIndex;
        var per = Math.max(1, Math.round(args.beatsPerClip || 1));
        var picked = app.getCurrentProjectViewSelection(), items = [];
        for (var i = 0; picked && i < picked.length; i++) if (picked[i] && picked[i].type === 1) items.push(picked[i]);
        if (!items.length) return fail('Select the clips in the Project panel first (they are placed in that order).');
        if (v >= seq.videoTracks.numTracks) return fail('V' + (v + 1) + ' does not exist.');
        if (a >= seq.audioTracks.numTracks) return fail('A' + (a + 1) + ' does not exist. Add an empty audio track for the clips\' own sound.');

        var playhead = Number(seq.getPlayerPosition().ticks);
        var all = beatList(ctx, true), beats = [];
        for (var b = 0; b < all.length; b++) if (all[b] >= playhead - ctx.f / 2) beats.push(all[b]);
        if (beats.length < 2) return fail('Need beat markers after the playhead. Create them in the Beats tab.');
        var interval = beats[beats.length - 1] - beats[beats.length - 2];
        function beatAt(n) { return n < beats.length ? beats[n] : beats[beats.length - 1] + (n - beats.length + 1) * interval; }

        var rangeStart = beatAt(0), rangeEnd = beatAt(items.length * per);
        var aClips = seq.audioTracks[a].clips;
        for (var ac = 0; ac < aClips.numItems; ac++) {
            if (Number(aClips[ac].start.ticks) < rangeEnd && Number(aClips[ac].end.ticks) > rangeStart) {
                return fail('A' + (a + 1) + ' already has audio there (your music?). Pick an empty audio track for the clips\' sound.');
            }
        }

        var placed = 0;
        for (var k = 0; k < items.length; k++) {
            var t0 = beatAt(k * per), t1 = beatAt((k + 1) * per);
            seq.overwriteClip(items[k], T(t0), v, a);
            var vc = clipStartingAt(seq.videoTracks[v], t0, ctx);
            if (!vc) { seq.overwriteClip(items[k], String(t0 / TPS), v, a); vc = clipStartingAt(seq.videoTracks[v], t0, ctx); }
            if (!vc) continue;
            if (Number(vc.end.ticks) > t1) setClipEnd(vc, t1);
            var ac2 = clipStartingAt(seq.audioTracks[a], t0, ctx);
            if (ac2 && Number(ac2.end.ticks) > t1) setClipEnd(ac2, t1);
            placed++;
        }
        return ok({ placed: placed, of: items.length });
    });

    function clipStartingAt(track, ticks, ctx) {
        for (var i = 0; i < track.clips.numItems; i++) {
            if (Math.abs(Number(track.clips[i].start.ticks) - ticks) < ctx.f / 2) return track.clips[i];
        }
        return null;
    }

    // -------- beat effects

    api.applyBeatEffect = guard(function (args) {
        var fx = FX[args.effect];
        if (!fx) return fail('Unknown effect: ' + args.effect);
        var seq = activeSeq(), ctx = context(seq);
        var beats = pickBeats(beatList(ctx, !args.allMarkers), args.everyN, args.offset);
        if (!beats.length) return fail('No beat markers yet. Create them in the Beats tab.');
        var items = targetClips(ctx, args.target, args.trackIndex), clipsDone = 0, keys = 0, errors = [];
        for (var i = 0; i < items.length; i++) {
            var c = items[i].clip, s = Number(c.start.ticks), e = Number(c.end.ticks), inClip = [];
            for (var b = 0; b < beats.length; b++) if (beats[b] >= s && beats[b] < e) inClip.push(beats[b]);
            if (!inClip.length) continue;
            try {
                keys += fx(ctx, items[i], inClip, args);
                clipsDone++;
            } catch (err) {
                errors.push(c.name + ': ' + (err.message || err));
            }
        }
        return ok({ clips: clipsDone, keyframes: keys, errors: errors, notes: ctx.notes });
    });

    // -------- text

    api.listTitles = guard(function () {
        var root = appFolder(), files = [], out = [];
        listFiles(new Folder(root + '/Contents/Essential Graphics'), /\.mogrt$/i, 4, files);
        listFiles(new Folder(root + '/Essential Graphics'), /\.mogrt$/i, 4, files);
        for (var i = 0; i < files.length; i++) {
            out.push({ name: files[i].displayName.replace(/\.mogrt$/i, ''), group: files[i].parent.displayName, path: files[i].fsName });
        }
        return ok(out);
    });

    api.pickMogrt = guard(function () {
        var filter = (Folder.fs === 'Windows') ? 'Motion Graphics templates:*.mogrt'
            : function (f) { return (f instanceof Folder) || /\.mogrt$/i.test(f.name); };
        var f = File.openDialog('Choose a title template (.mogrt)', filter, false);
        return ok(f ? f.fsName : '');
    });

    api.addText = guard(function (args) {
        var seq = activeSeq(), ctx = context(seq), v = args.trackIndex === undefined ? 1 : args.trackIndex;
        if (!args.mogrtPath || !new File(args.mogrtPath).exists) return fail('Pick a title template first.');
        if (v >= seq.videoTracks.numTracks) return fail('V' + (v + 1) + ' does not exist. Add a video track for text.');
        var text = String(args.text || '').replace(/^\s+|\s+$/g, '');
        if (!text) return fail('Type some text first.');
        if (args.anim && !TEXT[args.anim]) return fail('Unknown animation: ' + args.anim);

        var tokens = args.mode === 'words' ? text.split(/\s+/) : args.mode === 'lines' ? text.split(/\s*[\r\n]+\s*/) : [text];
        var playhead = snap(ctx, Number(seq.getPlayerPosition().ticks)), times = [];
        if (args.mode === 'whole') {
            times = [playhead, playhead + snap(ctx, (Number(args.seconds) || 2) * TPS)];
        } else {
            var per = Math.max(1, Math.round(args.beatsPer || 1)), all = beatList(ctx, true), beats = [];
            for (var b = 0; b < all.length; b++) if (all[b] >= playhead - ctx.f / 2) beats.push(all[b]);
            if (beats.length < 2) return fail('Need beat markers after the playhead. Create them in the Beats tab.');
            var interval = beats[beats.length - 1] - beats[beats.length - 2];
            for (var n = 0; n <= tokens.length; n++) {
                var idx = n * per;
                times.push(idx < beats.length ? beats[idx] : beats[beats.length - 1] + (idx - beats.length + 1) * interval);
            }
        }

        var placed = 0, notes = [];
        for (var i = 0; i < tokens.length; i++) {
            var t0 = times[i], t1 = times[i + 1];
            var clip = seq.importMGT(args.mogrtPath, String(t0), v, 0);
            if (!clip) return fail('Premiere could not insert the title template.');
            if (!setMogrtText(clip, args.uppercase ? tokens[i].toUpperCase() : tokens[i])) notes.push('Could not set the text of "' + tokens[i] + '"; this template may not have an editable text field.');
            setClipEnd(clip, t1);
            if (args.anim) {
                try { TEXT[args.anim](ctx, { clip: clip, track: v }); } catch (e) { notes.push(tokens[i] + ': ' + e.message); }
            }
            placed++;
        }
        return ok({ placed: placed, notes: notes.concat(ctx.notes) });
    });

    api.animateSelected = guard(function (args) {
        var anim = TEXT[args.anim];
        if (!anim) return fail('Unknown animation: ' + args.anim);
        var ctx = context(activeSeq()), items = targetClips(ctx, 'selected'), done = 0, errors = [];
        for (var i = 0; i < items.length; i++) {
            try { anim(ctx, items[i]); done++; } catch (e) { errors.push(items[i].clip.name + ': ' + e.message); }
        }
        return ok({ clips: done, errors: errors, notes: ctx.notes });
    });

    // -------- looks

    api.applyLook = guard(function (args) {
        var look = args.look || {}, values = look.lumetri || {}, k;
        var mix = args.intensity === undefined ? 1 : Math.max(0, Math.min(150, Number(args.intensity))) / 100;
        var ctx = context(activeSeq()), items = targetClips(ctx, args.target, args.trackIndex);
        var done = 0, missing = {}, errors = [];
        for (var i = 0; i < items.length; i++) {
            var clip = items[i].clip;
            try {
                // Reuse the clip's look instance; flash/flicker instances have keyed Exposure.
                var lum = findComponent(clip, LUMETRI_RE, false, exposureNotKeyed) ||
                          addEffect(ctx, clip, items[i].track, 'Lumetri Color', LUMETRI_RE);
                var target = {};
                for (k in LOOK_DEFAULTS) if (LOOK_DEFAULTS.hasOwnProperty(k)) target[k] = LOOK_DEFAULTS[k];
                for (k in values) {
                    if (!values.hasOwnProperty(k)) continue;
                    var def = LOOK_DEFAULTS.hasOwnProperty(k) ? LOOK_DEFAULTS[k] : 0;
                    target[k] = def + (Number(values[k]) - def) * mix;
                }
                for (k in target) {
                    if (!target.hasOwnProperty(k)) continue;
                    var p = lumetriProp(lum, k);
                    if (!p) { missing[k] = true; continue; }
                    if (p.isTimeVarying()) continue;
                    p.setValue(Math.round(target[k] * 100) / 100, 1);
                }
                done++;
            } catch (e) {
                errors.push(clip.name + ': ' + e.message);
            }
        }
        var miss = [];
        for (k in missing) if (missing.hasOwnProperty(k)) miss.push(k);
        return ok({ clips: done, missing: miss, errors: errors });
    });

    api._toJSON = toJSON; // used by the tests
    api._ticksToTimecode = function (f, ticks) { return ticksToTimecode({ f: f }, ticks); };
    return api;
}());
