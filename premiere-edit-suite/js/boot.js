/* Edit Suite: finds the extension folder and loads the extra ExtendScript files. */
(function () {
  'use strict';
  var cep = window.__adobe_cep__;
  if (!cep) return;
  var p = decodeURI(cep.getSystemPath('extension'));
  p = /^file:\/\/\/[A-Za-z]:/.test(p) ? p.replace('file:///', '') : p.replace(/^file:\/\//, '');
  window.SUITE_EXT_PATH = p;
  // tiktokEditor.jsx is the manifest's ScriptPath; these two are loaded next to it.
  // evalScript calls run in order, so they are ready before any tab calls them.
  ['shotExporter.jsx', 'scenepacks.jsx'].forEach(function (f) {
    cep.evalScript('$.evalFile(' + JSON.stringify(p + '/jsx/' + f) + ')', function () {});
  });
}());
