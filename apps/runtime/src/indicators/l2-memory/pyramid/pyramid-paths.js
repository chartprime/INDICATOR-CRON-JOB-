"use strict";

const path = require("node:path");
const { dataRoot } = require("../../../platform/runtime-paths");

function defaultHeatmapDir() {
  return path.join(dataRoot(), "heatmap");
}

module.exports = { defaultHeatmapDir };
