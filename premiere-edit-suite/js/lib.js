/* Edit Suite: pure helpers shared by the panel and the tests (no Premiere, no DOM). */
(function (root) {
  'use strict';

  var FEED_BASES = [
    'https://raw.githubusercontent.com/trafarsh/ex-ai/HEAD/premiere-edit-suite/feeds/',
    'https://raw.githubusercontent.com/trafarsh/ex-ai/claude/lucid-johnson-1a3z0s/premiere-edit-suite/feeds/'
  ];
  var FEED_MAX_AGE_MS = 6 * 60 * 60 * 1000;

  var VIDEO_EXT = /\.(mp4|mov|m4v|mkv|avi|mxf|webm|mpg|mpeg|wmv)$/i;
  var ARCHIVE_EXT = /\.zip$/i;
  var PARTIAL_EXT = /\.(crdownload|part|partial|download|tmp)$/i;

  /** Turns share links into direct-download links where the host allows it. */
  function directDownloadUrl(raw) {
    var url = String(raw || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('Paste a full link starting with http:// or https://');
    var m;
    if ((m = /drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([\w-]{10,})/i.exec(url))) {
      return 'https://drive.usercontent.google.com/download?id=' + m[1] + '&export=download&confirm=t';
    }
    if (/^https?:\/\/(www\.)?dropbox\.com\//i.test(url)) {
      if (/[?&]dl=\d/.test(url)) return url.replace(/([?&])dl=\d/, '$1dl=1');
      return url + (url.indexOf('?') < 0 ? '?' : '&') + 'dl=1';
    }
    if (/^https?:\/\/(www\.)?mega\.(nz|io)\//i.test(url)) {
      throw new Error('MEGA links are encrypted and can only be downloaded in the browser. Download it there; auto-import will pick it up.');
    }
    return url;
  }

  function safeFileName(name) {
    var s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
    return s.slice(0, 180) || 'scenepack';
  }

  /** File name from a Content-Disposition header, or from the URL path. */
  function fileNameFor(disposition, url) {
    var d = String(disposition || ''), m;
    if ((m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(d))) {
      try { return safeFileName(decodeURIComponent(m[1].replace(/"/g, ''))); } catch (e) { /* fall through */ }
    }
    if ((m = /filename\s*=\s*"([^"]+)"/.exec(d)) || (m = /filename\s*=\s*([^;]+)/.exec(d))) return safeFileName(m[1].trim());
    var path = String(url || '').split(/[?#]/)[0].split('/').pop();
    try { path = decodeURIComponent(path); } catch (e2) { /* keep raw */ }
    return safeFileName(path || 'scenepack');
  }

  function packNameFor(fileName) {
    return safeFileName(String(fileName).replace(/\.[^.]+$/, '').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' '));
  }

  /** BPM from tap times in ms; ignores a pause of more than 2 s (starts a new run). */
  function tapTempo(times) {
    var run = [];
    for (var i = 0; i < times.length; i++) {
      if (run.length && times[i] - run[run.length - 1] > 2000) run = [];
      run.push(times[i]);
    }
    if (run.length < 3) return null;
    run = run.slice(-12);
    var bpm = 60000 * (run.length - 1) / (run[run.length - 1] - run[0]);
    return Math.round(bpm * 10) / 10;
  }

  /** Checks a feed and keeps only well-formed entries. */
  function validateFeed(kind, data) {
    if (!data || typeof data !== 'object') throw new Error('not JSON');
    var key = kind === 'looks' ? 'looks' : kind === 'trending' ? 'songs' : 'sites';
    if (!Array.isArray(data[key])) throw new Error('missing "' + key + '" list');
    var items = data[key].filter(function (x) {
      if (!x || typeof x !== 'object' || !x.name && !x.title) return false;
      if (kind === 'looks') return x.lumetri && typeof x.lumetri === 'object' && Object.keys(x.lumetri).every(function (k) { return isFinite(Number(x.lumetri[k])); });
      if (kind === 'trending') return Number(x.bpm) >= 30 && Number(x.bpm) <= 300;
      return /^https?:\/\//.test(x.home || '') && /\{q\}/.test(x.search || '');
    });
    var out = { updated: String(data.updated || ''), items: items };
    return out;
  }

  function feedUrls(kind, customBase) {
    var bases = customBase ? [customBase.replace(/\/?$/, '/')].concat(FEED_BASES) : FEED_BASES;
    return bases.map(function (b) { return b + kind + '.json'; });
  }

  function searchUrl(site, query) {
    return site.search.replace(/\{q\}/g, encodeURIComponent(String(query || '').trim()).replace(/%20/g, '+'));
  }

  var api = {
    FEED_MAX_AGE_MS: FEED_MAX_AGE_MS,
    VIDEO_EXT: VIDEO_EXT,
    ARCHIVE_EXT: ARCHIVE_EXT,
    PARTIAL_EXT: PARTIAL_EXT,
    directDownloadUrl: directDownloadUrl,
    fileNameFor: fileNameFor,
    packNameFor: packNameFor,
    safeFileName: safeFileName,
    tapTempo: tapTempo,
    validateFeed: validateFeed,
    feedUrls: feedUrls,
    searchUrl: searchUrl
  };
  if (typeof window !== 'undefined') window.SuiteLib = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}(this));
