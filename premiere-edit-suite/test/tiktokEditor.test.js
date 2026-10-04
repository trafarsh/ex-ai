#!/usr/bin/env node
/* Runs jsx/tiktokEditor.jsx against a fake Premiere object model.  node test/tiktokEditor.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TPS = 254016000000;
const F = 8475667200; // ticks per frame at 29.97 fps
const sec = (s) => Math.round(s * TPS);

class Time {
  constructor() { this._t = '0'; }
  get ticks() { return this._t; }
  set ticks(v) { this._t = String(v); }
  get seconds() { return Number(this._t) / TPS; }
  set seconds(v) { this._t = String(Math.round(v * TPS)); }
}
const T = (ticks) => { const t = new Time(); t.ticks = String(Math.round(ticks)); return t; };

function prop(displayName, value) {
  return {
    displayName, value, varying: false, keys: {}, interp: {},
    isTimeVarying() { return this.varying; },
    setTimeVarying(v) { this.varying = v; },
    getValue() { return this.value; },
    setValue(v) { if (this.varying) throw new Error('time-varying'); this.value = v; },
    addKey(t) { if (!(t.ticks in this.keys)) this.keys[t.ticks] = this.value; },
    setValueAtKey(t, v) { this.keys[t.ticks] = v; },
    setInterpolationTypeAtKey(t, i) { this.interp[t.ticks] = i; },
    getValueAtTime() { return this.value; },
  };
}
const coll = (arr, countKey = 'numItems') => Object.assign(arr, { [countKey]: arr.length });

const EFFECTS = {
  'Lumetri Color': () => ({ displayName: 'Lumetri Color', matchName: 'AE.ADBE Lumetri', props: [
    prop('Basic Correction', 0), prop('Temperature', 0), prop('Tint', 0), prop('Exposure', 0), prop('Contrast', 0),
    prop('Highlights', 0), prop('Shadows', 0), prop('Whites', 0), prop('Blacks', 0), prop('Saturation', 100),
    prop('Creative', 0), prop('Faded Film', 0), prop('Sharpen', 0), prop('Vibrance', 0), prop('Saturation', 100),
    prop('Vignette', 0), prop('Amount', 0)] }),
  'Transform': () => ({ displayName: 'Transform', matchName: 'AE.ADBE Geometry2', props: [
    prop('Anchor Point', [0.5, 0.5]), prop('Position', [0.5, 0.5]), prop('Uniform Scale', true), prop('Scale', 100),
    prop('Skew', 0), prop('Rotation', 0), prop("Use Composition's Shutter Angle", true), prop('Shutter Angle', 0)] }),
  'Basic 3D': () => ({ displayName: 'Basic 3D', matchName: 'AE.ADBE Basic 3D', props: [prop('Swivel', 0), prop('Tilt', 0)] }),
  'Directional Blur': () => ({ displayName: 'Directional Blur', matchName: 'AE.ADBE Motion Blur', props: [prop('Direction', 0), prop('Blur Length', 0)] }),
};

function component(c) { return Object.assign(c, { properties: coll(c.props) }); }

let nodeIds = 0;
function makeClip(name, startSec, endSec, inSec = 0, extra = {}) {
  const comps = [
    component({ displayName: 'Opacity', matchName: 'AE.ADBE Opacity', props: [prop('Opacity', 100)] }),
    component({ displayName: 'Motion', matchName: 'AE.ADBE Motion', props: [prop('Position', [0.5, 0.5]), prop('Scale', 100), prop('Scale Width', 100), prop('Uniform Scale', true), prop('Rotation', 0)] }),
  ];
  return Object.assign({
    name, nodeId: 'n' + (++nodeIds), mediaType: 'Video',
    start: T(sec(startSec)), _end: T(sec(endSec)), inPoint: T(sec(inSec)),
    get end() { return this._end; }, set end(v) { this._end = typeof v === 'string' ? T(v) : v; },
    components: coll(comps), selected: false,
    isSelected() { return this.selected; }, getSpeed: () => 1, isSpeedReversed: () => false,
    projectItem: { getProjectMetadata: () => '<x:Column.Intrinsic.VideoInfo>1920 x 1080 (1.0)</x:Column.Intrinsic.VideoInfo>' },
  }, extra);
}

function makeEnv() {
  const v1 = [makeClip('A.mp4', 0, 4, 10), makeClip('B.mp4', 4, 8)];
  const tracks = [v1, [], []];
  const markers = [];
  const log = [];
  const settings = { videoFrameWidth: 1920, videoFrameHeight: 1080 };
  const markerColl = {
    get numMarkers() { return markers.length; },
    createMarker(s) { const m = { name: '', start: T(Math.round(s * TPS)), setColorByIndex(c) { this.color = c; } }; markers.push(m); markers.sort((a, b) => a.start.ticks - b.start.ticks); return m; },
    getFirstMarker() { return markers[0]; },
    getNextMarker(m) { return markers[markers.indexOf(m) + 1]; },
    deleteMarker(m) { markers.splice(markers.indexOf(m), 1); },
  };
  const seq = {
    name: 'Edit', timebase: String(F), end: String(sec(8)), markers: markerColl,
    videoTracks: coll(tracks.map((clips, i) => ({ name: 'Video ' + (i + 1), get clips() { return coll(clips.slice()); } })), 'numTracks'),
    audioTracks: coll([{ clips: coll([{ name: 'music', start: T(0), end: T(sec(8)) }]) }, { clips: coll([]) }], 'numTracks'),
    getSettings: () => Object.assign({}, settings),
    setSettings: (s) => Object.assign(settings, s),
    getPlayerPosition: () => T(sec(1)),
    getSelection: () => [].concat(...tracks).filter((c) => c.selected),
    importMGT(p, ticks, v) {
      const textProp = prop('Text', '{"textEditValue":"Title","fontSize":100}');
      const clip = makeClip('Graphic', Number(ticks) / TPS, Number(ticks) / TPS + 5);
      clip.getMGTComponent = () => component({ displayName: 'Graphic Parameters', matchName: 'x', props: [textProp] });
      clip._text = textProp;
      tracks[v].push(clip);
      tracks[v].sort((a, b) => a.start.ticks - b.start.ticks);
      return clip;
    },
  };
  const qeSeq = {
    getVideoTrackAt(i) {
      return {
        get numItems() { return tracks[i].length; },
        getItemAt(j) {
          const clip = tracks[i][j];
          return { type: 'Clip', start: clip.start, addVideoEffect(eff) { clip.components.push(component(EFFECTS[eff.name]())); clip.components.numItems = clip.components.length; } };
        },
        razor(tc) {
          log.push('razor ' + tc);
          const [h, m, s, fr] = tc.split(':').map(Number);
          const ticks = ((h * 3600 + m * 60 + s) * 30 + fr) * F;
          const idx = tracks[i].findIndex((c) => ticks > Number(c.start.ticks) && ticks < Number(c.end.ticks));
          if (idx < 0) return;
          const c = tracks[i][idx];
          const right = makeClip(c.name, ticks / TPS, Number(c.end.ticks) / TPS);
          c.end = T(ticks);
          tracks[i].splice(idx + 1, 0, right);
        },
      };
    },
    getAudioTrackAt() { return { razor() {} }; },
  };
  const app = {
    project: { activeSequence: seq },
    enableQE() {},
    getCurrentProjectViewSelection: () => [],
  };
  const qe = { project: { getActiveSequence: () => qeSeq, getVideoEffectByName: (n) => (EFFECTS[n] ? { name: n } : null) } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  class FsItem { constructor(p) { this.fsName = path.resolve(String(p)); } get name() { return path.basename(this.fsName); } get displayName() { return this.name; } get exists() { return fs.existsSync(this.fsName); } get parent() { return new Folder(path.dirname(this.fsName)); } }
  class File extends FsItem {}
  class Folder extends FsItem { getFiles() { return fs.readdirSync(this.fsName).map((n) => { const p = path.join(this.fsName, n); return fs.statSync(p).isDirectory() ? new Folder(p) : new File(p); }); } }
  Folder.appPackage = new Folder(path.join(tmp, 'Premiere.app'));
  const ctx = { app, qe, Time, File, Folder };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'jsx', 'tiktokEditor.jsx'), 'utf8'), ctx);
  return { ctx, seq, tracks, markers, settings, log, tmp };
}

const call = (env, fn, args) => {
  const r = JSON.parse(env.ctx.TikTokEditor[fn](JSON.stringify(args || {})));
  assert.ok(r.ok, fn + ' failed: ' + r.error);
  return r.data;
};
const callFail = (env, fn, args) => JSON.parse(env.ctx.TikTokEditor[fn](JSON.stringify(args || {})));
const keysOf = (p) => Object.keys(p.keys).map(Number).sort((a, b) => a - b);
const motion = (clip, name) => clip.components.find((c) => c.displayName === 'Motion').props.find((p) => p.displayName === name);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok - ' + name); }

test('makes the sequence 1080x1920', () => {
  const env = makeEnv();
  call(env, 'makeVertical', {});
  assert.deepStrictEqual([env.settings.videoFrameWidth, env.settings.videoFrameHeight], [1080, 1920]);
});

test('fill frame scales 16:9 footage to cover 9:16', () => {
  const env = makeEnv();
  call(env, 'makeVertical', {});
  const r = call(env, 'fillFrame', { mode: 'fill' });
  assert.strictEqual(r.scaled, 2);
  assert.strictEqual(motion(env.tracks[0][0], 'Scale').value, 177.78);
});

test('creates frame-snapped beat markers from BPM and clears only its own', () => {
  const env = makeEnv();
  env.seq.markers.createMarker(2).name = 'My note';
  const r = call(env, 'createBeats', { bpm: 120, firstSeconds: 0.5, every: 1 });
  assert.strictEqual(r.count, 15); // 0.5 .. 7.5 s
  const beats = env.markers.filter((m) => /^Beat/.test(m.name));
  assert.strictEqual(beats[0].name, 'Beat 1');
  assert.strictEqual(beats[0].color, 1);
  assert.strictEqual(beats[1].color, 0);
  beats.forEach((m) => assert.ok(Math.abs(Number(m.start.ticks) / F - Math.round(Number(m.start.ticks) / F)) < 1e-6));
  assert.strictEqual(call(env, 'clearBeats').removed, 15);
  assert.deepStrictEqual(env.markers.map((m) => m.name), ['My note']);
});

test('rejects silly BPM', () => {
  assert.strictEqual(callFail(makeEnv(), 'createBeats', { bpm: 5 }).ok, false);
});

test('zoom punch keys Motion scale on every beat, in media time', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 }); // beats at 1..7 s
  const r = call(env, 'applyBeatEffect', { effect: 'zoom', target: 'track', trackIndex: 0, intensity: 30, frames: 6 });
  assert.strictEqual(r.clips, 2);
  const scale = motion(env.tracks[0][0], 'Scale');
  const k = keysOf(scale);
  // clip A starts at 0 with source in-point 10 s: beat at 1 s -> media 11 s
  const beat = Math.round(sec(1) / F) * F;
  assert.ok(k.includes(sec(10) + beat), 'key at media time of the beat');
  assert.strictEqual(scale.keys[sec(10) + beat], 130);
  assert.strictEqual(scale.keys[sec(10) + beat - F], 100);
  assert.strictEqual(scale.interp[sec(10) + beat], 5);
});

test('shake moves position in normalized units and returns to rest', () => {
  const env = makeEnv();
  call(env, 'makeVertical', {});
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  env.tracks[0][1].selected = true;
  call(env, 'applyBeatEffect', { effect: 'shake', target: 'selected', strength: 40, frames: 8, blur: false });
  const pos = motion(env.tracks[0][1], 'Position');
  const vals = keysOf(pos).map((t) => pos.keys[t]);
  assert.ok(vals.every((v) => Math.abs(v[0] - 0.5) <= 40 / 1080 + 1e-9 && Math.abs(v[1] - 0.5) <= 40 / 1920 + 1e-9));
  assert.deepStrictEqual(vals[vals.length - 1], [0.5, 0.5]);
  assert.strictEqual(motion(env.tracks[0][0], 'Position').keys && keysOf(motion(env.tracks[0][0], 'Position')).length, 0, 'unselected clip untouched');
});

test('motion blur zoom adds Transform with shutter angle', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  call(env, 'applyBeatEffect', { effect: 'zoom', target: 'track', trackIndex: 0, blur: true });
  const tr = env.tracks[0][0].components.find((c) => c.displayName === 'Transform');
  assert.ok(tr);
  assert.strictEqual(tr.props.find((p) => /Use Composition/.test(p.displayName)).value, false);
  assert.strictEqual(tr.props.find((p) => p.displayName === 'Shutter Angle').value, 180);
  assert.ok(keysOf(tr.props.find((p) => p.displayName === 'Scale')).length > 0);
});

test('CC flicker uses hold keys on a new Lumetri', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  call(env, 'applyBeatEffect', { effect: 'flicker', target: 'track', trackIndex: 0 });
  const lum = env.tracks[0][0].components.find((c) => c.displayName === 'Lumetri Color');
  const temp = lum.props.find((p) => p.displayName === 'Temperature');
  const ks = keysOf(temp);
  assert.ok(ks.length >= 4);
  assert.ok(Object.values(temp.interp).every((i) => i === 4));
  assert.deepStrictEqual(ks.slice(1, 4).map((t) => temp.keys[t]), [-35, 0, 35]);
});

test('glitch keys Transform and notes the missing RGB effect', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  const r = call(env, 'applyBeatEffect', { effect: 'glitch', target: 'track', trackIndex: 0 });
  assert.ok(r.keyframes > 0);
  assert.ok(r.notes.some((n) => /RGB split skipped/.test(n)));
});

test('velocity punch adds directional blur', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  call(env, 'applyBeatEffect', { effect: 'velocity', target: 'track', trackIndex: 0 });
  const db = env.tracks[0][0].components.find((c) => c.displayName === 'Directional Blur');
  assert.ok(Object.values(db.props[1].keys).includes(40));
});

test('needs beat markers for effects', () => {
  const r = callFail(makeEnv(), 'applyBeatEffect', { effect: 'zoom', target: 'track' });
  assert.match(r.error, /No beat markers/);
});

test('razor cuts clips at beats with a timecode string', () => {
  const env = makeEnv();
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  const r = call(env, 'cutAtBeats', { trackIndex: 0, everyN: 2 });
  assert.strictEqual(r.cuts, 4); // beats 1,3,5,7 s; none on the 4 s boundary
  assert.strictEqual(r.clipsAfter, 6);
  assert.ok(env.log[0].startsWith('razor 00:00:01:00'));
});

test('word-by-word text lands on the beats after the playhead', () => {
  const env = makeEnv();
  fs.writeFileSync(path.join(env.tmp, 't.mogrt'), 'x');
  call(env, 'createBeats', { bpm: 120, firstSeconds: 0 });
  const r = call(env, 'addText', { text: 'no way bro', mode: 'words', beatsPer: 1, mogrtPath: path.join(env.tmp, 't.mogrt'), trackIndex: 1, anim: 'pop', uppercase: true });
  assert.strictEqual(r.placed, 3);
  const clips = env.tracks[1];
  const snapF = (s) => Math.round(sec(s) / F) * F;
  assert.deepStrictEqual(clips.map((c) => Number(c.start.ticks)), [snapF(1), snapF(1.5), snapF(2)]);
  assert.strictEqual(Number(clips[0].end.ticks), snapF(1.5));
  assert.strictEqual(JSON.parse(clips[2]._text.value).textEditValue, 'BRO');
  assert.strictEqual(motion(clips[0], 'Scale').keys[clips[0].inPoint.ticks], 0);
});

test('3D text animation keys Basic 3D swivel', () => {
  const env = makeEnv();
  env.tracks[0][0].selected = true;
  call(env, 'animateSelected', { anim: '3d' });
  const b3d = env.tracks[0][0].components.find((c) => c.displayName === 'Basic 3D');
  assert.deepStrictEqual(Object.values(b3d.props[0].keys), [90, 0]);
});

test('looks blend from defaults, use section names, and reuse the same Lumetri', () => {
  const env = makeEnv();
  env.tracks[0][0].selected = true;
  const look = { name: 'x', lumetri: { Temperature: 20, Saturation: 140, 'Vignette/Amount': -2 } };
  call(env, 'applyLook', { look, intensity: 50, target: 'selected' });
  call(env, 'applyLook', { look: { name: 'y', lumetri: { Contrast: 30 } }, intensity: 100, target: 'selected' });
  const lums = env.tracks[0][0].components.filter((c) => c.displayName === 'Lumetri Color');
  assert.strictEqual(lums.length, 1, 'second look replaces the first');
  const p = (n, i = 0) => lums[0].props.filter((x) => x.displayName === n)[i];
  assert.strictEqual(p('Temperature').value, 0, 'reset by the second look');
  assert.strictEqual(p('Contrast').value, 30);
  call(env, 'applyLook', { look, intensity: 50, target: 'selected' });
  assert.strictEqual(p('Temperature').value, 10);
  assert.strictEqual(p('Saturation', 0).value, 120);
  assert.strictEqual(p('Saturation', 1).value, 100, 'creative saturation untouched');
  assert.strictEqual(p('Amount').value, -1);
});

test('beat montage refuses to overwrite the music track', () => {
  const env = makeEnv();
  env.ctx.app.getCurrentProjectViewSelection = () => [{ type: 1, name: 'a' }];
  call(env, 'createBeats', { bpm: 60, firstSeconds: 1 });
  const r = callFail(env, 'beatMontage', { trackIndex: 0, audioTrackIndex: 0 });
  assert.match(r.error, /already has audio/);
});

test('timecode for razor at 29.97', () => {
  const env = makeEnv();
  assert.strictEqual(env.ctx.TikTokEditor._ticksToTimecode(F, 95 * F), '00:00:03:05');
});

console.log(passed + ' tests passed');
