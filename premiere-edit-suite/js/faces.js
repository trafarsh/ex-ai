/* Edit Suite, Make pack: face detection + face descriptors with face-api (runs on this computer). */
(function () {
  'use strict';

  var NETS = [
    ['ssdMobilenetv1', 'ssd_mobilenetv1_model'],
    ['faceLandmark68Net', 'face_landmark_68_model'],
    ['faceRecognitionNet', 'face_recognition_model']
  ];
  var MAX_SIDE = 960;   // frames are scaled down to this before detection
  var MIN_FACE = 40;    // px on the scaled frame; smaller faces are background extras
  var loaded = null;

  function fa() {
    if (!window.faceapi) throw new Error('Face models are missing from the panel (vendor/face-api).');
    return window.faceapi;
  }

  /** opts: {dir, fs, path} to read models from disk (Premiere), or {url} (browser);
   *  wasmPaths: {'tfjs-backend-wasm.wasm': url, 'tfjs-backend-wasm-simd.wasm': url}. */
  function load(opts) {
    if (loaded) return loaded;
    var api = fa();
    loaded = (async function () {
      // Graphics card first, then WebAssembly (several times faster than plain JS), then plain JS.
      if (opts.wasmPaths) { try { api.tf.setWasmPaths(opts.wasmPaths); } catch (e) { /* no wasm */ } }
      var backends = opts.backends || ['webgl', 'wasm', 'cpu'];
      for (var b = 0; b < backends.length; b++) {
        try {
          if (await api.tf.setBackend(backends[b])) { await api.tf.ready(); break; }
        } catch (e2) { /* try the next one */ }
      }
      for (var i = 0; i < NETS.length; i++) {
        var net = api.nets[NETS[i][0]], name = NETS[i][1];
        if (opts.fs) {
          var manifest = JSON.parse(opts.fs.readFileSync(opts.path.join(opts.dir, name + '-weights_manifest.json'), 'utf8'));
          var parts = [], specs = [], total = 0;
          manifest.forEach(function (group) {
            group.paths.forEach(function (p) { var b = opts.fs.readFileSync(opts.path.join(opts.dir, p)); parts.push(b); total += b.length; });
            specs = specs.concat(group.weights);
          });
          var bytes = new Uint8Array(total), at = 0;
          parts.forEach(function (b) { bytes.set(b, at); at += b.length; });
          await net.loadFromWeightMap(api.tf.io.decodeWeights(bytes.buffer, specs));
        } else {
          await net.loadFromUri(opts.url);
        }
      }
      return api.tf.getBackend();
    }());
    loaded.catch(function () { loaded = null; });
    return loaded;
  }

  /** Draws an image Blob onto a canvas no bigger than MAX_SIDE. */
  async function canvasFromBlob(blob) {
    var bmp = await createImageBitmap(blob);
    var scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    var c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c;
  }

  /** Faces in a canvas: [{score, box:{x,y,width,height}, descriptor:number[128]}]. */
  async function detect(canvas) {
    var api = fa();
    var found = await api.detectAllFaces(canvas, new api.SsdMobilenetv1Options({ minConfidence: 0.55, maxResults: 12 }))
      .withFaceLandmarks().withFaceDescriptors();
    return found.filter(function (r) { return r.detection.box.width >= MIN_FACE && r.detection.box.height >= MIN_FACE; })
      .map(function (r) {
        var b = r.detection.box;
        return {
          score: Math.round(r.detection.score * 1000) / 1000,
          box: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
          descriptor: Array.prototype.map.call(r.descriptor, function (v) { return Math.round(v * 10000) / 10000; })
        };
      });
  }

  /** A square face crop as a JPEG data URL. */
  function thumb(canvas, box, size) {
    size = size || 112;
    var side = Math.max(box.width, box.height) * 1.5;
    var cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    var c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.85);
  }

  /** A small preview of the whole frame as a JPEG data URL. */
  function preview(canvas, width) {
    width = width || 200;
    var c = document.createElement('canvas');
    c.width = width;
    c.height = Math.round(canvas.height * width / canvas.width);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }

  window.Faces = { load: load, canvasFromBlob: canvasFromBlob, detect: detect, thumb: thumb, preview: preview };
}());
