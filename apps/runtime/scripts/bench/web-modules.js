"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const WEB_ROOT = path.resolve(__dirname, "../../../web");
let registered = false;

function register() {
  if (registered) return;
  registered = true;
  const ts = require(path.join(WEB_ROOT, "node_modules/typescript"));
  Module._extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8").replace(
      /import (\w+) from "([^"]+\.json)";/g,
      (_, name, spec) => `const ${name} = require(${JSON.stringify(path.resolve(path.dirname(filename), spec))});`,
    );
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    module._compile(compiled, filename);
  };
}

function requireWeb(relativePath) {
  register();
  return require(path.join(WEB_ROOT, relativePath));
}

module.exports = { requireWeb, WEB_ROOT };
