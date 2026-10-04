/* Edit Suite, Make pack: grouping faces into characters, cast lists, frame picking.
 * Pure functions (no DOM, no Premiere) so they run in the panel and in the tests. */
(function () {
  'use strict';

  var TPS = 254016000000;

  function dist(a, b) {
    var s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d * d; }
    return Math.sqrt(s);
  }

  function centroid(c) {
    var out = new Array(c.sum.length);
    for (var i = 0; i < out.length; i++) out[i] = c.sum[i] / c.count;
    return out;
  }

  function quality(f) { return (f.score || 0) * Math.sqrt((f.box ? f.box.width * f.box.height : 1)); }

  /**
   * Groups faces (each {id, shot, descriptor[128], score, box, thumb}) into characters.
   * threshold: max distance between a face and a character's average face (0.4 strict … 0.65 loose).
   * Returns characters sorted by number of shots: {key, faces, shots[], cover} with shots >= minShots;
   * plus `others` = faces that ended up in smaller groups.
   */
  function clusterFaces(faces, threshold, minShots) {
    threshold = threshold || 0.5;
    minShots = minShots || 2;
    var ordered = faces.slice().sort(function (a, b) { return quality(b) - quality(a) || (a.id < b.id ? -1 : 1); });
    var clusters = [], i, j;

    function nearest(desc, list) {
      var best = -1, bestD = Infinity;
      for (var k = 0; k < list.length; k++) {
        var d = dist(desc, list[k].center);
        if (d < bestD) { bestD = d; best = k; }
      }
      return { index: best, d: bestD };
    }
    function add(c, f) {
      for (var k = 0; k < c.sum.length; k++) c.sum[k] += f.descriptor[k];
      c.count++;
      c.center = centroid(c);
    }

    // 1. Greedy pass, best faces first so each group starts from a clear face.
    for (i = 0; i < ordered.length; i++) {
      var f = ordered[i], n = nearest(f.descriptor, clusters);
      if (n.index >= 0 && n.d < threshold) add(clusters[n.index], f);
      else { var c = { sum: f.descriptor.slice(), count: 1 }; c.center = centroid(c); clusters.push(c); }
    }
    // 2. Merge groups whose average faces are close.
    var merged = true;
    while (merged) {
      merged = false;
      for (i = 0; i < clusters.length && !merged; i++) {
        for (j = i + 1; j < clusters.length; j++) {
          if (dist(clusters[i].center, clusters[j].center) < threshold * 0.85) {
            for (var k = 0; k < clusters[i].sum.length; k++) clusters[i].sum[k] += clusters[j].sum[k];
            clusters[i].count += clusters[j].count;
            clusters[i].center = centroid(clusters[i]);
            clusters.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    // 3. Reassign every face to its nearest group (fixes order effects of step 1).
    clusters.forEach(function (cl) { cl.faces = []; });
    var loose = [];
    for (i = 0; i < ordered.length; i++) {
      var nn = nearest(ordered[i].descriptor, clusters);
      if (nn.index >= 0 && nn.d < threshold * 1.1) clusters[nn.index].faces.push(ordered[i]);
      else loose.push(ordered[i]);
    }

    var characters = [], others = loose;
    clusters.forEach(function (cl) {
      if (!cl.faces.length) return;
      var shots = {};
      cl.faces.forEach(function (x) { shots[x.shot] = true; });
      var shotList = Object.keys(shots).map(Number).sort(function (a, b) { return a - b; });
      if (shotList.length < minShots) { others = others.concat(cl.faces); return; }
      var cover = cl.faces.slice().sort(function (a, b) { return quality(b) - quality(a); })[0];
      characters.push({ key: cover.id, faces: cl.faces, shots: shotList, cover: cover });
    });
    characters.sort(function (a, b) { return b.shots.length - a.shots.length || b.faces.length - a.faces.length; });
    return { characters: characters, others: others };
  }

  /** Sequence ticks at which to grab frames inside a shot. */
  function frameTimes(startTicks, endTicks, perShot, frameTicks) {
    var s = Number(startTicks), e = Number(endTicks), frames = Math.round((e - s) / frameTicks);
    var n = frames < 6 ? 1 : Math.max(1, Math.min(3, perShot || 1));
    var fractions = n === 1 ? [0.5] : n === 2 ? [0.3, 0.7] : [0.2, 0.5, 0.8];
    return fractions.map(function (p) {
      var fr = Math.min(frames - 1, Math.max(0, Math.floor(frames * p)));
      return s + fr * frameTicks;
    });
  }

  /** Stable key for a cut list, so cached analysis is reused only for the same shots. */
  function shotsSignature(shots) {
    var h = 2166136261;
    shots.forEach(function (s) {
      var str = s.startTicks + '-' + s.endTicks + ';';
      for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    });
    return shots.length + '-' + h.toString(16);
  }

  // ------------------------------------------------------------------ cast

  var WD_API = 'https://www.wikidata.org/w/api.php';

  function wikidataSearchUrl(title) {
    return WD_API + '?action=wbsearchentities&format=json&origin=*&language=en&type=item&limit=10&search=' + encodeURIComponent(title);
  }

  /** Picks the film/series from a wbsearchentities reply; a year in the title narrows it. */
  function pickTitle(searchJson, wantedYear) {
    var hits = (searchJson && searchJson.search) || [];
    var screen = hits.filter(function (h) { return /\b(film|movie|series|miniseries|television|anime|sitcom|drama)\b/i.test(h.description || ''); });
    if (wantedYear) {
      var dated = screen.filter(function (h) { return String(h.description || '').indexOf(String(wantedYear)) >= 0; });
      if (dated.length) return dated[0];
    }
    return screen[0] || null;
  }

  function entityUrl(ids, props) {
    return WD_API + '?action=wbgetentities&format=json&origin=*&languages=en&props=' + (props || 'labels') + '&ids=' + ids.join('|');
  }

  /** Cast in billing order from a wbgetentities (claims) reply: [{actorId, roleIds[]}]. */
  function castFromEntity(json, id) {
    var ent = json && json.entities && json.entities[id];
    var claims = (ent && ent.claims && ent.claims.P161) || [];
    var out = [], seen = {};
    claims.forEach(function (c) {
      var v = c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
      if (!v || !v.id || seen[v.id]) return;
      seen[v.id] = true;
      var roles = ((c.qualifiers && c.qualifiers.P453) || []).map(function (q) {
        return q.datavalue && q.datavalue.value && q.datavalue.value.id;
      }).filter(Boolean);
      out.push({ actorId: v.id, roleIds: roles });
    });
    return out;
  }

  function labelsFrom(json) {
    var out = {};
    var ents = (json && json.entities) || {};
    Object.keys(ents).forEach(function (k) {
      var l = ents[k].labels && ents[k].labels.en;
      if (l) out[k] = l.value;
    });
    return out;
  }

  /** [{actorId, roleIds}] + labels -> [{character, actor}] */
  function namedCast(cast, labels) {
    return cast.map(function (c) {
      return {
        actor: labels[c.actorId] || '',
        character: c.roleIds.map(function (r) { return labels[r]; }).filter(Boolean).join(' / ')
      };
    }).filter(function (c) { return c.actor; });
  }

  /** "Rick Dalton - Leonardo DiCaprio", "Leonardo DiCaprio as Rick Dalton" or a bare name per line. */
  function castFromText(text) {
    return String(text || '').split(/\r?\n/).map(function (line) {
      line = line.replace(/^\s*[\d.)\-•*]+\s*/, '').trim();
      if (!line) return null;
      var m = /^(.+?)\s+as\s+(.+)$/i.exec(line);
      if (m) return { actor: m[1].trim(), character: m[2].trim() };
      m = /^(.+?)\s*(?:—|–|-|:|\|)\s*(.+)$/.exec(line);
      if (m) return { character: m[1].trim(), actor: m[2].trim() };
      return { character: line, actor: '' };
    }).filter(Boolean);
  }

  function castLabel(c) {
    return c.character && c.actor ? c.character + ' (' + c.actor + ')' : c.character || c.actor;
  }

  /**
   * Fills unnamed characters with cast names in billing order: the character with the most
   * shots gets the first-billed role. A guess by screen time, for the editor to check.
   */
  function suggestNames(characters, cast, names) {
    var used = {}, out = {};
    Object.keys(names || {}).forEach(function (k) { out[k] = names[k]; used[names[k]] = true; });
    var queue = cast.map(function (c) { return c.character || c.actor; }).filter(function (n) { return n && !used[n]; });
    characters.forEach(function (ch) {
      if (out[ch.key] || !queue.length) return;
      out[ch.key] = queue.shift();
    });
    return out;
  }

  function folderName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || 'Unnamed';
  }

  var api = {
    TPS: TPS,
    dist: dist,
    clusterFaces: clusterFaces,
    frameTimes: frameTimes,
    shotsSignature: shotsSignature,
    wikidataSearchUrl: wikidataSearchUrl,
    pickTitle: pickTitle,
    entityUrl: entityUrl,
    castFromEntity: castFromEntity,
    labelsFrom: labelsFrom,
    namedCast: namedCast,
    castFromText: castFromText,
    castLabel: castLabel,
    suggestNames: suggestNames,
    folderName: folderName
  };
  if (typeof window !== 'undefined') window.PackLib = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
}());
