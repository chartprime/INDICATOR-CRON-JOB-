"use strict";

const { MAX_LIQUIDITY_ROWS } = require("../../server/frames");

const MAX_WINDOW_ROWS = Math.floor((MAX_LIQUIDITY_ROWS - 1) / 2);

function rowClustersFor(price, clusterWidth, rowBp) {
  if (!(price > 0) || !(clusterWidth > 0)) return 1;
  return Math.max(1, Math.round((price * rowBp) / 10_000 / clusterWidth));
}

function windowRowsFor(price, rowWidth, windowBp) {
  if (!(price > 0) || !(rowWidth > 0)) return MAX_WINDOW_ROWS;
  return Math.min(MAX_WINDOW_ROWS, Math.max(1, Math.round((price * windowBp) / 10_000 / rowWidth)));
}

function laneZeroGeometry({ price, clusterWidth, fixedRows = null, rowBp, windowBp, referenceBp }) {
  const rowClusters = Number.isSafeInteger(fixedRows) && fixedRows > 0 ? fixedRows : rowClustersFor(price, clusterWidth, rowBp);
  const rowWidth = clusterWidth * rowClusters;
  return {
    rowClusters,
    rowWidth,
    windowRows: windowRowsFor(price, rowWidth, windowBp),
    referenceRows: windowRowsFor(price, rowWidth, referenceBp),
  };
}

module.exports = { rowClustersFor, windowRowsFor, laneZeroGeometry, MAX_WINDOW_ROWS };
