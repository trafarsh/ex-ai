/*
 * Edit Suite: imports downloaded scenepack clips into the project, in a
 * "Scenepacks/<pack name>" bin. Downloading and unzipping happen in the panel (Node).
 */
var SuiteImport = (function () {
    function findBin(parent, name) {
        for (var i = 0; i < parent.children.numItems; i++) {
            var c = parent.children[i];
            if (c.type === 2 && c.name === name) return c; // 2 = BIN
        }
        return parent.createBin(name);
    }

    return {
        importFiles: function (json) {
            try {
                var args = eval('(' + json + ')');
                if (!app.project) return '{"ok":false,"error":"No project is open."}';
                var bin = findBin(app.project.rootItem, 'Scenepacks');
                if (args.pack) bin = findBin(bin, String(args.pack));
                var paths = [];
                for (var i = 0; i < args.paths.length; i++) if (new File(args.paths[i]).exists) paths.push(new File(args.paths[i]).fsName);
                if (!paths.length) return '{"ok":false,"error":"None of the files exist."}';
                var before = bin.children.numItems;
                app.project.importFiles(paths, true, bin, false);
                return '{"ok":true,"data":{"imported":' + (bin.children.numItems - before) + ',"of":' + paths.length + '}}';
            } catch (e) {
                return '{"ok":false,"error":' + ('"' + String(e.message || e).replace(/[\\"]/g, ' ') + '"') + '}';
            }
        }
    };
}());
