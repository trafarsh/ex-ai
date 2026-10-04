/* Edit Suite: downloads, unzipping and the Downloads-folder watcher (Node, inside CEP). */
(function (root) {
  'use strict';

  function create(req, lib) {
    var fs = req('fs'), path = req('path'), os = req('os');
    var http = req('http'), https = req('https'), cp = req('child_process');
    var URLCtor = req('url').URL;

    function defaultDownloads() { return path.join(os.homedir(), 'Downloads'); }

    function uniquePath(dir, name) {
      var ext = path.extname(name), base = name.slice(0, name.length - ext.length), p = path.join(dir, name), n = 2;
      while (fs.existsSync(p) || fs.existsSync(p + '.part')) p = path.join(dir, base + ' (' + (n++) + ')' + ext);
      return p;
    }

    /** Downloads url into dir. Resolves {path, name}. */
    function download(url, dir, onProgress, hops) {
      hops = hops || 0;
      return new Promise(function (resolve, reject) {
        var mod = /^https:/i.test(url) ? https : http;
        var request = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (EditSuite for Premiere Pro)', 'Accept': '*/*' } }, function (res) {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (hops >= 8) return reject(new Error('Too many redirects.'));
            return resolve(download(new URLCtor(res.headers.location, url).toString(), dir, onProgress, hops + 1));
          }
          if (res.statusCode !== 200) { res.resume(); return reject(new Error('The server answered ' + res.statusCode + '.')); }
          var type = String(res.headers['content-type'] || '');
          if (/text\/html/i.test(type)) {
            res.resume();
            return reject(new Error('That link opens a web page, not a file. Open it in your browser and press its Download button; auto-import picks the file up from Downloads.'));
          }
          var name = lib.fileNameFor(res.headers['content-disposition'], url);
          if (!/\.[a-z0-9]{2,4}$/i.test(name)) name += /zip/i.test(type) ? '.zip' : /video\/quicktime/i.test(type) ? '.mov' : /video/i.test(type) ? '.mp4' : '';
          fs.mkdirSync(dir, { recursive: true });
          var target = uniquePath(dir, name), part = target + '.part';
          var total = Number(res.headers['content-length']) || 0, got = 0, done = false;
          var out = fs.createWriteStream(part);
          function fail(e) {
            if (done) return;
            done = true;
            try { out.destroy(); fs.unlinkSync(part); } catch (x) { /* already gone */ }
            reject(e);
          }
          res.on('data', function (chunk) { got += chunk.length; if (onProgress) onProgress(got, total); });
          res.on('error', fail);
          out.on('error', fail);
          out.on('finish', function () {
            if (done) return;
            done = true;
            if (total && got < total) { try { fs.unlinkSync(part); } catch (x) { /* ignore */ } return reject(new Error('The download stopped early.')); }
            fs.renameSync(part, target);
            resolve({ path: target, name: path.basename(target) });
          });
          res.pipe(out);
        });
        request.on('error', reject);
        request.setTimeout(60000, function () { request.destroy(new Error('The download timed out.')); });
      });
    }

    function extract(zipPath, destDir) {
      fs.mkdirSync(destDir, { recursive: true });
      return new Promise(function (resolve, reject) {
        var cmd, args;
        if (process.platform === 'win32') {
          var q = function (s) { return "'" + String(s).replace(/'/g, "''") + "'"; };
          cmd = 'powershell.exe';
          args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            'Expand-Archive -LiteralPath ' + q(zipPath) + ' -DestinationPath ' + q(destDir) + ' -Force'];
        } else if (process.platform === 'darwin') {
          cmd = 'ditto'; args = ['-x', '-k', zipPath, destDir];
        } else {
          cmd = 'unzip'; args = ['-o', '-q', zipPath, '-d', destDir];
        }
        cp.execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, function (err, stdout, stderr) {
          if (err) return reject(new Error('Could not unzip ' + path.basename(zipPath) + ': ' + (String(stderr).trim() || err.message)));
          resolve(destDir);
        });
      });
    }

    function findVideos(dir, out) {
      out = out || [];
      fs.readdirSync(dir).forEach(function (n) {
        if (n === '__MACOSX' || n.charAt(0) === '.') return;
        var p = path.join(dir, n), st = fs.statSync(p);
        if (st.isDirectory()) findVideos(p, out);
        else if (lib.VIDEO_EXT.test(n)) out.push(p);
      });
      return out.sort();
    }

    /** A downloaded file -> {pack, videos}. Zips are unpacked next to the zip. */
    function prepare(file) {
      var name = path.basename(file), pack = lib.packNameFor(name);
      if (lib.ARCHIVE_EXT.test(name)) {
        var dest = uniquePath(path.dirname(file), pack);
        return extract(file, dest).then(function () { return { pack: pack, videos: findVideos(dest) }; });
      }
      if (lib.VIDEO_EXT.test(name)) return Promise.resolve({ pack: pack, videos: [file] });
      if (/\.(rar|7z)$/i.test(name)) return Promise.reject(new Error(name + ': RAR/7z packs need to be extracted with 7-Zip or WinRAR first; then drop the folder\'s clips into Premiere.'));
      return Promise.reject(new Error(name + ' is not a video or .zip file.'));
    }

    /** Calls onReady(file) once for each new finished video/zip that lands in dir. */
    function watch(dir, onReady, onError) {
      if (!fs.existsSync(dir)) throw new Error('Folder not found: ' + dir);
      var seen = {}, pending = {};
      function check(full, lastSize, tries) {
        fs.stat(full, function (err, st) {
          if (err) { delete pending[full]; return; } // renamed away (still downloading)
          if (st.size > 0 && st.size === lastSize) { delete pending[full]; seen[full] = true; return onReady(full); }
          if (tries > 600) { delete pending[full]; return; }
          pending[full] = setTimeout(function () { check(full, st.size, tries + 1); }, 1500);
        });
      }
      var watcher = fs.watch(dir, function (evt, fname) {
        if (!fname) return;
        fname = String(fname);
        if (lib.PARTIAL_EXT.test(fname) || !(lib.VIDEO_EXT.test(fname) || lib.ARCHIVE_EXT.test(fname))) return;
        var full = path.join(dir, fname);
        if (seen[full] || pending[full]) return;
        pending[full] = setTimeout(function () { check(full, -1, 0); }, 800);
      });
      watcher.on('error', function (e) { if (onError) onError(e); });
      return { close: function () { watcher.close(); for (var k in pending) clearTimeout(pending[k]); } };
    }

    function readLocalFeed(extDir, kind) {
      return JSON.parse(fs.readFileSync(path.join(extDir, 'feeds', kind + '.json'), 'utf8'));
    }

    return {
      defaultDownloads: defaultDownloads,
      download: download,
      extract: extract,
      findVideos: findVideos,
      prepare: prepare,
      watch: watch,
      readLocalFeed: readLocalFeed,
      exists: function (p) { return fs.existsSync(p); }
    };
  }

  if (typeof window !== 'undefined') window.SuiteIO = { create: create };
  if (typeof module === 'object' && module && module.exports) module.exports = { create: create };
}(this));
