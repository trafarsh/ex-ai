#!/usr/bin/env node
/*
 * Runs jsx/shotExporter.jsx against a fake Premiere Pro object model, so the
 * cut-reading and export logic can be checked without Premiere.
 *   node test/shotExporter.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const TPS = 254016000000;
const TPF = 10594584000; // 23.976 fps
const NOT_SET = '-400000';

function makeContext() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shotexp-'));

  class Time {
    constructor() { this._ticks = '0'; }
    get ticks() { return this._ticks; }
    set ticks(v) { this._ticks = String(v); }
    get seconds() { return Number(this._ticks) / TPS; }
    set seconds(v) { this._ticks = String(Math.round(v * TPS)); }
    getFormatted() { return 'F' + Math.round(Number(this._ticks) / TPF); }
  }
  const t = (ticks) => { const x = new Time(); x.ticks = ticks; return x; };

  class FsItem {
    constructor(p) { this.fsName = path.resolve(String(p)); }
    get name() { return path.basename(this.fsName); }
    get displayName() { return this.name; }
    get exists() { return fs.existsSync(this.fsName); }
    get parent() { return new Folder(path.dirname(this.fsName)); }
  }
  class File extends FsItem {
    remove() { fs.unlinkSync(this.fsName); return true; }
  }
  class Folder extends FsItem {
    create() { fs.mkdirSync(this.fsName, { recursive: true }); return true; }
    getFiles() {
      return fs.readdirSync(this.fsName).map((n) => {
        const p = path.join(this.fsName, n);
        return fs.statSync(p).isDirectory() ? new Folder(p) : new File(p);
      });
    }
  }
  Folder.fs = 'Macintosh';
  Folder.myDocuments = new Folder(path.join(tmp, 'Documents'));
  Folder.appPackage = new Folder(path.join(tmp, 'Premiere.app'));

  // Three shots on V1 with a gap after shot 2, plus a title on V2 that must be ignored.
  const v1 = [
    { name: 'Movie.mp4', start: 0, end: 48 },
    { name: 'Movie.mp4', start: 48, end: 120 },
    { name: 'Movie.mp4', start: 130, end: 200, disabled: true },
  ].map((c) => ({
    name: c.name, start: t(c.start * TPF), end: t(c.end * TPF), disabled: !!c.disabled,
    isSelected: () => c.start === 48, isAdjustmentLayer: () => false,
  }));
  const coll = (arr) => Object.assign(arr.slice(), { numItems: arr.length });
  const seqState = { in: NOT_SET, out: NOT_SET, renders: [], log: [] };

  const seq = {
    sequenceID: 'seq-1',
    name: 'Feature',
    timebase: String(TPF),
    end: String(200 * TPF),
    videoDisplayFormat: 110,
    videoTracks: Object.assign([
      { name: 'Video 1', clips: coll(v1) },
      { name: 'Titles', clips: coll([{ name: 'Title', start: t(10 * TPF), end: t(30 * TPF) }]) },
    ], { numTracks: 2 }),
    getSettings: () => ({ videoFrameRate: t(TPF) }),
    getInPoint: () => (seqState.in === NOT_SET ? NOT_SET : String(Number(seqState.in) / TPS)),
    getOutPoint: () => (seqState.out === NOT_SET ? NOT_SET : String(Number(seqState.out) / TPS)),
    getInPointAsTime: () => t(seqState.in === NOT_SET ? Number(NOT_SET) * TPS : seqState.in),
    getOutPointAsTime: () => t(seqState.out === NOT_SET ? Number(NOT_SET) * TPS : seqState.out),
    setInPoint: (v) => { seqState.in = typeof v === 'object' ? v.ticks : String(Math.round(v * TPS)); },
    setOutPoint: (v) => { seqState.out = typeof v === 'object' ? v.ticks : String(Math.round(v * TPS)); },
    getExportFileExtension: (p) => (fs.existsSync(p) ? 'mp4' : ''),
    exportAsMediaDirect: (out, preset, area) => {
      seqState.renders.push({ out, area, in: seqState.in, outPt: seqState.out });
      fs.writeFileSync(out, 'video');
      return true;
    },
  };

  let job = 0;
  const encoder = {
    bound: {},
    bind(name, fn) { this.bound[name] = fn; },
    launchEncoder() { seqState.log.push('launch'); return 0; },
    setSidecarXMPEnabled() { return 0; },
    startBatch() { seqState.log.push('startBatch'); return 0; },
    encodeSequence(s, out, preset, area, remove) {
      seqState.renders.push({ out, area, in: seqState.in, outPt: seqState.out, ame: true });
      return String(++job);
    },
  };

  const project = { activeSequence: seq, sequences: Object.assign([seq], { numSequences: 1 }) };
  const ctx = {
    app: { project, encoder },
    Time, File, Folder,
    BridgeTalk: { getStatus: () => 'ISNOTRUNNING' },
    ExternalObject: function () {},
    CSXSEvent: function () { this.dispatch = () => seqState.log.push('event:' + this.data); },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'jsx', 'shotExporter.jsx'), 'utf8'), ctx);
  // `var` at the top level of a vm script becomes a property of the context.
  return { ctx, seqState, tmp, Folder };
}

function call(ctx, fn, args) {
  const res = JSON.parse(ctx.ShotExporter[fn](JSON.stringify(args || {})));
  return res;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok - ' + name);
}

test('reads V1 clip boundaries, ignores other tracks', () => {
  const { ctx } = makeContext();
  const r = call(ctx, 'getSequenceInfo', { trackIndex: 0 });
  assert.ok(r.ok, r.error);
  const shots = r.data.shots;
  assert.strictEqual(shots.length, 3);
  assert.deepStrictEqual(shots.map((s) => s.frames), [48, 72, 70]);
  assert.strictEqual(shots[1].startTicks, String(48 * TPF));
  assert.strictEqual(shots[1].endTicks, String(120 * TPF));
  assert.strictEqual(shots[1].selected, true);
  assert.strictEqual(shots[2].disabled, true);
  assert.strictEqual(r.data.sequenceName, 'Feature');
  assert.strictEqual(r.data.fps, 23.976);
  assert.strictEqual(r.data.tracks.length, 2);
});

test('rejects a track index that does not exist', () => {
  const { ctx } = makeContext();
  const r = call(ctx, 'getSequenceInfo', { trackIndex: 5 });
  assert.strictEqual(r.ok, false);
});

test('renders each shot with in/out exactly on the cut, then restores marks', () => {
  const { ctx, seqState, tmp } = makeContext();
  const preset = path.join(tmp, 'preset.epr');
  fs.writeFileSync(preset, '<xml/>');
  const out = path.join(tmp, 'out');
  const info = call(ctx, 'getSequenceInfo', {}).data;

  assert.ok(call(ctx, 'beginExport', { sequenceId: 'seq-1', mode: 'direct' }).ok);
  info.shots.forEach((s) => {
    const r = call(ctx, 'exportShot', {
      sequenceId: 'seq-1', mode: 'direct', startTicks: s.startTicks, endTicks: s.endTicks,
      folder: out, fileName: 'shot_' + s.number, presetPath: preset,
    });
    assert.ok(r.ok, r.error);
    assert.ok(fs.existsSync(r.data.path));
  });
  assert.deepStrictEqual(seqState.renders.map((x) => [x.in, x.outPt, x.area]), [
    [String(0), String(48 * TPF), 1],
    [String(48 * TPF), String(120 * TPF), 1],
    [String(130 * TPF), String(200 * TPF), 1],
  ]);
  const end = call(ctx, 'endExport', { mode: 'direct' });
  assert.ok(end.data.restored);
  assert.strictEqual(seqState.in, '0');
  assert.strictEqual(seqState.out, String(200 * TPF));
});

test('restores in/out marks the editor had set', () => {
  const { ctx, seqState, tmp } = makeContext();
  seqState.in = String(5 * TPF);
  seqState.out = String(60 * TPF);
  const preset = path.join(tmp, 'p.epr');
  fs.writeFileSync(preset, 'x');
  call(ctx, 'beginExport', { sequenceId: 'seq-1', mode: 'direct' });
  call(ctx, 'exportShot', { sequenceId: 'seq-1', mode: 'direct', startTicks: String(130 * TPF),
    endTicks: String(200 * TPF), folder: tmp, fileName: 'a', presetPath: preset });
  call(ctx, 'endExport', { mode: 'direct' });
  assert.strictEqual(seqState.in, String(5 * TPF));
  assert.strictEqual(seqState.out, String(60 * TPF));
});

test('does not overwrite by default, versions the name instead', () => {
  const { ctx, tmp } = makeContext();
  const preset = path.join(tmp, 'p.epr');
  fs.writeFileSync(preset, 'x');
  fs.writeFileSync(path.join(tmp, 'shot.mp4'), 'old');
  const r = call(ctx, 'exportShot', { sequenceId: 'seq-1', mode: 'direct', startTicks: '0',
    endTicks: String(48 * TPF), folder: tmp, fileName: 'shot', presetPath: preset });
  assert.strictEqual(path.basename(r.data.path), 'shot_v2.mp4');
  assert.strictEqual(fs.readFileSync(path.join(tmp, 'shot.mp4'), 'utf8'), 'old');
});

test('out-point adjust shifts the out mark by whole frames', () => {
  const { ctx, seqState, tmp } = makeContext();
  const preset = path.join(tmp, 'p.epr');
  fs.writeFileSync(preset, 'x');
  call(ctx, 'exportShot', { sequenceId: 'seq-1', mode: 'direct', startTicks: '0',
    endTicks: String(48 * TPF), folder: tmp, fileName: 's', presetPath: preset, outAdjustFrames: -1 });
  assert.strictEqual(seqState.renders[0].outPt, String(47 * TPF));
});

test('queues in Media Encoder with in-to-out range and starts the batch', () => {
  const { ctx, seqState, tmp } = makeContext();
  const preset = path.join(tmp, 'p.epr');
  fs.writeFileSync(preset, 'x');
  assert.ok(call(ctx, 'beginExport', { sequenceId: 'seq-1', mode: 'ame', startBatch: true }).ok);
  const r = call(ctx, 'exportShot', { sequenceId: 'seq-1', mode: 'ame', startTicks: String(48 * TPF),
    endTicks: String(120 * TPF), folder: tmp, fileName: 's', presetPath: preset });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.jobID, '1');
  assert.deepStrictEqual([seqState.renders[0].in, seqState.renders[0].outPt, seqState.renders[0].area, seqState.renders[0].ame],
    [String(48 * TPF), String(120 * TPF), 1, true]);
  ctx.app.encoder.bound.onEncoderJobQueued('1');
  call(ctx, 'endExport', { mode: 'ame', startBatch: true });
  assert.ok(seqState.log.includes('launch'));
  assert.ok(seqState.log.includes('startBatch'));
  assert.ok(seqState.log.some((l) => l.startsWith('event:') && l.includes('"queued"')));
});

test('fails cleanly on a missing preset', () => {
  const { ctx, tmp } = makeContext();
  const r = call(ctx, 'exportShot', { sequenceId: 'seq-1', mode: 'direct', startTicks: '0',
    endTicks: String(48 * TPF), folder: tmp, fileName: 's', presetPath: path.join(tmp, 'nope.epr') });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /Preset not found/);
});

test('lists built-in presets with readable exporter names', () => {
  const { ctx, tmp } = makeContext();
  const dir = path.join(tmp, 'Premiere.app', 'Contents', 'MediaIO', 'systempresets', '4E49434B_48323634');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Match Source - High bitrate.epr'), 'x');
  const r = call(ctx, 'listPresets');
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.data.map((p) => [p.group, p.name]), [['H264', 'Match Source - High bitrate']]);
});

test('JSON encoder escapes Windows paths and quotes', () => {
  const { ctx } = makeContext();
  const s = ctx.ShotExporter._toJSON({ p: 'C:\\Shots\\"a"\n', n: [1, true, null] });
  assert.deepStrictEqual(JSON.parse(s), { p: 'C:\\Shots\\"a"\n', n: [1, true, null] });
});

console.log(passed + ' tests passed');
