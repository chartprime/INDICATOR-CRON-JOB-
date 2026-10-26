"use strict";

const fs = require("node:fs");

function fingerprint(dbPath) {
  const stat = fs.statSync(dbPath);
  return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
}

module.exports = { fingerprint };
