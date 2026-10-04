#!/usr/bin/env node
/* Make pack: grouping, cast parsing, and jsx/packMaker.jsx on a fake Premiere.  node test/packMaker.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const P = require('../js/packlib.js');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok - ' + name); }

// Three "people": random base vectors; each face is its person's vector plus noise.
function rand(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; }
function people(n, seed) {
  const r = rand(seed);
  return Array.from({ length: n }, () => Array.from({ length: 128 }, () => (r() - 0.5) * 0.18));
}
function faceOf(person, noise, r) { return person.map((v) => v + (r() - 0.5) * noise); }

test('groups faces of the same person and keeps people apart', () => {
  const ps = people(3, 7), r = rand(99), faces = [];
  let shot = 0;
  [12, 7, 3].forEach((count, p) => { for (let i = 0; i < count; i++) faces.push({ id: 'f' + faces.length, shot: shot++, descriptor: faceOf(ps[p], 0.03, r), score: 0.9, box: { width: 80, height: 80 }, person: p }); });
  faces.push({ id: 'extra', shot: shot++, descriptor: faceOf(people(1, 555)[0], 0.03, r), score: 0.9, box: { width: 80, height: 80 }, person: 9 });
  const { characters, others } = P.clusterFaces(faces, 0.45, 2);
  assert.deepStrictEqual(characters.map((c) => c.shots.length), [12, 7, 3]);
  characters.forEach((c) => assert.strictEqual(new Set(c.faces.map((f) => f.person)).size, 1));
  assert.deepStrictEqual(others.map((f) => f.id), ['extra']);
});

test('same person twice in one shot counts as one scene', () => {
  const p = people(1, 3)[0], r = rand(5);
  const faces = [0, 0, 1].map((shot, i) => ({ id: 'x' + i, shot, descriptor: faceOf(p, 0.02, r), score: 0.9 }));
  assert.deepStrictEqual(P.clusterFaces(faces, 0.45, 1).characters[0].shots, [0, 1]);
});

test('frame times sit inside the shot, one for very short shots', () => {
  const F = 1000;
  assert.deepStrictEqual(P.frameTimes(0, 100 * F, 3, F), [20 * F, 50 * F, 80 * F]);
  assert.deepStrictEqual(P.frameTimes(10 * F, 14 * F, 3, F), [12 * F]);
  assert.deepStrictEqual(P.frameTimes(0, 10 * F, 2, F), [3 * F, 7 * F]);
});

test('shot signature changes when cuts change', () => {
  const a = [{ startTicks: '0', endTicks: '10' }, { startTicks: '10', endTicks: '20' }];
  const b = [{ startTicks: '0', endTicks: '12' }, { startTicks: '12', endTicks: '20' }];
  assert.notStrictEqual(P.shotsSignature(a), P.shotsSignature(b));
  assert.strictEqual(P.shotsSignature(a), P.shotsSignature(JSON.parse(JSON.stringify(a))));
});

// Shaped like real Wikidata API replies (wbsearchentities / wbgetentities).
const SEARCH = { search: [
  { id: 'Q1', label: 'Once Upon a Time in Hollywood', description: 'Wikimedia disambiguation page' },
  { id: 'Q47300912', label: 'Once Upon a Time in Hollywood', description: '2019 film directed by Quentin Tarantino' },
  { id: 'Q3', label: 'Once Upon a Time in Hollywood', description: 'soundtrack album' } ] };
const qual = (id) => ({ datavalue: { value: { 'entity-type': 'item', id } } });
const castClaim = (actor, role) => ({ mainsnak: { datavalue: { value: { id: actor } } }, qualifiers: role ? { P453: [qual(role)] } : undefined });
const ENTITY = { entities: { Q47300912: { claims: { P161: [castClaim('Q38111', 'Q60'), castClaim('Q35332', 'Q61'), castClaim('Q1', 'Q62'), castClaim('Q38111'), castClaim('Q7', null)] } } } };
const LABELS = { entities: {
  Q38111: { labels: { en: { value: 'Leonardo DiCaprio' } } }, Q35332: { labels: { en: { value: 'Brad Pitt' } } },
  Q1: { labels: { en: { value: 'Margot Robbie' } } }, Q60: { labels: { en: { value: 'Rick Dalton' } } },
  Q61: { labels: { en: { value: 'Cliff Booth' } } }, Q62: { labels: { en: { value: 'Sharon Tate' } } } } };

test('Wikidata: picks the film and reads cast in billing order with roles', () => {
  const hit = P.pickTitle(SEARCH, null);
  assert.strictEqual(hit.id, 'Q47300912');
  assert.strictEqual(P.pickTitle(SEARCH, 2019).id, 'Q47300912');
  const cast = P.castFromEntity(ENTITY, hit.id);
  assert.deepStrictEqual(cast.map((c) => c.actorId), ['Q38111', 'Q35332', 'Q1', 'Q7']);
  const named = P.namedCast(cast, P.labelsFrom(LABELS));
  assert.deepStrictEqual(named.slice(0, 3), [
    { actor: 'Leonardo DiCaprio', character: 'Rick Dalton' },
    { actor: 'Brad Pitt', character: 'Cliff Booth' },
    { actor: 'Margot Robbie', character: 'Sharon Tate' }]);
  assert.strictEqual(named.length, 3, 'unlabelled actors dropped');
  assert.ok(/wbsearchentities.*origin=\*.*search=Once%20Upon/.test(P.wikidataSearchUrl('Once Upon')));
  assert.ok(/ids=Q1\|Q2/.test(P.entityUrl(['Q1', 'Q2'])));
});

test('pasted cast lists in common formats', () => {
  assert.deepStrictEqual(P.castFromText('1. Rick Dalton - Leonardo DiCaprio\nBrad Pitt as Cliff Booth\n\nSharon Tate: Margot Robbie\nRandy'), [
    { character: 'Rick Dalton', actor: 'Leonardo DiCaprio' },
    { actor: 'Brad Pitt', character: 'Cliff Booth' },
    { character: 'Sharon Tate', actor: 'Margot Robbie' },
    { character: 'Randy', actor: '' }]);
});

test('name suggestions follow screen time, skip names already used', () => {
  const chars = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const cast = [{ character: 'Rick Dalton' }, { character: 'Cliff Booth' }, { character: 'Sharon Tate' }];
  assert.deepStrictEqual(P.suggestNames(chars, cast, { b: 'Rick Dalton' }), { b: 'Rick Dalton', a: 'Cliff Booth', c: 'Sharon Tate' });
  assert.strictEqual(P.folderName('Rick: "Dalton"/x'), 'Rick_ _Dalton__x');
});

// ---------------------------------------------------------------- jsx on a fake Premiere

const TPS = 254016000000, F = 10594584000; // 23.976
function makeEnv() {
  class Time { constructor() { this._t = '0'; } get ticks() { return this._t; } set ticks(v) { this._t = String(v); }
    get seconds() { return Number(this._t) / TPS; } getFormatted(fr) { const f = Math.round(Number(this._t) / Number(fr.ticks)); return 'TC' + f; } }
  const T = (t) => { const x = new Time(); x.ticks = String(t); return x; };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const clip = (s, e, name) => ({ name, start: T(s * F), end: T(e * F), sel: false, setSelected(v) { this.sel = v; } });
  const v1 = [clip(0, 1000, 'movie.mkv')];
  const seq = {
    sequenceID: 'seq-9', name: 'Scenepack - movie', timebase: String(F),
    videoTracks: Object.assign([{ get clips() { return Object.assign(v1.slice(), { numItems: v1.length }); } }], { numTracks: 1 }),
    audioTracks: Object.assign([{ clips: Object.assign([clip(0, 1000, 'a')], { numItems: 1 }) }], { numTracks: 1 }),
    getSettings: () => ({ videoFrameWidth: 1920, videoFrameHeight: 800, videoDisplayFormat: 110 }),
    performSceneEditDetectionOnSelection(action, audio, sens) {
      this.args = [action, audio, sens];
      if (!v1[0].sel) return false;
      v1.splice(0, 1, clip(0, 100, 'movie.mkv'), clip(100, 340, 'movie.mkv'), clip(340, 1000, 'movie.mkv'));
      return true;
    },
  };
  const exported = [];
  const qeSeq = { exportFrameJPEG(tc, base) { exported.push([tc, base]); fs.writeFileSync(base + '.jpg', 'jpg'); return true; } };
  class FsItem { constructor(p) { this.fsName = path.resolve(String(p)); } get exists() { return fs.existsSync(this.fsName); } }
  class File extends FsItem {}
  class Folder extends FsItem { create() { fs.mkdirSync(this.fsName, { recursive: true }); return true; } }
  const project = { activeSequence: null, rootItem: {}, openSequence() {},
    createNewSequenceFromClips(name, items) { seq.name = name; seq.items = items; project.activeSequence = seq; return seq; } };
  const ctx = { app: { project, enableQE() {}, getCurrentProjectViewSelection: () => [{ type: 2, name: 'bin' }, { type: 1, name: 'Movie.2019.1080p.mkv' }] },
    qe: { project: { getActiveSequence: () => qeSeq } }, Time, File, Folder };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'jsx', 'packMaker.jsx'), 'utf8'), ctx);
  const call = (fn, args) => JSON.parse(ctx.PackMaker[fn](JSON.stringify(args || {})));
  return { ctx, seq, v1, exported, tmp, call, project };
}

test('jsx: movie selected in Project panel becomes its own sequence', () => {
  const env = makeEnv();
  const r = env.call('prepare');
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.data.name, 'Scenepack - Movie.2019.1080p');
  assert.strictEqual(env.seq.items[0].name, 'Movie.2019.1080p.mkv');
  assert.strictEqual(r.data.frameTicks, F);
});

test('jsx: scene detection runs on the selected V1 movie clip', () => {
  const env = makeEnv();
  env.project.activeSequence = env.seq;
  const r = env.call('findShots', { sensitivity: 'high' });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(r.data, { before: 1, shots: 3 });
  assert.deepStrictEqual(env.seq.args, ['ApplyCuts', true, 'HighSensitivity']);
});

test('jsx: frames export as dot-free JPEGs at formatted timecodes', () => {
  const env = makeEnv();
  env.project.activeSequence = env.seq;
  const r = env.call('exportFrames', { dir: path.join(env.tmp, 'frames'), items: [{ ticks: String(50 * F), name: 's1_0' }, { ticks: String(200 * F), name: 's2.0' }] });
  assert.ok(r.ok, r.error);
  assert.deepStrictEqual(env.exported.map((e) => e[0]), ['TC50', 'TC200']);
  assert.ok(r.data.every((f) => f.path && fs.existsSync(f.path)));
  assert.strictEqual(path.basename(r.data[1].path), 's2_0.jpg');
  env.call('exportFrames', { dir: path.join(env.tmp, 'frames'), items: [{ ticks: String(50 * F), name: 's1_0' }] });
  assert.strictEqual(env.exported.length, 2, 'existing frames are reused');
});

test('jsx: clips are renamed after their characters', () => {
  const env = makeEnv();
  env.project.activeSequence = env.seq;
  env.call('findShots', {});
  const r = env.call('nameClips', { items: [{ startTicks: String(100 * F), label: 'Rick Dalton + Cliff Booth' }] });
  assert.strictEqual(r.data.named, 1);
  assert.strictEqual(env.v1[1].name, 'Rick Dalton + Cliff Booth');
});

console.log(passed + ' tests passed');
