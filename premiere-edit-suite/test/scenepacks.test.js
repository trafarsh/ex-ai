#!/usr/bin/env node
/* Download links, feeds, unzip and the Downloads watcher.  node test/scenepacks.test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const lib = require('../js/lib.js');
const io = require('../js/nodeio.js').create(require, lib);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('share links become direct downloads', () => {
  assert.strictEqual(lib.directDownloadUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing'),
    'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMn&export=download&confirm=t');
  assert.strictEqual(lib.directDownloadUrl('https://www.dropbox.com/s/x/pack.zip?dl=0'), 'https://www.dropbox.com/s/x/pack.zip?dl=1');
  assert.strictEqual(lib.directDownloadUrl('https://www.dropbox.com/s/x/pack.zip'), 'https://www.dropbox.com/s/x/pack.zip?dl=1');
  assert.strictEqual(lib.directDownloadUrl(' https://cdn.example.com/a.mp4 '), 'https://cdn.example.com/a.mp4');
  assert.throws(() => lib.directDownloadUrl('https://mega.nz/file/abc'), /MEGA/);
  assert.throws(() => lib.directDownloadUrl('scenepacks.com/x'), /full link/);
});

test('file names from headers and URLs are safe', () => {
  assert.strictEqual(lib.fileNameFor('attachment; filename="Joker 4K: Scenepack.zip"', ''), 'Joker 4K_ Scenepack.zip');
  assert.strictEqual(lib.fileNameFor("attachment; filename*=UTF-8''Tony%20Stark.zip", ''), 'Tony Stark.zip');
  assert.strictEqual(lib.fileNameFor('', 'https://x.com/files/Thomas%20Shelby.mp4?sig=1'), 'Thomas Shelby.mp4');
  assert.strictEqual(lib.packNameFor('patrick_bateman-4k.zip'), 'patrick bateman 4k');
});

test('tap tempo', () => {
  const taps = [0, 500, 1000, 1500, 2000, 2500];
  assert.strictEqual(lib.tapTempo(taps), 120);
  assert.strictEqual(lib.tapTempo([0, 500]), null);
  assert.strictEqual(lib.tapTempo([0, 400, 800, 5000, 5500, 6000, 6500]), 120, 'a pause starts over');
});

test('bundled feeds validate', () => {
  const ext = path.join(__dirname, '..');
  const looks = lib.validateFeed('looks', io.readLocalFeed(ext, 'looks'));
  assert.ok(looks.items.length >= 10);
  const sites = lib.validateFeed('sites', io.readLocalFeed(ext, 'sites'));
  assert.ok(sites.items.some((s) => /scenepacks\.com/.test(s.home)));
  assert.strictEqual(lib.validateFeed('trending', io.readLocalFeed(ext, 'trending')).items.length, 0);
  assert.strictEqual(lib.validateFeed('trending', { songs: [{ title: 'a', bpm: 128 }, { title: 'b', bpm: 9000 }] }).items.length, 1);
  assert.throws(() => lib.validateFeed('looks', { nope: 1 }));
  assert.strictEqual(lib.searchUrl(sites.items[0], 'tony stark'), 'https://www.google.com/search?q=site%3Ascenepacks.com+tony+stark');
});

function zipOf(dir, files) {
  const zip = path.join(dir, 'Tony_Stark-4K.zip');
  const py = 'import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],"w")\n' +
    files.map((f) => `z.writestr(${JSON.stringify(f)}, "data")`).join('\n') + '\nz.close()';
  cp.execFileSync('python3', ['-c', py, zip]);
  return zip;
}

test('downloads follow redirects, keep the server file name, reject web pages', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const body = Buffer.alloc(300000, 7);
  const server = http.createServer((req, res) => {
    if (req.url === '/go') { res.writeHead(302, { Location: '/file' }); return res.end(); }
    if (req.url === '/file') { res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length, 'Content-Disposition': 'attachment; filename="Pack One.zip"' }); return res.end(body); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    let progress = 0;
    const got = await io.download(base + '/go', tmp, (n) => { progress = n; });
    assert.strictEqual(got.name, 'Pack One.zip');
    assert.strictEqual(fs.statSync(got.path).size, body.length);
    assert.strictEqual(progress, body.length);
    const again = await io.download(base + '/file', tmp);
    assert.strictEqual(again.name, 'Pack One (2).zip');
    await assert.rejects(io.download(base + '/page', tmp), /web page/);
    assert.ok(!fs.readdirSync(tmp).some((n) => n.endsWith('.part')));
  } finally { server.close(); }
});

test('zip packs unpack and list only the videos', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const zip = zipOf(tmp, ['Tony/01.mp4', 'Tony/02.MOV', 'readme.txt', '__MACOSX/._01.mp4']);
  const prep = await io.prepare(zip);
  assert.strictEqual(prep.pack, 'Tony Stark 4K');
  assert.deepStrictEqual(prep.videos.map((p) => path.relative(path.join(tmp, 'Tony Stark 4K'), p)), [path.join('Tony', '01.mp4'), path.join('Tony', '02.MOV')]);
  await assert.rejects(io.prepare(path.join(tmp, 'x.rar')), /RAR/);
});

test('watcher reports a finished download once, ignores partial files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  const seen = [];
  const w = io.watch(tmp, (f) => seen.push(path.basename(f)));
  try {
    fs.writeFileSync(path.join(tmp, 'clip.mp4.crdownload'), 'partial');
    fs.renameSync(path.join(tmp, 'clip.mp4.crdownload'), path.join(tmp, 'clip.mp4'));
    fs.writeFileSync(path.join(tmp, 'notes.txt'), 'x');
    await new Promise((r) => setTimeout(r, 4500));
    assert.deepStrictEqual(seen, ['clip.mp4']);
  } finally { w.close(); }
});

(async () => {
  for (const [name, fn] of tests) {
    await fn();
    console.log('ok - ' + name);
  }
  console.log(tests.length + ' tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
