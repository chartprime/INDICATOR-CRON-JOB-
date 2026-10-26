"use strict";

// Loads browser modules (apps/web/src/...) into Node, transpiled on the fly,
// so runtime tests can check that the runtime and the browser agree: the
// frame parser (what the runtime emits is what the browser accepts) and the
// market calendar (both sides put the same minutes on the chart). Same
// approach as the density benchmark's preflight. JSON default imports are
// rewritten to require() of the same governed config file.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const WEB_ROOT = path.resolve(__dirname, "../../../web");

const cached = new Map();

function loadWebModule(relativePath) {
  if (cached.has(relativePath)) return cached.get(relativePath);
  const ts = require(path.join(WEB_ROOT, "node_modules/typescript"));
  const file = path.join(WEB_ROOT, relativePath);
  const source = fs.readFileSync(file, "utf8").replace(
    /import (\w+) from "([^"]+\.json)";/g,
    (_, name, spec) => `const ${name} = require(${JSON.stringify(path.resolve(path.dirname(file), spec))});`,
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = new Module(file);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(compiled, file);
  cached.set(relativePath, loaded.exports);
  return loaded.exports;
}

function loadBrowserFrames() {
  return loadWebModule("src/types/frames.ts");
}

module.exports = { loadBrowserFrames, loadWebModule };
